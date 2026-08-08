import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {parseLegacyJobsState} from '../../src/jobs/features/backends/legacy-migration'
import {createMemoryJobsBackend} from '../../src/jobs/features/backends/memory'
import {createCustomJobs} from '../../src/jobs/public/custom'
import type {StoredDeadLetter, StoredJobRun} from '../../src/jobs/types/backend'

afterEach(() => { vi.useRealTimers() })

describe('Jobs durable runtime features', () => {
	it('leaves valid unsupported memory schedule policies claimable by another worker', async() => {
		const backend = createMemoryJobsBackend()
		await backend.schedules.saveSchedule({
			id: 'a-allow-policy', task: 'task', kind: 'interval', intervalMs: 1_000,
			nextRunAt: 1, policy: {misfire: 'catch-up', overlap: 'allow'}
		})
		await backend.schedules.saveSchedule({
			id: 'z-queue-policy', task: 'task', kind: 'interval', intervalMs: 1_000,
			nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'queue'}
		})
		let sequence = 0
		const createRun = (schedule: Parameters<Parameters<
			typeof backend.schedules.triggerDueSchedules
		>[0]['createRun']>[0], runAt: number): StoredJobRun => ({
			id: `policy-run-${sequence++}`, task: schedule.task, queue: schedule.queue ?? 'default',
			payload: schedule.payload ?? {}, status: 'queued', createdAt: 2, updatedAt: 2,
			runAt, priority: 0, attempt: 0, maxAttempts: 1,
			retryPolicy: {attempts: 1, baseDelayMs: 0}, scheduleId: schedule.id
		})

		const queueWorker = await backend.schedules.triggerDueSchedules({
			now: 2, maxCatchUp: 1, allowedMisfire: ['fire-once'], allowedOverlap: ['queue'],
			createRun
		})
		expect(queueWorker.map((result) => result.schedule.id)).toEqual(['z-queue-policy'])
		await expect(backend.schedules.getSchedule('a-allow-policy')).resolves.toMatchObject({nextRunAt: 1})

		const allowWorker = await backend.schedules.triggerDueSchedules({
			now: 2, maxCatchUp: 1, allowedMisfire: ['catch-up'], allowedOverlap: ['allow'],
			createRun
		})
		expect(allowWorker.map((result) => result.schedule.id)).toEqual(['a-allow-policy'])
	})

	it('does not let a storage-saturated dead letter block unrelated stale recovery', async() => {
		const backend = createMemoryJobsBackend()
		const largePayload = {value: 'x'.repeat(1_040_000)}
		const createQueued = (
			id: string, payload: unknown, maxAttempts: number, priority = 0, runAt = 0
		): StoredJobRun => ({
			id, task: 'task', queue: 'default', payload, status: 'queued',
			createdAt: 0, updatedAt: 0, runAt, priority, attempt: 0, maxAttempts,
			retryPolicy: {attempts: maxAttempts, baseDelayMs: 0}
		})

		await backend.runs.appendRun(createQueued('exhausted', largePayload, 1, 1))
		for (let index = 0; index < 63; index += 1) {
			await backend.runs.appendRun(createQueued(`filler-${index}`, largePayload, 2, 0, 1_000))
		}
		await backend.runs.appendRun(createQueued('retryable', {}, 2, 1))
		const claimed = await backend.runs.claimDueRuns({
			now: 1, workerId: 'worker', limit: 2, maxConcurrentRuns: 2, leaseMs: 100
		})
		expect(claimed.map((run) => run.id)).toEqual(['exhausted', 'retryable'])

		await expect(backend.runs.recoverStaleLeases(101, 0, 200)).resolves.toBe(1)
		await expect(backend.runs.getRun('exhausted')).resolves.toMatchObject({status: 'running'})
		await expect(backend.runs.getRun('retryable')).resolves.toMatchObject({status: 'retryable'})
	}, 30_000)

	it('commits the schedule prefix that fits instead of aborting an oversized memory batch', async() => {
		const backend = createMemoryJobsBackend()
		const fillerPayload = {value: 'x'.repeat(1_040_000)}
		const schedulePayload = {value: 'y'.repeat(100_000)}
		const queued = (id: string, payload: StoredJobRun['payload'], scheduleId?: string): StoredJobRun => ({
			id, task: 'task', queue: 'default', payload, status: 'queued',
			createdAt: 0, updatedAt: 0, runAt: 1, priority: 0, attempt: 0, maxAttempts: 1,
			retryPolicy: {attempts: 1, baseDelayMs: 0}, ...(scheduleId ? {scheduleId} : {})
		})
		for (let index = 0; index < 62; index += 1) {
			await backend.runs.appendRun(queued(`large-filler-${index}`, fillerPayload))
		}
		for (let index = 0; index < 20; index += 1) {
			await backend.schedules.saveSchedule({
				id: `large-schedule-${index}`, task: 'task', kind: 'interval', intervalMs: 1_000,
				payload: schedulePayload, nextRunAt: 1,
				policy: {misfire: 'fire-once', overlap: 'allow'}
			})
		}
		let sequence = 0
		const triggered = await backend.schedules.triggerDueSchedules({
			now: 2, maxCatchUp: 1,
			createRun: (schedule, runAt) => ({
				...queued(`large-generated-${sequence++}`, schedule.payload ?? {}, schedule.id), runAt
			})
		})

		expect(triggered.length).toBeGreaterThan(0)
		expect(triggered.length).toBeLessThan(20)
		for (const run of triggered.flatMap((result) => result.runs)) {
			await expect(backend.runs.getRun(run.id)).resolves.toMatchObject({id: run.id})
		}
	}, 30_000)

	it('uses the final memory queue slot for a schedule prefix', async() => {
		const backend = createMemoryJobsBackend()
		for (let index = 0; index < 999; index += 1) {
			await backend.admin.setQueuePaused(`existing-${index}`, true)
		}
		for (const [id, queue] of [['queue-prefix-a', 'new-a'], ['queue-prefix-b', 'new-b']]) {
			await backend.schedules.saveSchedule({
				id: id!, task: 'task', queue: queue!, kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'allow'}
			})
		}
		let sequence = 0
		const triggered = await backend.schedules.triggerDueSchedules({
			now: 2, maxCatchUp: 1,
			createRun: (schedule, runAt): StoredJobRun => ({
				id: `queue-prefix-run-${sequence++}`, task: schedule.task, queue: schedule.queue!,
				payload: {}, status: 'queued', createdAt: 2, updatedAt: 2, runAt, priority: 0,
				attempt: 0, maxAttempts: 1, retryPolicy: {attempts: 1, baseDelayMs: 0},
				scheduleId: schedule.id
			})
		})

		expect(triggered.flatMap((result) => result.runs)).toHaveLength(1)
		expect(await backend.admin.getQueueStats()).toHaveLength(1_000)
		await backend.schedules.saveSchedule({
			id: 'queue-prefix-c-existing', task: 'task', queue: 'existing-1', kind: 'interval',
			intervalMs: 1_000, nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'allow'}
		})
		for (let index = 0; index < 100; index += 1) await backend.schedules.saveSchedule({
			id: `queue-prefix-b-blocked-${String(index).padStart(3, '0')}`, task: 'task',
			queue: `blocked-${index}`, kind: 'interval', intervalMs: 1_000, nextRunAt: 1,
			policy: {misfire: 'fire-once', overlap: 'allow'}
		})
		const afterSaturation = await backend.schedules.triggerDueSchedules({
			now: 3, maxCatchUp: 1,
			createRun: (schedule, runAt): StoredJobRun => ({
				id: `queue-prefix-run-${sequence++}`, task: schedule.task, queue: schedule.queue!,
				payload: {}, status: 'queued', createdAt: 3, updatedAt: 3, runAt, priority: 0,
				attempt: 0, maxAttempts: 1, retryPolicy: {attempts: 1, baseDelayMs: 0},
				scheduleId: schedule.id
			})
		})
		expect(afterSaturation.map((result) => result.schedule.id))
			.toEqual(['queue-prefix-c-existing'])
	})

	it('uses the final memory run slot for a catch-up prefix', async() => {
		const backend = createMemoryJobsBackend()
		const queued = (id: string, scheduleId?: string): StoredJobRun => ({
			id, task: 'task', queue: 'default', payload: {}, status: 'queued',
			createdAt: 0, updatedAt: 0, runAt: 1, priority: 0, attempt: 0, maxAttempts: 1,
			retryPolicy: {attempts: 1, baseDelayMs: 0}, ...(scheduleId ? {scheduleId} : {})
		})
		for (let index = 0; index < 9_999; index += 1) {
			await backend.runs.appendRun(queued(`run-capacity-${index}`))
		}
		await backend.schedules.saveSchedule({
			id: 'run-capacity-schedule', task: 'task', kind: 'interval', intervalMs: 1,
			nextRunAt: 1, policy: {misfire: 'catch-up', overlap: 'allow'}
		})
		let sequence = 0
		const triggered = await backend.schedules.triggerDueSchedules({
			now: 3, maxCatchUp: 3,
			createRun: (schedule, runAt) => ({
				...queued(`run-capacity-generated-${sequence++}`, schedule.id), runAt
			})
		})

		expect(triggered.flatMap((result) => result.runs)).toHaveLength(1)
		expect(await backend.runs.getRun('run-capacity-generated-0')).toBeDefined()
	}, 30_000)

	it('expires a dead-letter run and its sidecar atomically after retention', async() => {
		const backend = createMemoryJobsBackend()
		const queued: StoredJobRun = {
			id: 'expired-dead', task: 'task', queue: 'default', payload: {}, status: 'queued',
			createdAt: 1, updatedAt: 1, runAt: 1, priority: 0, attempt: 0, maxAttempts: 1,
			retryPolicy: {attempts: 1, baseDelayMs: 0}
		}
		await backend.runs.appendRun(queued)
		const [claimed] = await backend.runs.claimDueRuns({
			now: 2, workerId: 'worker', limit: 1, maxConcurrentRuns: 1, leaseMs: 100
		})
		const {
			leaseOwner: _leaseOwner, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt,
			lastHeartbeatAt: _lastHeartbeatAt, ...claimData
		} = claimed!
		const terminal: StoredJobRun = {
			...claimData, status: 'dead-lettered', updatedAt: 3, terminalAt: 3,
			terminalExpiresAt: 4, failureCode: 'failed'
		}
		const dead: StoredDeadLetter = {
			id: 'dead-expired', runId: terminal.id, queue: terminal.queue, task: terminal.task,
			failureCode: 'failed', attempts: terminal.attempt, failedAt: 3
		}
		expect(await backend.runs.deadLetterRun(terminal, claimed!.leaseToken!, dead)).toBe(true)
		expect(await backend.maintenance.cleanupTerminalRuns(4, 10)).toBe(1)
		await expect(backend.runs.getRun(terminal.id)).resolves.toBeUndefined()
		await expect(backend.admin.listDeadLetters()).resolves.toEqual([])
	})

	it('deduplicates enqueue and stores only sanitized terminal failure codes', async() => {
		vi.useFakeTimers()
		const backend = createMemoryJobsBackend()
		const runtime = await createCustomJobs({
			clock: createFixedClock(10), backend, pollIntervalMs: 10,
			retry: {attempts: 2, baseDelayMs: 0}
		})
		runtime.jobs.registerTask({name: 'fails'}, async() => { throw new Error('secret database detail') })
		const first = await runtime.jobs.enqueue('fails', {value: 1}, {idempotencyKey: 'same'})
		const second = await runtime.jobs.enqueue('fails', {value: 1}, {idempotencyKey: 'same'})
		expect(second).toEqual(first)
		await runtime.jobs.start()
		await vi.advanceTimersByTimeAsync(100)
		await runtime.jobs.flush().catch(() => undefined)
		const run = await backend.runs.getRun(first.runId)
		expect(run).toMatchObject({
			status: 'dead-lettered', failureCode: expect.any(String),
			terminalExpiresAt: 10 + 7 * 24 * 60 * 60 * 1_000
		})
		expect(JSON.stringify(run)).not.toContain('secret database detail')
		const dead = await runtime.admin!.listDeadLetters()
		expect(dead).toEqual([expect.objectContaining({runId: first.runId, failureCode: expect.any(String)})])
		expect(dead[0]).not.toHaveProperty('payload')
		expect(dead[0]).not.toHaveProperty('error')
		await runtime.jobs.shutdown()
	})

	it('supports delayed schedule operations and rejects replace deterministically', async() => {
		const runtime = await createCustomJobs({clock: createFixedClock(1_000), backend: createMemoryJobsBackend()})
		runtime.jobs.registerTask({name: 'scheduled'}, async() => undefined)
		await expect(runtime.jobs.upsertSchedule({
			id: 'unsafe', task: 'scheduled', kind: 'interval', intervalMs: 1_000,
			policy: {misfire: 'fire-once', overlap: 'replace' as never}
		})).rejects.toThrow('JOBS_SCHEDULE_POLICY_UNSUPPORTED')
		await runtime.jobs.upsertSchedule({
			id: 'safe', task: 'scheduled', kind: 'interval', intervalMs: 1_000,
			policy: {misfire: 'catch-up', overlap: 'queue'}
		})
		await runtime.jobs.pauseSchedule('safe')
		await runtime.jobs.resumeSchedule('safe')
		expect(await runtime.admin!.listSchedules()).toEqual([
			expect.objectContaining({id: 'safe', nextRunAt: expect.any(Number)})
		])
		await runtime.jobs.deleteSchedule('safe')
		await runtime.jobs.shutdown()
	})

	it('does not let queue-overlap schedules with live runs starve later due schedules', async() => {
		const backend = createMemoryJobsBackend()
		for (let index = 0; index < 100; index += 1) {
			const id = `blocked-${String(index).padStart(3, '0')}`
			await backend.schedules.saveSchedule({
				id, task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'queue'}
			})
			await backend.runs.appendRun({
				id: `active-${id}`, task: 'task', queue: 'default', payload: {}, status: 'queued',
				createdAt: 0, updatedAt: 0, runAt: 0, priority: 1, attempt: 0, maxAttempts: 1,
				retryPolicy: {attempts: 1, baseDelayMs: 0}, scheduleId: id
			})
		}
		await backend.schedules.saveSchedule({
			id: 'target', task: 'task', kind: 'interval', intervalMs: 1_000,
			nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'queue'}
		})
		await backend.runs.claimDueRuns({
			now: 1, workerId: 'worker', limit: 100, maxConcurrentRuns: 100, leaseMs: 1_000
		})
		const triggered = await backend.schedules.triggerDueSchedules({
			now: 2, maxCatchUp: 10,
			createRun: (schedule, runAt): StoredJobRun => ({
				id: `generated-${schedule.id}`, task: schedule.task, queue: schedule.queue ?? 'default',
				payload: {}, status: 'queued', createdAt: 2, updatedAt: 2, runAt, priority: 0,
				attempt: 0, maxAttempts: 1, retryPolicy: {attempts: 1, baseDelayMs: 0},
				scheduleId: schedule.id
			})
		})

		expect(triggered.flatMap((item) => item.runs).map((run) => run.id)).toEqual(['generated-target'])
	})

	it('drains multiple retention batches during one maintenance interval', async() => {
		const memory = createMemoryJobsBackend()
		const cleanupTerminalRuns = vi.fn()
			.mockResolvedValueOnce(100)
			.mockResolvedValueOnce(60)
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(0)
		const backend = {
			...memory,
			maintenance: {...memory.maintenance, cleanupTerminalRuns}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(1), backend})

		await runtime.jobs.start()

		expect(cleanupTerminalRuns).toHaveBeenCalledTimes(4)
		expect(cleanupTerminalRuns).toHaveBeenNthCalledWith(1, 1, 100)
		await runtime.jobs.shutdown()
	})

	it('treats normal polling lateness as on-time for skip-misfire schedules', async() => {
		const backend = createMemoryJobsBackend()
		await backend.schedules.saveSchedule({
			id: 'skip-grace', task: 'task', kind: 'interval', intervalMs: 1_000, nextRunAt: 1_000,
			policy: {misfire: 'skip', overlap: 'allow'}
		})
		let sequence = 0
		const trigger = (now: number) => backend.schedules.triggerDueSchedules({
			now, maxCatchUp: 10, misfireGraceMs: 250,
			createRun: (schedule, runAt): StoredJobRun => ({
				id: `skip-run-${sequence++}`, task: schedule.task, queue: schedule.queue ?? 'default',
				payload: {}, status: 'queued', createdAt: now, updatedAt: now, runAt, priority: 0,
				attempt: 0, maxAttempts: 1, retryPolicy: {attempts: 1, baseDelayMs: 0},
				scheduleId: schedule.id
			})
		})

		expect((await trigger(1_100)).flatMap((item) => item.triggerTimes)).toEqual([1_000])
		expect((await trigger(3_000)).flatMap((item) => item.triggerTimes)).toEqual([])
	})

	it('exposes the complete bounded dead-letter population without pagination', async() => {
		const memory = createMemoryJobsBackend()
		const records = Array.from({length: 10_000}, (_, index): StoredDeadLetter => ({
			id: `dead-${index}`, runId: `run-${index}`, queue: 'default', task: 'task',
			failureCode: 'task_failed', attempts: 1, failedAt: index
		}))
		const backend = {
			...memory,
			admin: {...memory.admin!, async listDeadLetters() { return records }}
		}
		const runtime = await createCustomJobs({clock: createFixedClock(1), backend})

		await expect(runtime.admin!.listDeadLetters()).resolves.toHaveLength(10_000)
		await runtime.jobs.shutdown()
	})

	it('bounds custom catch-up and rejects unsupported preset policy', async() => {
		await expect(createCustomJobs({
			clock: createFixedClock(0), backend: createMemoryJobsBackend(), maxCatchUp: 101
		})).rejects.toThrow('maxCatchUp')
	})

	it('requires operator migration for persisted replace schedules', () => {
		expect(() => parseLegacyJobsState(1, JSON.stringify({
			runs: {}, deadLetters: {}, idempotency: {}, queuePaused: [],
			schedules: {
				legacy: {
					id: 'legacy', task: 'task', kind: 'interval', intervalMs: 1_000,
					policy: {misfire: 'fire-once', overlap: 'replace'}
				}
			}
		}))).toThrow('JOBS_SCHEDULE_POLICY_UNSUPPORTED')
	})
})
