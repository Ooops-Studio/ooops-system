import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {guardJobsBackendInputs} from '../../src/jobs/features/backends/backend-input-guard'
import {createMemoryJobsBackend} from '../../src/jobs/features/backends/memory'
import {createCustomJobs} from '../../src/jobs/public/custom'
import {attachJobsObservability, type JobsObservabilityEvent} from '../../src/jobs/public/observability'
import type {StoredJobRun} from '../../src/jobs/types/backend'

describe('Jobs backend composition', () => {
	it('retries a transient initial tick within a fixed bound before starting the polling loop', async() => {
		vi.useFakeTimers()
		try {
			const memory = createMemoryJobsBackend()
			let recoveryCalls = 0
			const backend = {
				...memory,
				runs: {
					...memory.runs,
					async recoverStaleLeases(...arguments_: Parameters<typeof memory.runs.recoverStaleLeases>) {
						recoveryCalls += 1
						if (recoveryCalls < 3) {
							throw Object.assign(new Error('connection terminated unexpectedly'), {code: '57P01'})
						}
						return memory.runs.recoverStaleLeases(...arguments_)
					}
				}
			}
			const runtime = await createCustomJobs({clock: createFixedClock(0), backend, pollIntervalMs: 1_000})
			const events: JobsObservabilityEvent[] = []
			attachJobsObservability(runtime.jobs, (event) => { events.push(event) })

			const starting = runtime.jobs.start()
			await vi.advanceTimersByTimeAsync(100)
			await vi.advanceTimersByTimeAsync(250)
			await expect(starting).resolves.toBeUndefined()

			expect(recoveryCalls).toBe(3)
			expect(events.filter((event) => event.kind === 'operation_failed')).toEqual([
				expect.objectContaining({operation: 'stale-recovery', code: 'JOBS_STALE_RECOVERY_FAILED'}),
				expect.objectContaining({operation: 'stale-recovery', code: 'JOBS_STALE_RECOVERY_FAILED'})
			])
			expect(events.filter((event) => event.kind === 'log')).toEqual([
				expect.objectContaining({message: 'jobs.startup_tick_retry', attributes: {attempt: 1, nextAttempt: 2, delayMs: 100}}),
				expect.objectContaining({message: 'jobs.startup_tick_retry', attributes: {attempt: 2, nextAttempt: 3, delayMs: 250}})
			])
			await runtime.jobs.shutdown()
		} finally {
			vi.useRealTimers()
		}
	})

	it('reports schedule, stale-recovery, and claim failures separately without retrying permanent errors', async() => {
		const memory = createMemoryJobsBackend()
		const schedule = vi.fn(async() => { throw new Error('invalid schedule state') })
		const recover = vi.fn(async() => { throw new Error('invalid lease state') })
		const claim = vi.fn(async() => { throw new Error('invalid claim state') })
		const backend = {
			...memory,
			schedules: {...memory.schedules, triggerDueSchedules: schedule},
			runs: {...memory.runs, recoverStaleLeases: recover, claimDueRuns: claim}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		const events: JobsObservabilityEvent[] = []
		attachJobsObservability(runtime.jobs, (event) => { events.push(event) })

		await expect(runtime.jobs.start()).rejects.toThrow('Jobs scheduler tick stages failed')

		expect(schedule).toHaveBeenCalledOnce()
		expect(recover).toHaveBeenCalledOnce()
		expect(claim).toHaveBeenCalledOnce()
		expect(events.filter((event) => event.kind === 'operation_failed')).toEqual([
			expect.objectContaining({operation: 'schedule-trigger', code: 'JOBS_SCHEDULE_TRIGGER_FAILED'}),
			expect.objectContaining({operation: 'stale-recovery', code: 'JOBS_STALE_RECOVERY_FAILED'}),
			expect.objectContaining({operation: 'run-claim', code: 'JOBS_RUN_CLAIM_FAILED'})
		])
		await runtime.jobs.shutdown()
	})

	it('fences unsupported schedule policies before a custom backend can commit a run', async() => {
		const memory = createMemoryJobsBackend()
		await memory.schedules.saveSchedule({
			id: 'unsupported-policy', task: 'task', kind: 'interval', intervalMs: 1_000,
			nextRunAt: 1, policy: {misfire: 'catch-up', overlap: 'allow'}
		})
		const backend = guardJobsBackendInputs({
			...memory,
			schedules: {
				...memory.schedules,
				triggerDueSchedules(request: Parameters<typeof memory.schedules.triggerDueSchedules>[0]) {
					return memory.schedules.triggerDueSchedules({
						...request, allowedMisfire: undefined, allowedOverlap: undefined
					})
				}
			}
		})
		let factoryCalls = 0
		await expect(backend.triggerDueSchedules({
			now: 2, maxCatchUp: 1, allowedMisfire: ['fire-once'], allowedOverlap: ['queue'],
			createRun: (schedule, runAt): StoredJobRun => {
				factoryCalls += 1
				return {
					id: 'must-not-commit', task: schedule.task, queue: schedule.queue ?? 'default',
					payload: {}, status: 'queued', createdAt: 2, updatedAt: 2, runAt, priority: 0,
					attempt: 0, maxAttempts: 1, retryPolicy: {attempts: 1, baseDelayMs: 0},
					scheduleId: schedule.id
				}
			}
		})).rejects.toThrow('policy is not supported')

		expect(factoryCalls).toBe(0)
		await expect(memory.runs.getRun('must-not-commit')).resolves.toBeUndefined()
		await expect(memory.schedules.getSchedule('unsupported-policy')).resolves.toMatchObject({nextRunAt: 1})
	})

	it('exposes frozen composed capabilities and isolates returned records', async() => {
		const backend = createMemoryJobsBackend()
		expect(backend.durability).toBe('ephemeral')
		expect(Object.isFrozen(backend)).toBe(true)
		expect(Object.isFrozen(backend.runs)).toBe(true)
		expect(Object.isFrozen(backend.schedules)).toBe(true)
		expect(Object.isFrozen(backend.maintenance)).toBe(true)
		expect(Object.isFrozen(backend.admin)).toBe(true)

		const runtime = await createCustomJobs({clock: createFixedClock(10), backend})
		runtime.jobs.registerTask({name: 'task'}, async() => undefined)
		const {runId} = await runtime.jobs.enqueue('task', {nested: {value: 1}}, {
			idempotencyKey: 'stable-key'
		})
		const first = await backend.runs.getRun(runId)
		;(first!.payload.nested as {value: number}).value = 9
		expect(await backend.runs.getRun(runId)).toMatchObject({payload: {nested: {value: 1}}})
		await expect(runtime.jobs.enqueue('task', {nested: {value: 2}}, {
			idempotencyKey: 'stable-key'
		})).rejects.toThrow('Idempotency key reused')
		await runtime.jobs.shutdown()
	})

	it('captures backend methods without executing hostile accessors', async() => {
		const memory = createMemoryJobsBackend()
		let called = false
		const runs = Object.create(memory.runs) as object
		Object.defineProperty(runs, 'appendRun', {
			enumerable: true,
			get() { called = true; return memory.runs.appendRun }
		})
		await expect(createCustomJobs({
			clock: createFixedClock(0),
			backend: {...memory, runs} as never
		})).rejects.toThrow('stable backend adapter')
		expect(called).toBe(false)
	})

	it('keeps execution available after an isolated maintenance failure', async() => {
		const memory = createMemoryJobsBackend()
		let cleanupCalls = 0
		const backend = {
			...memory,
			maintenance: {
				async cleanupTerminalRuns() {
					cleanupCalls += 1
					if (cleanupCalls === 1) throw new Error('cleanup unavailable')
					return 0
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend, pollIntervalMs: 10})
		let completed = 0
		runtime.jobs.registerTask({name: 'task'}, async() => { completed += 1 })
		await runtime.jobs.enqueue('task')
		await runtime.jobs.start()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(cleanupCalls).toBeGreaterThan(0)
		expect(completed).toBe(1)
		await runtime.jobs.shutdown()
	})

	it('runs retention maintenance even when stale recovery fails', async() => {
		const memory = createMemoryJobsBackend()
		let cleanupCalls = 0
		let claimCalls = 0
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async recoverStaleLeases() { throw new Error('dead-letter capacity exceeded') },
				async claimDueRuns(request: Parameters<typeof memory.runs.claimDueRuns>[0]) {
					claimCalls += 1
					return memory.runs.claimDueRuns(request)
				}
			},
			maintenance: {
				async cleanupTerminalRuns() { cleanupCalls += 1; return 0 }
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		runtime.jobs.registerTask({name: 'task'}, async() => undefined)

		await expect(runtime.jobs.start()).rejects.toThrow('dead-letter capacity exceeded')
		expect(cleanupCalls).toBe(1)
		expect(claimCalls).toBe(1)
		expect(runtime.jobs.getStatus()).toMatchObject({backendState: 'unhealthy'})
		await runtime.jobs.shutdown()
	})

	it('passes two polling intervals as the skip-misfire grace window', async() => {
		const memory = createMemoryJobsBackend()
		let grace: number | undefined
		const backend = {
			...memory,
			schedules: {
				...memory.schedules,
				async triggerDueSchedules(request: Parameters<typeof memory.schedules.triggerDueSchedules>[0]) {
					grace = request.misfireGraceMs
					return []
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend, pollIntervalMs: 100})

		await runtime.jobs.start()

		expect(grace).toBe(200)
		await runtime.jobs.shutdown()
	})

	it('recovers an ambiguously committed schedule upsert without moving its due time', async() => {
		const clock = createFixedClock(0)
		const memory = createMemoryJobsBackend()
		let saveCalls = 0
		const backend = {
			...memory,
			schedules: {
				...memory.schedules,
				async saveSchedule(...arguments_: Parameters<typeof memory.schedules.saveSchedule>) {
					saveCalls += 1
					const result = await memory.schedules.saveSchedule(...arguments_)
					if (saveCalls === 1) throw new Error('commit response lost')
					return result
				}
			}
		}
		const runtime = await createCustomJobs({clock, backend})
		runtime.jobs.registerTask({name: 'scheduled'}, async() => undefined)
		const definition = {
			id: 'stable', task: 'scheduled', kind: 'interval' as const, intervalMs: 1_000
		}

		await expect(runtime.jobs.upsertSchedule(definition)).resolves.toEqual({scheduleId: 'stable'})
		clock.advanceBy(500)
		await expect(runtime.jobs.upsertSchedule(definition)).resolves.toEqual({scheduleId: 'stable'})

		expect(saveCalls).toBe(1)
		expect(await memory.schedules.getSchedule('stable')).toMatchObject({nextRunAt: 1_000})
		await runtime.jobs.shutdown()
	})

	it('does not rewind a due occurrence when schedule update races its trigger', async() => {
		const clock = createFixedClock(0)
		const memory = createMemoryJobsBackend()
		let intercept = false
		let signalSave!: () => void
		let releaseSave!: () => void
		const saveStarted = new Promise<void>((resolve) => { signalSave = resolve })
		const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
		const backend = {
			...memory,
			schedules: {
				...memory.schedules,
				async saveSchedule(...arguments_: Parameters<typeof memory.schedules.saveSchedule>) {
					if (intercept) { signalSave(); await saveGate }
					return memory.schedules.saveSchedule(...arguments_)
				}
			}
		}
		const runtime = await createCustomJobs({clock, backend})
		runtime.jobs.registerTask({name: 'scheduled'}, async() => undefined)
		await runtime.jobs.upsertSchedule({
			id: 'racing', task: 'scheduled', kind: 'interval', intervalMs: 1_000,
			payload: {version: 1}
		})
		clock.advanceBy(1_000)
		intercept = true
		const updating = runtime.jobs.upsertSchedule({
			id: 'racing', task: 'scheduled', kind: 'interval', intervalMs: 1_000,
			payload: {version: 2}
		})
		await saveStarted

		const triggered = await memory.schedules.triggerDueSchedules({
			now: 1_000, maxCatchUp: 1, allowedMisfire: ['fire-once'], allowedOverlap: ['queue'],
			createRun: (schedule, runAt): StoredJobRun => ({
				id: 'racing-run', task: schedule.task, queue: schedule.queue ?? 'default',
				payload: schedule.payload ?? {}, status: 'queued', createdAt: 1_000,
				updatedAt: 1_000, runAt, priority: 0, attempt: 0, maxAttempts: 1,
				retryPolicy: {attempts: 1, baseDelayMs: 0}, scheduleId: schedule.id
			})
		})
		releaseSave()
		await updating

		expect(triggered[0]?.runs[0]?.payload).toEqual({version: 1})
		await expect(memory.schedules.getSchedule('racing')).resolves.toMatchObject({
			payload: {version: 2}, nextRunAt: 2_000
		})
		await runtime.jobs.shutdown()
	})

	it('recovers an ambiguously committed enqueue by its generated run id', async() => {
		const memory = createMemoryJobsBackend()
		let appendCalls = 0
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async appendRun(...arguments_: Parameters<typeof memory.runs.appendRun>) {
					appendCalls += 1
					await memory.runs.appendRun(...arguments_)
					throw new Error('commit response lost')
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(1), backend})
		runtime.jobs.registerTask({name: 'task'}, async() => undefined)

		const result = await runtime.jobs.enqueue('task')

		expect(appendCalls).toBe(1)
		await expect(memory.runs.getRun(result.runId)).resolves.toMatchObject({id: result.runId})
		await runtime.jobs.shutdown()
	})

	it('safely replays an ambiguous idempotent deduplication response', async() => {
		const memory = createMemoryJobsBackend()
		let appendCalls = 0
		let lostExistingResponse = false
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async appendRun(...arguments_: Parameters<typeof memory.runs.appendRun>) {
					appendCalls += 1
					const result = await memory.runs.appendRun(...arguments_)
					if (result.existing && !lostExistingResponse) {
						lostExistingResponse = true
						throw new Error('deduplication response lost')
					}
					return result
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(1), backend})
		runtime.jobs.registerTask({name: 'task'}, async() => undefined)
		const first = await runtime.jobs.enqueue('task', {}, {idempotencyKey: 'stable'})

		const second = await runtime.jobs.enqueue('task', {}, {idempotencyKey: 'stable'})

		expect(second).toEqual(first)
		expect(appendCalls).toBe(3)
		await runtime.jobs.shutdown()
	})

	it('recovers a non-idempotent enqueue whose committed response is empty', async() => {
		const memory = createMemoryJobsBackend()
		let committedRunId: string | undefined
		const backend = {
			...memory,
			runs: {
				...memory.runs,
				async appendRun(...arguments_: Parameters<typeof memory.runs.appendRun>) {
					const result = await memory.runs.appendRun(...arguments_)
					committedRunId = result.run.id
					return undefined as never
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(1), backend})
		runtime.jobs.registerTask({name: 'task'}, async() => undefined)

		const result = await runtime.jobs.enqueue('task')

		expect(result.runId).toBe(committedRunId)
		await expect(memory.runs.getRun(result.runId)).resolves.toMatchObject({id: result.runId})
		await runtime.jobs.shutdown()
	})

	it('rejects a manual trigger provider that invokes the factory but loses the result', async() => {
		const memory = createMemoryJobsBackend()
		const backend = {
			...memory,
			admin: {
				...memory.admin!,
				async triggerScheduleNow(
					id: string,
					createRun: Parameters<NonNullable<typeof memory.admin>['triggerScheduleNow']>[1]
				) {
					const schedule = await memory.schedules.getSchedule(id)
					if (schedule) createRun(schedule)
					return []
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		runtime.jobs.registerTask({name: 'scheduled'}, async() => undefined)
		await runtime.jobs.upsertSchedule({
			id: 'manual', task: 'scheduled', kind: 'interval', intervalMs: 1_000
		})

		await expect(runtime.admin!.triggerScheduleNow('manual')).rejects.toThrow(
			'inconsistent manual schedule trigger result'
		)
		await runtime.jobs.shutdown()
	})

	it('recovers a committed manual trigger whose provider returns no response', async() => {
		const memory = createMemoryJobsBackend()
		const backend = {
			...memory,
			admin: {
				...memory.admin!,
				async triggerScheduleNow(
					id: string,
					createRun: Parameters<NonNullable<typeof memory.admin>['triggerScheduleNow']>[1]
				) {
					const schedule = await memory.schedules.getSchedule(id)
					if (schedule) await memory.runs.appendRun(createRun(schedule))
					return undefined as never
				}
			}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		runtime.jobs.registerTask({name: 'scheduled'}, async() => undefined)
		await runtime.jobs.upsertSchedule({
			id: 'manual-ambiguous', task: 'scheduled', kind: 'interval', intervalMs: 1_000
		})

		const [result] = await runtime.admin!.triggerScheduleNow('manual-ambiguous')

		expect(result?.runId).toBeDefined()
		await expect(memory.runs.getRun(result!.runId)).resolves.toMatchObject({
			id: result!.runId, scheduleId: 'manual-ambiguous', task: 'scheduled'
		})
		await runtime.jobs.shutdown()
	})

	it('rejects a due schedule run altered after generation by its provider', async() => {
		const clock = createFixedClock(0)
		const memory = createMemoryJobsBackend()
		const backend = {
			...memory,
			schedules: {
				...memory.schedules,
				async triggerDueSchedules(
					request: Parameters<typeof memory.schedules.triggerDueSchedules>[0]
				) {
					const results = await memory.schedules.triggerDueSchedules(request)
					if (results[0]?.runs[0]) results[0].runs[0].priority += 1
					return results
				}
			}
		}
		const runtime = await createCustomJobs({clock, backend})
		runtime.jobs.registerTask({name: 'scheduled'}, async() => undefined)
		await runtime.jobs.upsertSchedule({
			id: 'altered', task: 'scheduled', kind: 'interval', intervalMs: 1_000
		})
		clock.advanceBy(1_000)

		await expect(runtime.jobs.start()).rejects.toThrow(
			'run that was not generated for this schedule trigger'
		)
		await runtime.jobs.shutdown()
	})
})
