import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

import type {JobsAdminPort, ManagedJobs} from '@ooopsstudio/core/ports/jobs'

import type {StoredSchedule} from '../types/backend'

import {validateJobsCollectionSize} from './handler-collection-limits'
import type {JobsKernelContext} from './handler-context'
import {validateDeadLetterRecord} from './handler-dead-letter-validation'
import {clone, enqueueRequestChecksum, idempotencyStorageKey, isTerminal, validateQueueName, validateQueueStats, validateResourceId, validateStoredJobRun} from './handler-helpers'
import {toPublicRun} from './handler-projections'
import {snapshotRunQuery, snapshotScheduleQuery} from './handler-query-helpers'
import {validateStoredSchedule} from './handler-schedule-validation'

export function createJobsAdminPort(
	context: JobsKernelContext,
	enqueue: ManagedJobs['enqueue']
): JobsAdminPort {
	const backend = context.options.backend.admin
	if (!backend) throw new Error('Jobs admin capability is unavailable')
	return {
		async listRuns(query) {
			context.ensureActive('list runs')
			const snapshot = snapshotRunQuery(query); const maximum = Math.min(1_000, snapshot?.limit ?? 100)
			const records = await backend.listRuns({...snapshot, limit: maximum})
			if (!Array.isArray(records) || records.length > maximum) throw new Error('Jobs backend returned an invalid run listing')
			for (const record of records) validateStoredJobRun(record)
			if (new Set(records.map((record) => record.id)).size !== records.length) {
				throw new Error('Jobs backend returned duplicate runs')
			}
			validateJobsCollectionSize(records, 'run listing')
			return records.map(toPublicRun)
		},
		async listSchedules(query) {
			context.ensureActive('list schedules')
			const snapshot = snapshotScheduleQuery(query); const maximum = Math.min(1_000, snapshot?.limit ?? 100)
			const records = await backend.listSchedules({...snapshot, limit: maximum})
			if (!Array.isArray(records) || records.length > maximum) throw new Error('Jobs backend returned an invalid schedule listing')
			for (const record of records) validateStoredSchedule(record)
			if (new Set(records.map((record) => record.id)).size !== records.length) {
				throw new Error('Jobs backend returned duplicate schedules')
			}
			validateJobsCollectionSize(records, 'schedule listing')
			return clone(records).map((record) => ({...record}))
		},
		async listDeadLetters() {
			context.ensureActive('list dead letters')
			const records = await backend.listDeadLetters(10_000)
			if (!Array.isArray(records) || records.length > 10_000) throw new Error('Jobs backend returned an invalid dead-letter listing')
			for (const record of records) validateDeadLetterRecord(record)
			if (new Set(records.map((record) => record.id)).size !== records.length) {
				throw new Error('Jobs backend returned duplicate dead letters')
			}
			validateJobsCollectionSize(records, 'dead-letter listing')
			return records.map((record) => Object.freeze({
				id: record.id, runId: record.runId, queue: record.queue, task: record.task,
				failureCode: record.failureCode ?? record.reason ?? record.error ?? 'JOB_FAILED',
				attempts: record.attempts, failedAt: record.failedAt
			}))
		},
		async getQueueStats(queue) {
			context.ensureActive('read queue stats')
			if (queue !== undefined) validateQueueName(queue)
			const stats = await backend.getQueueStats(queue, context.now())
			if (!Array.isArray(stats) || stats.length > 1_000) throw new Error('Jobs backend returned invalid queue stats')
			for (const item of stats) validateQueueStats(item)
			if (new Set(stats.map((item) => item.queue)).size !== stats.length) {
				throw new Error('Jobs backend returned duplicate queue stats')
			}
			return clone(stats)
		},
		async pauseQueue(queue) { context.ensureActive('pause queues'); validateQueueName(queue); await backend.setQueuePaused(queue, true) },
		async resumeQueue(queue) { context.ensureActive('resume queues'); validateQueueName(queue); await backend.setQueuePaused(queue, false) },
		async retryRun(runId) {
			context.ensureActive('retry runs')
			validateResourceId(runId, 'run id')
			const run = await context.options.backend.getRun(runId)
			if (run) validateStoredJobRun(run)
			if (!run || !isTerminal(run) || run.status === 'completed' || run.status === 'dead-lettered') throw new Error(`Run ${runId} cannot be retried`)
			const idempotencyKey = `admin-retry:${createHash('sha256').update(run.id).digest('hex')}`
			return enqueue(run.task, run.payload, {
				queue: run.queue,
				priority: run.priority,
				idempotencyKey
			})
		},
		async requeueDeadLetter(id) {
			context.ensureActive('requeue dead letters')
			validateResourceId(id, 'dead-letter id')
			return context.withProducerSpan('jobs.dead_letter.requeue', {deadLetterId: id}, async() => {
				const operationHash = createHash('sha256').update(id).digest('hex')
				const replacementRunId = `dead-requeue-${operationHash}`
				const dead = await backend.getDeadLetter(id)
				if (!dead) {
					// The atomic backend mutation may have committed while its response was
					// lost. Recover the deterministic replacement instead of replaying the
					// consumed dead letter or guessing from untrusted metadata.
					const recovered = await context.options.backend.getRun(replacementRunId)
					if (recovered) {
						validateStoredJobRun(recovered)
						const expectedIdempotencyKey = idempotencyStorageKey(
							context.options.namespace ?? 'jobs', recovered.task, `dead-letter:${operationHash}`
						)
						if (recovered.id !== replacementRunId
							|| recovered.idempotencyKey !== expectedIdempotencyKey
							|| recovered.idempotencyChecksum !== enqueueRequestChecksum(
								recovered.payload, recovered.queue, recovered.priority
							)) {
							throw new Error('Jobs backend returned an inconsistent dead-letter requeue recovery')
						}
						return {runId: recovered.id}
					}
					throw new Error(`Dead letter not found: ${id}`)
				}
				validateDeadLetterRecord(dead)
				const idempotencyKey = `dead-letter:${operationHash}`
				const run = context.createRun(dead.task, dead.payload ?? {}, {queue: dead.queue, idempotencyKey})
				run.id = replacementRunId
				const stored = await backend.requeueDeadLetter(id, run, {
					key: run.idempotencyKey as string,
					checksum: run.idempotencyChecksum as string,
					expiresAt: run.idempotencyExpiresAt as number
				})
				if (!stored) throw new Error(`Dead letter not found: ${id}`)
				validateStoredJobRun(stored)
				if (!isDeepStrictEqual(stored, run)) {
					throw new Error('Jobs backend returned an inconsistent dead-letter requeue result')
				}
				return {runId: stored.id}
			})
		},
		async triggerScheduleNow(id) {
			context.ensureActive('trigger schedules')
			validateResourceId(id, 'schedule id')
			let sourceSchedule: StoredSchedule | undefined
			let generatedRun: ReturnType<JobsKernelContext['createRun']> | undefined
			let factoryCalls = 0
			let runs: Awaited<ReturnType<typeof backend.triggerScheduleNow>>
			try {
				runs = await context.withProducerSpan('jobs.schedule.trigger', {scheduleId: id}, async() => backend.triggerScheduleNow(id, (schedule) => {
					validateStoredSchedule(schedule)
					if (++factoryCalls > 1 || schedule.id !== id) {
						throw new Error('Jobs backend supplied an inconsistent manual schedule')
					}
					sourceSchedule = clone(schedule)
					generatedRun = context.createRun(schedule.task, schedule.payload ?? {}, {
						queue: schedule.queue,
						scheduleId: id
					})
					return clone(generatedRun)
				}))
			} catch(error) {
				// A remote transaction may commit the generated run and lose only its
				// response. The admin API has no idempotency key, so recover the exact
				// UUID produced for this attempt before allowing a caller to retry.
				if (!generatedRun) throw error
				let recovered
				try { recovered = await context.options.backend.getRun(generatedRun.id) } catch(recoveryError) {
					throw new AggregateError([error, recoveryError], 'Jobs manual schedule trigger recovery failed')
				}
				if (!recovered) throw error
				runs = [recovered]
			}
			if (generatedRun && (!Array.isArray(runs) || runs.length === 0)) {
				// Some remote adapters represent a lost success response as an empty
				// result instead of an exception. Reconcile the exact generated UUID
				// before reporting failure, which would invite a duplicate operator retry.
				const recovered = await context.options.backend.getRun(generatedRun.id)
				if (recovered) runs = [recovered]
			}
			if (!Array.isArray(runs) || runs.length > 1) throw new Error('Jobs backend returned an invalid manual schedule trigger result')
			if ((factoryCalls === 0) !== (runs.length === 0)) {
				throw new Error('Jobs backend returned an inconsistent manual schedule trigger result')
			}
			for (const run of runs) {
				validateStoredJobRun(run)
				if (!sourceSchedule || !generatedRun || !isDeepStrictEqual(run, generatedRun)
					|| run.scheduleId !== id || run.task !== sourceSchedule.task
					|| run.queue !== (sourceSchedule.queue
						?? context.tasks.get(sourceSchedule.task)?.definition.queue
						?? context.options.defaultQueue ?? 'default')) {
					throw new Error('Jobs backend returned an inconsistent manual schedule trigger result')
				}
			}
			return runs.map((run) => ({runId: run.id}))
		}
	}
}
