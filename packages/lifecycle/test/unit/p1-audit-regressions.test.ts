import type {Container} from '@ooopsstudio/core/runtime'
import {describe, expect, it, vi} from 'vitest'

import {registerLifecycle} from '../../src'
import {createCustomLifecycle} from '../../src/public/custom'
import {attachNodeLifecycle} from '../../src/public/node'

const options = {
	clock: {now: Date.now},
	shutdown: {
		timeoutMs: 100,
		hookTimeoutMs: 30,
		flushTimeoutMs: 30,
		drainGracePeriodMs: 0
	}
} as const

describe('lifecycle P1 audit regressions', () => {
	it('preserves startup hook bounds during re-entrant option inspection', async() => {
		const runtime = createCustomLifecycle(options)
		let registered = false
		const hostile = new Proxy({}, {
			ownKeys() {
				if (!registered) {
					registered = true
					for (let index = 0; index < 256; index++) {
						runtime.registerStartupHook('init', () => undefined)
					}
				}
				return []
			}
		})

		expect(() => runtime.registerStartupHook('init', () => undefined, hostile))
			.toThrow('hook limit exceeded')
		await runtime.shutdown()
	})

	it('preserves shutdown hook bounds during re-entrant option inspection', async() => {
		const runtime = createCustomLifecycle(options)
		let registered = false
		const hostile = new Proxy({}, {
			ownKeys() {
				if (!registered) {
					registered = true
					for (let index = 0; index < 256; index++) {
						runtime.registerShutdownHook('http-server', () => undefined)
					}
				}
				return []
			}
		})

		expect(() => runtime.registerShutdownHook('http-server', () => undefined, hostile))
			.toThrow('hook limit exceeded')
		await runtime.shutdown()
	})

	it('preserves health check bounds during re-entrant definition inspection', async() => {
		const runtime = createCustomLifecycle(options)
		let registered = false
		const hostile = new Proxy({
			name: 'outer-check',
			criticality: 'optional',
			check: () => ({healthy: true})
		}, {
			ownKeys() {
				if (!registered) {
					registered = true
					for (let index = 0; index < 128; index++) {
						runtime.registerHealthCheck({
							name: `check-${index}`,
							criticality: 'optional',
							check: () => ({healthy: true})
						})
					}
				}
				return ['name', 'criticality', 'check']
			},
			getOwnPropertyDescriptor(target, key) {
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		expect(() => runtime.registerHealthCheck(hostile as never))
			.toThrow('check limit exceeded')
		await runtime.shutdown()
	})

	it('owns flush before a hook can synchronously re-enter it', async() => {
		const runtime = createCustomLifecycle(options)
		const reentrant: Promise<void>[] = []
		const hook = vi.fn(() => {
			reentrant.push(runtime.flush())
		})
		runtime.registerFlushHook('telemetry', hook)
		await runtime.start()

		await runtime.flush()
		await Promise.all(reentrant)

		expect(hook).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('reuses timed-out physical flush work instead of overlapping retries', async() => {
		let release!: () => void
		const physical = new Promise<void>((resolve) => { release = resolve })
		const hook = vi.fn(() => physical)
		const runtime = createCustomLifecycle({
			...options,
			shutdown: {...options.shutdown, flushTimeoutMs: 5}
		})
		runtime.registerFlushHook('telemetry', hook)
		await runtime.start()

		await expect(runtime.flush()).rejects.toThrow('Lifecycle flush failed')
		const retry = runtime.flush()
		expect(hook).toHaveBeenCalledOnce()
		release()
		await expect(retry).resolves.toBeUndefined()
		expect(hook).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('does not expose mutable shutdown entry state as the hook receiver', async() => {
		const runtime = createCustomLifecycle(options)
		let attempts = 0
		runtime.registerShutdownHook('http-server', function(this: {done?: boolean} | undefined) {
			attempts++
			if (this) this.done = true
			if (attempts === 1) throw new Error('retry required')
		})
		await runtime.start()

		await expect(runtime.shutdown()).rejects.toThrow('Lifecycle shutdown failed')
		await expect(runtime.shutdown()).resolves.toBeUndefined()

		expect(attempts).toBe(2)
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('bounds hostile cyclic container prototype traversal', async() => {
		let prototypeReads = 0
		let cyclic!: Container
		cyclic = new Proxy({} as Container, {
			getPrototypeOf() {
				prototypeReads++
				if (prototypeReads > 40) throw new Error('unbounded container traversal')
				return cyclic
			}
		})

		await expect(registerLifecycle(cyclic, {preset: 'development'}))
			.rejects.toThrow('reversible container')
		expect(prototypeReads).toBeLessThanOrEqual(32)
	})

	it('does not execute caller-controlled shutdown group array methods', async() => {
		const map = vi.fn(() => ['attacker-controlled'])
		const groups = Object.assign(['db'], {map})
		const runtime = createCustomLifecycle({
			...options,
			shutdown: {...options.shutdown, groups}
		})

		expect(map).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('contains hostile values thrown by configuration descriptor traps', () => {
		let prototypeReads = 0
		let rejection!: object
		rejection = new Proxy({}, {
			getPrototypeOf() {
				prototypeReads++
				if (prototypeReads > 2) throw new Error('unbounded rejection traversal')
				return rejection
			}
		})
		const hostile = new Proxy({}, {ownKeys: () => { throw rejection }})

		expect(() => createCustomLifecycle(hostile as never)).toThrow('stable data fields')
		expect(prototypeReads).toBe(0)
	})

	it('does not read poisoned bind properties from clocks or health checks', async() => {
		const bind = vi.fn(() => { throw new Error('poisoned bind') })
		const now = Object.defineProperty(() => 100, 'bind', {get: bind})
		const check = Object.defineProperty(
			() => ({healthy: true} as const),
			'bind',
			{get: bind}
		)
		const runtime = createCustomLifecycle({
			...options,
			clock: {now},
			monotonicClock: {now}
		})
		runtime.registerHealthCheck({name: 'database', criticality: 'required', check})

		await runtime.start()
		await runtime.shutdown()
		expect(bind).not.toHaveBeenCalled()
	})

	it('finalizes shutdown when captured clocks fail after startup', async() => {
		let available = true
		const clock = {now: () => {
			if (!available) throw new Error('clock unavailable')
			return 100
		}}
		const runtime = createCustomLifecycle({
			...options,
			clock,
			monotonicClock: clock
		})
		const shutdownHook = vi.fn()
		runtime.registerShutdownHook('http-server', shutdownHook)
		await runtime.start()
		available = false

		await expect(runtime.shutdown()).resolves.toBeUndefined()
		expect(shutdownHook).toHaveBeenCalledOnce()
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('keeps required critical failures latched until a successful check', async() => {
		vi.useFakeTimers()
		try {
			let attempt = 0
			const runtime = createCustomLifecycle({
				...options,
				health: {intervalMs: 10, checkTimeoutMs: 50, runTimeoutMs: 50, concurrency: 1}
			})
			runtime.registerHealthCheck({
				name: 'database',
				criticality: 'required',
				check: () => ++attempt === 1
					? {healthy: false, critical: true}
					: attempt === 2 ? {healthy: false} : {healthy: true}
			})
			await runtime.start()
			expect(runtime.getReadinessStatus().code).toBe(503)

			await vi.advanceTimersByTimeAsync(10)
			expect(runtime.getStatus().health).toBe('unhealthy')
			expect(runtime.getReadinessStatus().code).toBe(503)

			await vi.advanceTimersByTimeAsync(10)
			expect(runtime.getStatus().health).toBe('healthy')
			await runtime.shutdown()
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not close while timed-out physical health work is still active', async() => {
		let release!: () => void
		const physical = new Promise<void>((resolve) => { release = resolve })
		const runtime = createCustomLifecycle({
			...options,
			shutdown: {...options.shutdown, timeoutMs: 50},
			health: {intervalMs: 0, checkTimeoutMs: 5, runTimeoutMs: 10, concurrency: 1}
		})
		const unregister = runtime.registerHealthCheck({
			name: 'database',
			criticality: 'required',
			check: async() => {
				await physical
				return {healthy: true}
			}
		})
		await runtime.start()
		unregister()

		await expect(runtime.shutdown()).rejects.toThrow('Lifecycle shutdown failed')
		expect(runtime.getStatus().state).toBe('draining')
		release()
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('reserves Node ownership before hostile option inspection can re-enter', () => {
		const first = createCustomLifecycle(options)
		const second = createCustomLifecycle(options)
		let nestedError: unknown
		const hostile = new Proxy({}, {
			ownKeys() {
				try { attachNodeLifecycle(second, {signals: []}) } catch(error) { nestedError = error }
				return []
			}
		})

		const dispose = attachNodeLifecycle(first, hostile)
		try {
			expect(nestedError).toMatchObject({message: 'LIFECYCLE_NODE_OWNER_EXISTS'})
			expect(() => attachNodeLifecycle(second, {signals: []}))
				.toThrow('LIFECYCLE_NODE_OWNER_EXISTS')
		} finally {
			dispose()
		}
	})

	it('releases reserved Node ownership when option capture fails', () => {
		const runtime = createCustomLifecycle(options)
		const hostile = new Proxy({}, {ownKeys: () => { throw new Error('blocked') }})
		expect(() => attachNodeLifecycle(runtime, hostile)).toThrow('stable data fields')

		const dispose = attachNodeLifecycle(runtime, {signals: []})
		dispose()
	})

	it('rejects malformed Node runtimes without leaking process ownership', () => {
		expect(() => attachNodeLifecycle({} as never, {signals: []}))
			.toThrow('valid managed lifecycle runtime')

		const runtime = createCustomLifecycle(options)
		const dispose = attachNodeLifecycle(runtime, {signals: []})
		dispose()
	})

	it('rolls back partial process listener installation and releases ownership', () => {
		const runtime = createCustomLifecycle(options)
		const originalOn = process.on.bind(process)
		let signalRegistrations = 0
		const on = vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: never[]) => void) => {
			if (event === 'SIGTERM' || event === 'SIGINT') {
				signalRegistrations++
				if (signalRegistrations === 2) throw new Error('listener installation failed')
			}
			return originalOn(event, listener as never)
		}) as typeof process.on)
		const before = process.listenerCount('SIGTERM')

		try {
			expect(() => attachNodeLifecycle(runtime)).toThrow('listener installation failed')
			expect(process.listenerCount('SIGTERM')).toBe(before)
		} finally {
			on.mockRestore()
		}

		const dispose = attachNodeLifecycle(runtime, {signals: []})
		dispose()
	})

	it('retains Node ownership until a failed listener cleanup can be retried', () => {
		const runtime = createCustomLifecycle(options)
		const second = createCustomLifecycle(options)
		const dispose = attachNodeLifecycle(runtime, {signals: ['SIGTERM']})
		const off = vi.spyOn(process, 'off').mockImplementation(() => {
			throw new Error('listener cleanup failed')
		})

		expect(dispose).toThrow('LIFECYCLE_NODE_LISTENER_CLEANUP_FAILED')
		expect(() => attachNodeLifecycle(second, {signals: []}))
			.toThrow('LIFECYCLE_NODE_LISTENER_CLEANUP_FAILED')
		off.mockRestore()

		const secondDispose = attachNodeLifecycle(second, {signals: []})
		secondDispose()
	})

	it('does not let hung fatal diagnostics delay drain and shutdown', async() => {
		const runtime = createCustomLifecycle(options)
		const terminate = vi.fn()
		const never = new Promise<void>(() => undefined)
		const dispose = attachNodeLifecycle(runtime, {
			signals: [],
			fatalErrors: {timeoutMs: 10, onFatalError: () => never, terminate}
		})
		await runtime.start()

		process.emit('unhandledRejection', new Error('fatal'), Promise.resolve())
		await vi.waitFor(() => expect(terminate).toHaveBeenCalledWith(1))

		expect(runtime.getStatus().state).toBe('closed')
		expect(runtime.getReadinessStatus().code).toBe(503)
		dispose()
	})

	it('fails readiness synchronously when a process signal begins drain', async() => {
		const runtime = createCustomLifecycle(options)
		const dispose = attachNodeLifecycle(runtime, {signals: ['SIGTERM']})
		await runtime.start()

		process.emit('SIGTERM')

		expect(runtime.getStatus().state).toBe('draining')
		expect(runtime.getReadinessStatus().code).toBe(503)
		await vi.waitFor(() => expect(runtime.getStatus().state).toBe('closed'))
		dispose()
	})

	it('redacts complete bearer credentials from fatal diagnostics', async() => {
		const runtime = createCustomLifecycle(options)
		const diagnostic = vi.fn()
		const terminate = vi.fn()
		const dispose = attachNodeLifecycle(runtime, {
			signals: [],
			fatalErrors: {timeoutMs: 100, onFatalError: diagnostic, terminate}
		})
		await runtime.start()

		process.emit(
			'uncaughtException',
			new Error('request failed Authorization: Bearer super-secret-token')
		)
		await vi.waitFor(() => expect(terminate).toHaveBeenCalledWith(1))

		const reported = diagnostic.mock.calls[0]?.[0] as Error
		expect(reported.message).not.toContain('super-secret-token')
		expect(reported.message).toContain('[REDACTED]')
		dispose()
	})
})
