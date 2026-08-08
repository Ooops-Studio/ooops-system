import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createMemoryJobsBackend} from '../../src/jobs/features/backends/memory'
import {createCustomJobs} from '../../src/jobs/public/custom'
import {createDevelopmentJobs} from '../../src/jobs/public/development'
import type {StoredJobRun} from '../../src/jobs/types/backend'

afterEach(() => { vi.useRealTimers() })

describe('Jobs execution behavior', () => {
	it('captures the clock once without invoking accessor-backed capabilities', async() => {
		let getterCalls = 0
		const hostileClock = Object.defineProperty({}, 'now', {
			enumerable: true,
			get() { getterCalls += 1; return () => 0 }
		})
		await expect(createCustomJobs({
			clock: hostileClock as never, backend: createMemoryJobsBackend()
		})).rejects.toThrow('valid clock')
		expect(getterCalls).toBe(0)

		const clock = {now: () => 10}
		const runtime = await createCustomJobs({clock, backend: createMemoryJobsBackend()})
		runtime.jobs.registerTask({name: 'clocked'}, async() => undefined)
		clock.now = () => 999
		const {runId} = await runtime.jobs.enqueue('clocked')
		expect(await runtime.jobs.getRun(runId)).toMatchObject({createdAt: 10, runAt: 10})
		await runtime.jobs.shutdown()
	})

	it('executes registered tasks and keeps administration out of the application port', async() => {
		const runtime = await createDevelopmentJobs({clock: createFixedClock(100)})
		const handler = vi.fn(async({payload}) => ({sent: payload.id}))
		runtime.jobs.registerTask({name: 'send', queue: 'email'}, handler)
		const {runId} = await runtime.jobs.enqueue('send', {id: 'one'})
		expect(runtime.jobs).not.toHaveProperty('listRuns')
		await runtime.jobs.start()
		await runtime.jobs.flush()
		expect(handler).toHaveBeenCalledOnce()
		expect(await runtime.jobs.getRun(runId)).toMatchObject({
			status: 'completed', task: 'send', output: {sent: 'one'}
		})
		expect(await runtime.admin!.listRuns({queue: 'email'})).toHaveLength(1)
		await runtime.jobs.shutdown()
	})

	it('does not claim runs owned by tasks that are not registered on this worker', async() => {
		const backend = createMemoryJobsBackend()
		const foreign: StoredJobRun = {
			id: 'foreign-task-run', task: 'foreign', queue: 'default', payload: {},
			status: 'queued', createdAt: 0, updatedAt: 0, runAt: 0, priority: 0,
			attempt: 0, maxAttempts: 1, retryPolicy: {attempts: 1, baseDelayMs: 0}
		}
		await backend.runs.appendRun(foreign)
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		runtime.jobs.registerTask({name: 'local'}, vi.fn())

		await runtime.jobs.start()
		await runtime.jobs.flush()

		expect(await backend.runs.getRun(foreign.id)).toMatchObject({status: 'queued', attempt: 0})
		await runtime.jobs.shutdown()
	})

	it('releases an unregistered-task claim returned by a non-conforming custom backend', async() => {
		const memory = createMemoryJobsBackend()
		const foreign: StoredJobRun = {
			id: 'invalid-foreign-claim', task: 'foreign', queue: 'default', payload: {},
			status: 'queued', createdAt: 0, updatedAt: 0, runAt: 0, priority: 0,
			attempt: 0, maxAttempts: 1, retryPolicy: {attempts: 1, baseDelayMs: 0}
		}
		await memory.runs.appendRun(foreign)
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				claimDueRuns: (request: Parameters<typeof memory.runs.claimDueRuns>[0]) =>
					memory.runs.claimDueRuns({...request, allowedTasks: undefined})
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		runtime.jobs.registerTask({name: 'local'}, vi.fn())

		await expect(runtime.jobs.start()).rejects.toThrow('invalid claim batch')

		expect(await memory.runs.getRun(foreign.id)).toMatchObject({status: 'queued', attempt: 0})
		await runtime.jobs.shutdown()
	})

	it('releases a semantically malformed claim when its ownership identity is usable', async() => {
		const memory = createMemoryJobsBackend()
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async claimDueRuns(request: Parameters<typeof memory.runs.claimDueRuns>[0]) {
					const claimed = await memory.runs.claimDueRuns(request)
					if (claimed[0]) claimed[0].retryPolicy.maxDelayMs = -1
					return claimed
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		runtime.jobs.registerTask({name: 'malformed'}, vi.fn())
		const {runId} = await runtime.jobs.enqueue('malformed')

		await expect(runtime.jobs.start()).rejects.toThrow('invalid claim batch')

		expect(await memory.runs.getRun(runId)).toMatchObject({status: 'queued', attempt: 0})
		await runtime.jobs.shutdown()
	})

	it('never executes a claim whose lease expires before the backend response arrives', async() => {
		const clock = createFixedClock(0)
		const memory = createMemoryJobsBackend()
		let advanced = false
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async claimDueRuns(request: Parameters<typeof memory.runs.claimDueRuns>[0]) {
					const claimed = await memory.runs.claimDueRuns(request)
					if (!advanced && claimed.length > 0) {
						advanced = true
						clock.advanceBy(1_000)
					}
					return claimed
				}
			}
		}
		const handler = vi.fn(async() => undefined)
		const runtime = await createCustomJobs({
			clock, backend, lease: {leaseMs: 200, recoveryAfterMs: 0}
		})
		runtime.jobs.registerTask({name: 'late-claim'}, handler)
		const {runId} = await runtime.jobs.enqueue('late-claim')

		await expect(runtime.jobs.start()).rejects.toThrow('invalid claim batch')

		expect(handler).not.toHaveBeenCalled()
		expect(await memory.runs.getRun(runId)).toMatchObject({status: 'queued', attempt: 0})
		await runtime.jobs.shutdown()
	})

	it('never executes a claim that cannot survive until its first heartbeat', async() => {
		const clock = createFixedClock(0)
		const memory = createMemoryJobsBackend()
		let advanced = false
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async claimDueRuns(request: Parameters<typeof memory.runs.claimDueRuns>[0]) {
					const claimed = await memory.runs.claimDueRuns(request)
					if (!advanced && claimed.length > 0) {
						advanced = true
						clock.advanceBy(150)
					}
					return claimed
				}
			}
		}
		const handler = vi.fn(async() => undefined)
		const runtime = await createCustomJobs({
			clock, backend, lease: {leaseMs: 200, recoveryAfterMs: 0}
		})
		runtime.jobs.registerTask({name: 'short-claim'}, handler)
		const {runId} = await runtime.jobs.enqueue('short-claim')

		await expect(runtime.jobs.start()).rejects.toThrow('invalid claim batch')

		expect(handler).not.toHaveBeenCalled()
		expect(await memory.runs.getRun(runId)).toMatchObject({status: 'queued', attempt: 0})
		await runtime.jobs.shutdown()
	})

	it('triggers only schedules owned by tasks registered on this worker', async() => {
		const backend = createMemoryJobsBackend()
		await backend.schedules.saveSchedule({
			id: 'a-foreign-schedule', task: 'foreign', kind: 'interval',
			intervalMs: 1_000, nextRunAt: 0
		})
		await backend.schedules.saveSchedule({
			id: 'z-local-schedule', task: 'local', kind: 'interval',
			intervalMs: 1_000, nextRunAt: 0
		})
		const handler = vi.fn(async() => undefined)
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		runtime.jobs.registerTask({name: 'local'}, handler)

		await runtime.jobs.start()
		await runtime.jobs.flush()

		expect(handler).toHaveBeenCalledOnce()
		expect(await backend.schedules.getSchedule('a-foreign-schedule')).toMatchObject({nextRunAt: 0})
		expect(await backend.schedules.getSchedule('z-local-schedule')).toMatchObject({nextRunAt: 1_000})
		expect(await backend.admin!.listRuns({task: 'foreign'})).toEqual([])
		await runtime.jobs.shutdown()
	})

	it('validates task, payload and idempotency inputs before backend mutation', async() => {
		const runtime = await createDevelopmentJobs({clock: createFixedClock(0)})
		expect(() => runtime.jobs.registerTask({name: 'unsafe name'}, vi.fn())).toThrow('safe identifier')
		await expect(runtime.jobs.enqueue('missing')).rejects.toThrow('not registered')
		runtime.jobs.registerTask({name: 'send'}, vi.fn())
		expect(() => runtime.jobs.registerTask({name: 'send'}, vi.fn())).toThrow('already registered')
		const accessorPayload = Object.defineProperty({}, 'value', {
			enumerable: true, get: () => 1
		})
		await expect(runtime.jobs.enqueue('send', accessorPayload)).rejects.toThrow('accessors')
		const canonical = await runtime.jobs.enqueue('send', {kept: 1, omitted: undefined})
		await expect(runtime.jobs.getRun(canonical.runId)).resolves.toMatchObject({payload: {kept: 1}})
		expect((await runtime.jobs.getRun(canonical.runId))?.payload).not.toHaveProperty('omitted')
		const first = await runtime.jobs.enqueue('send', {value: 1}, {idempotencyKey: 'request-1'})
		expect(await runtime.jobs.enqueue('send', {value: 1}, {
			idempotencyKey: 'request-1'
		})).toEqual(first)
		await expect(runtime.jobs.enqueue('send', {value: 2}, {
			idempotencyKey: 'request-1'
		})).rejects.toThrow('different payload')
		await runtime.jobs.shutdown()
	})

	it('does not self-starve a full batch of admin retries at mutation capacity', async() => {
		const backend = createMemoryJobsBackend()
		const source: StoredJobRun = {
			id: 'retry-capacity-source', task: 'retry-capacity', queue: 'default', payload: {},
			status: 'queued', createdAt: 0, updatedAt: 0, runAt: 0, priority: 0,
			attempt: 0, maxAttempts: 1, retryPolicy: {attempts: 1, baseDelayMs: 0}
		}
		await backend.runs.appendRun(source)
		expect(await backend.runs.cancelRun(source.id, undefined, undefined, 1)).toBe(true)
		const runtime = await createCustomJobs({clock: createFixedClock(1), backend})
		runtime.jobs.registerTask({name: source.task}, async() => undefined)

		const retried = await Promise.all(
			Array.from({length: 1_024}, () => runtime.admin!.retryRun(source.id))
		)

		expect(new Set(retried.map((result) => result.runId)).size).toBe(1)
		await runtime.jobs.shutdown()
	})

	it('recovers a retry without retaining a terminal failure code', async() => {
		vi.useFakeTimers()
		const clock = createFixedClock(0)
		const runtime = await createCustomJobs({
			clock, backend: createMemoryJobsBackend(), pollIntervalMs: 10,
			retry: {attempts: 2, baseDelayMs: 10, jitter: 'none'}
		})
		const handler = vi.fn()
			.mockRejectedValueOnce(new Error('transient secret'))
			.mockResolvedValueOnce({ok: true})
		runtime.jobs.registerTask({name: 'eventual'}, handler)
		const {runId} = await runtime.jobs.enqueue('eventual')
		await runtime.jobs.start()
		await runtime.jobs.flush()
		expect(await runtime.jobs.getRun(runId)).toMatchObject({status: 'retryable', attempt: 1})
		clock.advanceBy(10)
		await vi.advanceTimersByTimeAsync(10)
		await runtime.jobs.flush()
		const completed = await runtime.jobs.getRun(runId)
		expect(completed).toMatchObject({status: 'completed', output: {ok: true}})
		expect(completed?.failureCode).toBeUndefined()
		expect(JSON.stringify(completed)).not.toContain('transient secret')
		await runtime.jobs.shutdown()
	})

	it('recovers completed and dead-lettered transitions after their responses are lost', async() => {
		for (const outcome of ['completed', 'dead-lettered'] as const) {
			const memory = createMemoryJobsBackend()
			let lost = false
			const backend = {
				...memory,
				runs: {
					...memory.runs,
					async completeRun(...arguments_: Parameters<typeof memory.runs.completeRun>) {
						const result = await memory.runs.completeRun(...arguments_)
						if (outcome === 'completed' && !lost) { lost = true; throw new Error('response lost') }
						return result
					},
					async deadLetterRun(...arguments_: Parameters<typeof memory.runs.deadLetterRun>) {
						const result = await memory.runs.deadLetterRun(...arguments_)
						if (outcome === 'dead-lettered' && !lost) { lost = true; throw new Error('response lost') }
						return result
					}
				}
			}
			const runtime = await createCustomJobs({
				clock: createFixedClock(0), backend, retry: {attempts: 1, baseDelayMs: 0}
			})
			runtime.jobs.registerTask({name: 'transition'}, async() => {
				if (outcome === 'dead-lettered') throw new Error('failed')
			})
			const {runId} = await runtime.jobs.enqueue('transition')
			await runtime.jobs.start()

			await expect(runtime.jobs.flush()).resolves.toBeUndefined()
			await expect(runtime.jobs.getRun(runId)).resolves.toMatchObject({status: outcome})
			expect(lost).toBe(true)
			await runtime.jobs.shutdown()
		}
	})

	it('supports bounded queue controls, cancellation and deterministic retry', async() => {
		const runtime = await createDevelopmentJobs({clock: createFixedClock(0)})
		runtime.jobs.registerTask({name: 'work'}, vi.fn())
		const first = await runtime.jobs.enqueue('work', {}, {queue: 'slow', priority: 7})
		await runtime.admin!.pauseQueue('slow')
		expect(await runtime.admin!.getQueueStats('slow')).toEqual([
			expect.objectContaining({paused: true, queued: 1})
		])
		await runtime.jobs.cancelRun(first.runId, 'operator')
		expect(await runtime.jobs.getRun(first.runId)).toMatchObject({
			status: 'cancelled', cancelReason: 'operator'
		})
		const [retried, duplicate] = await Promise.all([
			runtime.admin!.retryRun(first.runId), runtime.admin!.retryRun(first.runId)
		])
		expect(duplicate.runId).toBe(retried.runId)
		expect(await runtime.jobs.getRun(retried.runId)).toMatchObject({queue: 'slow', priority: 7})
		await runtime.jobs.shutdown()
	})

	it('does not turn a durable cancellation into a lease-renewal failure', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const memory = createMemoryJobsBackend()
		let renewals = 0
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async renewLease(...arguments_: Parameters<typeof memory.runs.renewLease>) {
					renewals += 1
					return memory.runs.renewLease(...arguments_)
				}
			}
		}
		const runtime = await createCustomJobs({
			clock: createFixedClock(0), backend, pollIntervalMs: 10,
			lease: {leaseMs: 200}, retry: {attempts: 1, baseDelayMs: 0}
		})
		const canceller = await createCustomJobs({clock: createFixedClock(0), backend: memory})
		runtime.jobs.registerTask({name: 'cancelled'}, async() => await gate)
		const {runId} = await runtime.jobs.enqueue('cancelled')
		await runtime.jobs.start()
		await canceller.jobs.cancelRun(runId, 'operator')
		await vi.advanceTimersByTimeAsync(150)
		expect(renewals).toBeGreaterThan(0)
		release()
		await vi.advanceTimersByTimeAsync(20)
		await expect(runtime.jobs.flush()).resolves.toBeUndefined()
		await expect(runtime.jobs.getRun(runId)).resolves.toMatchObject({
			status: 'cancelled', cancelReason: 'operator'
		})
		await runtime.jobs.shutdown()
		await canceller.jobs.shutdown()
	})

	it('does not execute a cancellation racing the overflow point-read fence', async() => {
		const memory = createMemoryJobsBackend()
		let targetId: string | undefined
		let intercept = false
		let intercepted = false
		let signalRead!: () => void
		let releaseRead!: () => void
		const readStarted = new Promise<void>((resolve) => { signalRead = resolve })
		const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async getRun(id: string) {
					const current = await memory.runs.getRun(id)
					if (intercept && !intercepted && id === targetId && current?.status === 'running') {
						intercepted = true
						signalRead()
						await readGate
					}
					return current
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		const handler = vi.fn()
		runtime.jobs.registerTask({name: 'fenced'}, handler)
		for (let index = 0; index < 2_049; index += 1) {
			const filler = await runtime.jobs.enqueue('fenced')
			await runtime.jobs.cancelRun(filler.runId)
		}
		targetId = (await runtime.jobs.enqueue('fenced')).runId
		intercept = true
		const starting = runtime.jobs.start()
		await readStarted

		await runtime.jobs.cancelRun(targetId)
		releaseRead()
		await starting
		await runtime.jobs.flush()

		expect(handler).not.toHaveBeenCalled()
		await expect(runtime.jobs.getRun(targetId)).resolves.toMatchObject({status: 'cancelled'})
		await runtime.jobs.shutdown()
	}, 15_000)

	it.each(['throws', 'returns false'] as const)(
		'recovers a lease renewal after its committed response %s', async(response) => {
			vi.useFakeTimers()
			let release!: () => void
			const gate = new Promise<void>((resolve) => { release = resolve })
			const clock = createFixedClock(0)
			const memory = createMemoryJobsBackend()
			let lost = false
			const backend = {
				...memory,
				runs: {
					...memory.runs,
					async renewLease(...arguments_: Parameters<typeof memory.runs.renewLease>) {
						const result = await memory.runs.renewLease(...arguments_)
						if (!lost) {
							lost = true
							if (response === 'throws') throw new Error('response lost')
							return false
						}
						return result
					}
				}
			}
			const runtime = await createCustomJobs({
				clock, backend, pollIntervalMs: 10,
				lease: {leaseMs: 200}, retry: {attempts: 1, baseDelayMs: 0}
			})
			runtime.jobs.registerTask({name: 'renewed'}, async() => await gate)
			const {runId} = await runtime.jobs.enqueue('renewed')
			await runtime.jobs.start()
			clock.advanceBy(100)
			await vi.advanceTimersByTimeAsync(150)
			expect(lost).toBe(true)
			release()
			await vi.advanceTimersByTimeAsync(20)
			await expect(runtime.jobs.flush()).resolves.toBeUndefined()
			await expect(runtime.jobs.getRun(runId)).resolves.toMatchObject({status: 'completed'})
			await runtime.jobs.shutdown()
		})

	it('continues renewing after a committed renewal response remains pending', async() => {
		vi.useFakeTimers()
		let releaseHandler!: () => void
		let releaseFirstResponse!: () => void
		const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve })
		const firstResponseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve })
		const clock = createFixedClock(0)
		const memory = createMemoryJobsBackend()
		let renewals = 0
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async renewLease(...arguments_: Parameters<typeof memory.runs.renewLease>) {
					renewals += 1
					const result = await memory.runs.renewLease(...arguments_)
					if (renewals === 1) {
						await firstResponseGate
						throw new Error('late response failure')
					}
					return result
				}
			}
		}
		const runtime = await createCustomJobs({
			clock, backend, pollIntervalMs: 10,
			lease: {leaseMs: 200}, retry: {attempts: 1, baseDelayMs: 0}
		})
		runtime.jobs.registerTask({name: 'renew-pending'}, async() => await handlerGate)
		const {runId} = await runtime.jobs.enqueue('renew-pending')
		await runtime.jobs.start()

		clock.advanceBy(100)
		await vi.advanceTimersByTimeAsync(100)
		expect(renewals).toBe(1)
		clock.advanceBy(100)
		await vi.advanceTimersByTimeAsync(100)
		clock.advanceBy(100)
		await vi.advanceTimersByTimeAsync(100)

		expect(renewals).toBeGreaterThanOrEqual(2)
		expect(await memory.runs.getRun(runId)).toMatchObject({
			status: 'running', leaseExpiresAt: 500
		})
		releaseFirstResponse()
		releaseHandler()
		await vi.advanceTimersByTimeAsync(20)
		await expect(runtime.jobs.flush()).resolves.toBeUndefined()
		await expect(runtime.jobs.getRun(runId)).resolves.toMatchObject({status: 'completed'})
		await runtime.jobs.shutdown()
	})

	it('enforces per-task concurrency until physical handlers settle', async() => {
		vi.useFakeTimers()
		const runtime = await createCustomJobs({
			clock: createFixedClock(0), backend: createMemoryJobsBackend(),
			pollIntervalMs: 10, maxConcurrentRuns: 4
		})
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		let active = 0
		let maximum = 0
		runtime.jobs.registerTask({name: 'serial', concurrency: 1}, async() => {
			active += 1
			maximum = Math.max(maximum, active)
			await gate
			active -= 1
		})
		await runtime.jobs.enqueue('serial')
		await runtime.jobs.enqueue('serial')
		await runtime.jobs.start()
		await vi.advanceTimersByTimeAsync(50)
		expect(maximum).toBe(1)
		release()
		await vi.advanceTimersByTimeAsync(50)
		await runtime.jobs.flush()
		expect((await runtime.admin!.listRuns({status: 'completed'}))).toHaveLength(2)
		await runtime.jobs.shutdown()
	})

	it('never executes a timed-out claim after releasing its captured ownership', async() => {
		vi.useFakeTimers()
		const memory = createMemoryJobsBackend()
		let firstClaim: Awaited<ReturnType<typeof memory.runs.claimDueRuns>>[number] | undefined
		let duplicateReady = false
		let duplicateReturned = false
		let releaseOld!: () => void
		let settleOld!: () => void
		const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
		const oldSettled = new Promise<void>((resolve) => { settleOld = resolve })
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async claimDueRuns(request: Parameters<typeof memory.runs.claimDueRuns>[0]) {
					const claimed = await memory.runs.claimDueRuns(request)
					firstClaim ??= claimed[0]
					if (duplicateReady && !duplicateReturned && claimed.length === 0 && firstClaim) {
						duplicateReturned = true
						return [firstClaim]
					}
					return claimed
				},
				async releaseClaim(...arguments_: Parameters<typeof memory.runs.releaseClaim>) {
					const released = await memory.runs.releaseClaim(...arguments_)
					releaseOld()
					await oldSettled
					await Promise.resolve()
					return released
				}
			}
		}
		const runtime = await createCustomJobs({
			clock: createFixedClock(0), backend, pollIntervalMs: 20, maxConcurrentRuns: 2,
			retry: {attempts: 1, baseDelayMs: 0}
		})
		const handler = vi.fn(async({signal}) => {
			if (handler.mock.calls.length !== 1) return
			signal.addEventListener('abort', () => { duplicateReady = true }, {once: true})
			await oldGate
			settleOld()
		})
		runtime.jobs.registerTask({name: 'timed', timeoutMs: 10}, handler)
		await runtime.jobs.enqueue('timed')
		await runtime.jobs.start()

		await vi.advanceTimersByTimeAsync(25)
		await runtime.jobs.flush()

		expect(duplicateReturned).toBe(true)
		expect(handler).toHaveBeenCalledOnce()
		await runtime.jobs.shutdown()
	})
})
