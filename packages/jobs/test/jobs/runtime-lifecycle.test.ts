import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createMemoryJobsBackend} from '../../src/jobs/features/backends/memory'
import {createCustomJobs} from '../../src/jobs/public/custom'

afterEach(() => { vi.useRealTimers() })

describe('Jobs managed lifecycle', () => {
	it('closes task registration on first start and returns frozen status', async() => {
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend: createMemoryJobsBackend()})
		runtime.jobs.registerTask({name: 'task'}, async() => undefined)
		await runtime.jobs.start()
		expect(() => runtime.jobs.registerTask({name: 'late'}, async() => undefined)).toThrow('before start')
		const status = runtime.jobs.getStatus()
		expect(status).toMatchObject({state: 'running', backendState: 'healthy'})
		expect(Object.isFrozen(status)).toBe(true)
		await runtime.jobs.shutdown()
		expect(runtime.jobs.getStatus()).toMatchObject({state: 'closed', backendState: 'closed'})
		await expect(runtime.jobs.enqueue('task')).rejects.toThrow('shutdown')
	})

	it('keeps a failed shutdown draining and continues unresolved physical work on retry', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const physical = new Promise<void>((resolve) => { release = resolve })
		const runtime = await createCustomJobs({
			clock: createFixedClock(0), backend: createMemoryJobsBackend(),
			pollIntervalMs: 10, lease: {leaseMs: 200}, retry: {attempts: 1, baseDelayMs: 0}
		})
		runtime.jobs.registerTask({name: 'hung'}, async() => await physical)
		await runtime.jobs.enqueue('hung')
		await runtime.jobs.start()
		await vi.advanceTimersByTimeAsync(20)
		const first = runtime.jobs.shutdown()
		const firstOutcome = first.then(() => undefined, (error: unknown) => error)
		await vi.advanceTimersByTimeAsync(10_100)
		expect(await firstOutcome).toEqual(expect.objectContaining({message: expect.stringContaining('timed out')}))
		expect(runtime.jobs.getStatus()).toMatchObject({state: 'draining', backendState: 'unhealthy'})
		await expect(runtime.jobs.enqueue('hung')).rejects.toThrow('shutdown')
		release()
		await vi.runAllTimersAsync()
		await runtime.jobs.shutdown()
		expect(runtime.jobs.getStatus().state).toBe('closed')
	})

	it('flush establishes a barrier without closing admission', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const runtime = await createCustomJobs({
			clock: createFixedClock(0), backend: createMemoryJobsBackend(), pollIntervalMs: 10
		})
		runtime.jobs.registerTask({name: 'task'}, async() => await gate)
		await runtime.jobs.enqueue('task')
		await runtime.jobs.start()
		await vi.advanceTimersByTimeAsync(20)
		let flushed = false
		const flush = runtime.jobs.flush().then(() => { flushed = true })
		await vi.advanceTimersByTimeAsync(100)
		expect(flushed).toBe(false)
		release()
		await flush
		expect(runtime.jobs.getStatus().state).toBe('running')
		await expect(runtime.jobs.enqueue('task')).resolves.toHaveProperty('runId')
		await runtime.jobs.shutdown()
	})

	it('still aborts active handlers when a concurrent flush fails', async() => {
		vi.useFakeTimers()
		let aborted = false
		const runtime = await createCustomJobs({
			clock: createFixedClock(0), backend: createMemoryJobsBackend(), pollIntervalMs: 10
		})
		runtime.jobs.registerTask({name: 'hung'}, async({signal}) => await new Promise<void>((resolve) => {
			signal.addEventListener('abort', () => { aborted = true; resolve() }, {once: true})
		}))
		await runtime.jobs.enqueue('hung')
		await runtime.jobs.start()
		await vi.advanceTimersByTimeAsync(20)
		const flushOutcome = runtime.jobs.flush().then(() => undefined, (error: unknown) => error)
		const shutdownOutcome = runtime.jobs.shutdown().then(() => undefined, (error: unknown) => error)

		await vi.advanceTimersByTimeAsync(10_100)

		expect(await flushOutcome).toEqual(expect.objectContaining({message: expect.stringContaining('timed out')}))
		expect(await shutdownOutcome).toEqual(expect.objectContaining({
			message: expect.stringContaining('preparation failed')
		}))
		expect(aborted).toBe(true)
		expect(runtime.jobs.getStatus().state).toBe('draining')
		await runtime.jobs.shutdown()
		expect(runtime.jobs.getStatus().state).toBe('closed')
	})

	it('shares concurrent start and shutdown attempts', async() => {
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend: createMemoryJobsBackend()})
		runtime.jobs.registerTask({name: 'task'}, async() => undefined)
		await Promise.all([runtime.jobs.start(), runtime.jobs.start()])
		await Promise.all([runtime.jobs.shutdown(), runtime.jobs.shutdown()])
		await runtime.jobs.shutdown()
		expect(runtime.jobs.getStatus().state).toBe('closed')
	})

	it('releases a late initial claim instead of executing after start failed', async() => {
		vi.useFakeTimers()
		const memory = createMemoryJobsBackend()
		let releaseClaimResponse!: () => void
		const claimGate = new Promise<void>((resolve) => { releaseClaimResponse = resolve })
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async claimDueRuns(request: Parameters<typeof memory.runs.claimDueRuns>[0]) {
					await claimGate
					return memory.runs.claimDueRuns(request)
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		const handler = vi.fn()
		runtime.jobs.registerTask({name: 'late'}, handler)
		const {runId} = await runtime.jobs.enqueue('late')
		const startOutcome = runtime.jobs.start().then(() => undefined, (error: unknown) => error)

		await vi.advanceTimersByTimeAsync(5_001)
		await expect(startOutcome).resolves.toEqual(expect.objectContaining({
			message: expect.stringContaining('run-claim timed out')
		}))
		expect(runtime.jobs.getStatus().state).toBe('idle')
		releaseClaimResponse()
		await runtime.jobs.flush()

		expect(handler).not.toHaveBeenCalled()
		await expect(runtime.jobs.getRun(runId)).resolves.toMatchObject({status: 'queued', attempt: 0})
		await runtime.jobs.shutdown()
	})

	it('freezes public capabilities so lifecycle finalization cannot be rewired', async() => {
		let shutdownHook!: () => Promise<void>
		const lifecycle = {
			getStatus: vi.fn(), registerHealthCheck: vi.fn(), recordDegradation: vi.fn(),
			clearDegradation: vi.fn(), registerFlushHook: vi.fn(() => vi.fn()),
			registerShutdownHook: vi.fn((_group, hook) => {
				shutdownHook = hook
				return vi.fn()
			})
		}
		const runtime = await createCustomJobs({
			clock: createFixedClock(0), backend: createMemoryJobsBackend(), lifecycle: lifecycle as never
		})

		expect(Object.isFrozen(runtime)).toBe(true)
		expect(Object.isFrozen(runtime.jobs)).toBe(true)
		expect(Object.isFrozen(runtime.admin)).toBe(true)
		expect(() => { (runtime.jobs as {shutdown: () => Promise<void>}).shutdown = vi.fn() })
			.toThrow()

		await shutdownHook()
		expect(runtime.jobs.getStatus().state).toBe('closed')
	})
})
