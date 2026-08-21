import {describe, expect, it, vi} from 'vitest'

import {attachLifecycleTelemetry} from '../../src/core/telemetry-controller'
import {createCustomLifecycle} from '../../src/public/custom'

function lifecycle(
	overrides: Parameters<typeof createCustomLifecycle>[0] = {clock: {now: Date.now}}
) {
	const clock = overrides.clock ?? {now: Date.now}
	return createCustomLifecycle({
		startup: {initTimeoutMs: 100, warmTimeoutMs: 100},
		shutdown: {
			timeoutMs: 100,
			hookTimeoutMs: 30,
			flushTimeoutMs: 30,
			drainGracePeriodMs: 0,
			groups: ['first', 'second']
		},
		health: {intervalMs: 0, checkTimeoutMs: 30, runTimeoutMs: 50, concurrency: 2},
		...overrides,
		clock,
		monotonicClock: overrides.monotonicClock ?? clock
	})
}

describe('managed lifecycle runtime', () => {
	it('runs startup stages once and treats optional warm failures as degradation', async() => {
		const runtime = lifecycle()
		const calls: string[] = []
		runtime.registerStartupHook('init', () => { calls.push('init') })
		runtime.registerStartupHook('warm', () => { calls.push('warm'); throw new Error('optional') })
		runtime.registerStartupHook('ready', () => { calls.push('ready') })

		await Promise.all([runtime.start(), runtime.start()])
		await runtime.start()

		expect(calls).toEqual(['init', 'warm', 'ready'])
		expect(runtime.getStatus()).toMatchObject({state: 'running', health: 'degraded'})
		expect(() => runtime.registerFlushHook('late', async() => {})).toThrow('registration is closed')
	})

	it('applies startup timeouts to the whole stage and keeps long optional names non-fatal', async() => {
		vi.useFakeTimers()
		const runtime = lifecycle({
			clock: {now: Date.now},
			startup: {initTimeoutMs: 10, warmTimeoutMs: 10}
		})
		runtime.registerStartupHook('warm', () => {
			throw new Error('optional')
		}, {name: 'x'.repeat(128)})
		runtime.registerStartupHook('init', async() => {
			await new Promise<void>((resolve) => setTimeout(resolve, 6))
		}, {concurrent: false})
		runtime.registerStartupHook('init', async() => {
			await new Promise<void>((resolve) => setTimeout(resolve, 6))
		}, {concurrent: false})

		const starting = runtime.start()
		const startupFailure = expect(starting).rejects.toThrow('Lifecycle startup failed')
		await vi.advanceTimersByTimeAsync(20)
		await startupFailure
		expect(runtime.getStatus().state).toBe('closed')
		vi.useRealTimers()

		const optional = lifecycle()
		optional.registerStartupHook('warm', () => { throw new Error('optional') }, {name: 'x'.repeat(128)})
		await expect(optional.start()).resolves.toBeUndefined()
		expect(optional.getStatus()).toMatchObject({state: 'running', health: 'degraded'})
		await optional.shutdown()
	})

	it('stops a timed-out shutdown attempt before finalization and permits a clean retry', async() => {
		vi.useFakeTimers()
		let calls = 0
		let release!: () => void
		const blocked = new Promise<void>((resolve) => { release = resolve })
		const runtime = lifecycle({
			clock: {now: Date.now},
			shutdown: {
				timeoutMs: 10,
				hookTimeoutMs: 50,
				flushTimeoutMs: 50,
				drainGracePeriodMs: 0,
				groups: ['first', 'second']
			},
			health: {intervalMs: 1, checkTimeoutMs: 1_000, runTimeoutMs: 1_000, concurrency: 1}
		})
		runtime.registerHealthCheck({
			name: 'database',
			criticality: 'required',
			check: () => ++calls === 1 ? {healthy: true} : blocked.then(() => ({healthy: true}))
		})
		await runtime.start()
		await vi.advanceTimersByTimeAsync(1)
		const firstShutdown = runtime.shutdown()
		const shutdownFailure = expect(firstShutdown).rejects.toThrow('timed out')
		await vi.advanceTimersByTimeAsync(10)
		await shutdownFailure
		expect(runtime.getStatus().state).toBe('draining')

		release()
		await vi.runAllTicks()
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		expect(runtime.getStatus().state).toBe('closed')
		vi.useRealTimers()
	})

	it('makes readiness fail immediately on drain without running shutdown hooks', async() => {
		const runtime = lifecycle()
		const shutdown = vi.fn()
		runtime.registerShutdownHook('first', shutdown)
		await runtime.start()

		await runtime.beginDrain('upgrade')

		expect(runtime.getStatus().state).toBe('draining')
		expect(() => runtime.recordDegradation('late-critical', 'critical')).not.toThrow()
		expect(runtime.getStatus().health).toBe('unhealthy')
		expect(() => runtime.clearDegradation('late-critical')).not.toThrow()
		expect(runtime.getReadinessStatus().code).toBe(503)
		expect(runtime.getLivenessStatus().code).toBe(200)
		expect(shutdown).not.toHaveBeenCalled()
		await runtime.shutdown('upgrade')
		expect(shutdown).toHaveBeenCalledOnce()
		expect(runtime.getLivenessStatus().code).toBe(500)
	})

	it('flushes registered work without beginning drain', async() => {
		const runtime = lifecycle()
		const flush = vi.fn()
		runtime.registerFlushHook('telemetry', flush)
		await runtime.start()

		await runtime.flush()

		expect(flush).toHaveBeenCalledOnce()
		expect(runtime.getStatus().state).toBe('running')
		expect(runtime.getReadinessStatus().code).toBe(200)
		await runtime.shutdown()
	})

	it('preserves startup barriers while parallelizing independent groups', async() => {
		const runtime = lifecycle()
		const events: string[] = []
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		runtime.registerStartupHook('warm', async() => {
			events.push('database-1:start')
			await gate
			events.push('database-1:end')
		}, {group: 'database'})
		runtime.registerStartupHook('warm', () => { events.push('database-2') }, {group: 'database'})
		runtime.registerStartupHook('warm', () => {
			events.push('cache')
			release()
		}, {group: 'cache'})
		runtime.registerStartupHook('warm', () => { events.push('barrier') }, {concurrent: false})

		await runtime.start()

		expect(events.slice(0, 2)).toEqual(['database-1:start', 'cache'])
		expect(events.indexOf('database-2')).toBeGreaterThan(events.indexOf('database-1:end'))
		expect(events.indexOf('barrier')).toBeGreaterThan(events.indexOf('database-2'))
	})

	it('runs groups and priority tiers in order while parallelizing equal priorities', async() => {
		const runtime = lifecycle()
		const events: string[] = []
		let release!: () => void
		const barrier = new Promise<void>((resolve) => { release = resolve })
		runtime.registerShutdownHook('first', async() => { events.push('a:start'); await barrier; events.push('a:end') }, {priority: 1})
		runtime.registerShutdownHook('first', async() => { events.push('b:start'); release(); events.push('b:end') }, {priority: 1})
		runtime.registerShutdownHook('first', () => { events.push('c') }, {priority: 2})
		runtime.registerShutdownHook('second', () => { events.push('d') }, {priority: 0})
		await runtime.start()

		await runtime.shutdown()

		expect(events.slice(0, 2)).toEqual(['a:start', 'b:start'])
		expect(events.indexOf('c')).toBeGreaterThan(events.indexOf('a:end'))
		expect(events.indexOf('d')).toBeGreaterThan(events.indexOf('c'))
	})

	it('keeps concurrent shutdown calls single-flight through finalization and telemetry', async() => {
		const shutdownResults: string[] = []
		const metrics = {increment: vi.fn(), record: vi.fn()}
		const runtime = lifecycle({
			clock: {now: Date.now},
			observability: {metrics: metrics as never}
		})
		runtime.registerShutdownHook('first', async() => {
			await Promise.resolve()
			shutdownResults.push('hook')
		})
		await runtime.start()

		await Promise.all([runtime.shutdown(), runtime.shutdown(), runtime.shutdown()])

		expect(shutdownResults).toEqual(['hook'])
		expect(metrics.increment).toHaveBeenCalledWith('_lifecycle_shutdowns_total', {result: 'success'})
		expect(metrics.increment.mock.calls.filter(([name]) => name === '_lifecycle_shutdowns_total')).toHaveLength(1)
	})

	it('retries only the failed shutdown tier and never resolves falsely after failure', async() => {
		const runtime = lifecycle()
		const completed = vi.fn()
		let attempts = 0
		runtime.registerShutdownHook('first', completed, {priority: 1})
		runtime.registerShutdownHook('first', () => {
			attempts++
			if (attempts === 1) throw new Error('first attempt')
		}, {priority: 2})
		runtime.registerShutdownHook('second', completed)
		await runtime.start()

		await expect(runtime.shutdown()).rejects.toThrow('Lifecycle shutdown failed')
		expect(runtime.getStatus()).toMatchObject({state: 'draining', health: 'unhealthy'})
		await expect(runtime.shutdown()).resolves.toBeUndefined()

		expect(attempts).toBe(2)
		expect(completed).toHaveBeenCalledTimes(2)
		expect(runtime.getStatus()).toMatchObject({state: 'closed', health: 'closed'})
	})

	it('reports the actual shutdown-hook cause once with bounded hook context', async() => {
		const report = vi.fn()
		const cause = Object.assign(new Error('postgres client close failed'), {code: '57P01'})
		const runtime = lifecycle({
			clock: {now: Date.now},
			observability: {errors: {report} as never}
		})
		runtime.registerShutdownHook('first', () => { throw cause }, {
			name: 'database.close',
			priority: 7
		})
		await runtime.start()

		const shutdownError = await runtime.shutdown('signal').catch((error: unknown) => error) as Error

		expect(shutdownError.message).toBe('Lifecycle shutdown failed')
		expect((shutdownError.cause as Error).cause).toBe(cause)
		expect(report).toHaveBeenCalledOnce()
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'postgres client close failed',
				code: '57P01'
			}),
			{
				source: 'lifecycle',
				code: 'LIFECYCLE_HOOK_FAILURE',
				stage: 'shutdown',
				hookName: 'database.close',
				hookGroup: 'first',
				hookPriority: '7',
				shutdownReason: 'signal'
			}
		)
		expect(JSON.stringify(report.mock.calls)).not.toContain('Lifecycle shutdown failed')
	})

	it('reports the actual terminal flush cause once without a shutdown summary alert', async() => {
		const report = vi.fn()
		const runtime = lifecycle({
			clock: {now: Date.now},
			observability: {errors: {report} as never}
		})
		runtime.registerFlushHook('telemetry.flush', () => {
			throw new Error('sentry transport unavailable')
		})
		await runtime.start()

		await expect(runtime.shutdown('manual')).rejects.toThrow('Lifecycle shutdown failed')

		expect(report).toHaveBeenCalledOnce()
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({message: 'sentry transport unavailable'}),
			expect.objectContaining({
				code: 'LIFECYCLE_HOOK_FAILURE',
				stage: 'flush',
				hookName: 'telemetry.flush',
				terminal: 'true'
			})
		)
	})

	it('does not start timed-out physical work a second time', async() => {
		let resolve!: () => void
		const physical = new Promise<void>((done) => { resolve = done })
		const hook = vi.fn(() => physical)
		const runtime = lifecycle({
			clock: {now: Date.now},
			shutdown: {
				timeoutMs: 20,
				hookTimeoutMs: 5,
				flushTimeoutMs: 5,
				drainGracePeriodMs: 0,
				groups: ['first', 'second']
			}
		})
		runtime.registerShutdownHook('first', hook)
		await runtime.start()

		await expect(runtime.shutdown()).rejects.toThrow()
		await expect(runtime.shutdown()).rejects.toThrow()
		expect(hook).toHaveBeenCalledOnce()
		resolve()
		await physical
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		expect(hook).toHaveBeenCalledOnce()
	})

	it('returns deeply frozen, non-throwing status and probe snapshots', async() => {
		let clockAvailable = true
		const runtime = lifecycle({
			clock: {now: () => {
				if (!clockAvailable) throw new Error('clock failed')
				return 42
			}},
			resource: {serviceName: 'api', attributes: {region: 'eu'}}
		})
		await runtime.start()
		clockAvailable = false
		const status = runtime.getStatus()
		const health = runtime.getHealthSnapshot()
		const readiness = runtime.getReadinessStatus()
		expect(() => runtime.getLivenessStatus()).not.toThrow()
		expect(Object.isFrozen(status)).toBe(true)
		expect(Object.isFrozen(health)).toBe(true)
		expect(Object.isFrozen(health.checks)).toBe(true)
		expect(Object.isFrozen(readiness)).toBe(true)
		expect(Object.isFrozen(readiness.resource)).toBe(true)
		expect(Object.isFrozen(readiness.resource?.attributes)).toBe(true)
	})

	it('emits only the seven bounded lifecycle self-metrics', async() => {
		const names: string[] = []
		const metrics = {
			increment: vi.fn((name: string) => { names.push(name) }),
			record: vi.fn((name: string) => { names.push(name) })
		}
		const runtime = lifecycle({
			clock: {now: Date.now},
			observability: {metrics: metrics as never},
			health: {intervalMs: 0, checkTimeoutMs: 30, runTimeoutMs: 50, concurrency: 2}
		})
		let shutdownAttempts = 0
		runtime.registerHealthCheck({
			name: 'optional-storage', criticality: 'optional',
			check: () => ({healthy: false, code: 'STORAGE_OFFLINE'})
		})
		runtime.registerShutdownHook('first', () => {
			shutdownAttempts++
			if (shutdownAttempts === 1) throw new Error('offline')
		})
		runtime.recordDegradation('manual-warning', 'warning')

		await runtime.start()
		await expect(runtime.shutdown()).rejects.toThrow()
		await runtime.shutdown()

		expect(new Set(names)).toEqual(new Set([
			'_lifecycle_startups_total',
			'_lifecycle_startup_duration_ms',
			'_lifecycle_shutdowns_total',
			'_lifecycle_shutdown_duration_ms',
			'_lifecycle_hook_failures_total',
			'_lifecycle_health_check_failures_total',
			'_lifecycle_degradations_total'
		]))
	})

	it('keeps telemetry attachment atomic when a later port conflicts', async() => {
		const logger = {
			level: 'info', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
			context() { return this }
		}
		const conflictingLogger = {...logger}
		const errors = {report: vi.fn()}
		const runtime = lifecycle({clock: {now: Date.now}, observability: {logger: logger as never}})

		expect(() => attachLifecycleTelemetry(runtime, {
			errors: errors as never,
			logger: conflictingLogger as never
		})).toThrow('logger is already attached')
		const detach = attachLifecycleTelemetry(runtime, {errors: errors as never})
		expect(detach).toBeTypeOf('function')

		detach?.()
		await runtime.shutdown()
	})
})
