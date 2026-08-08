import {isDeepStrictEqual} from 'node:util'

import type {JobPayload, ScheduleDefinition, TaskDefinition} from '@ooopsstudio/core/contracts/jobs'
import type {ManagedJobs, RegisteredTaskHandler} from '@ooopsstudio/core/ports/jobs'

import type {StoredSchedule} from '../types/backend'
import {getNextScheduleTime} from '../utils/cron'

import type {JobsKernelContext} from './handler-context'
import {
	addJobsDuration,
	clone,
	isTerminal,
	payloadChecksum,
	requireBackendBoolean,
	snapshotJobPayload,
	snapshotStableRecord,
	validateCancelReason,
	validateEnqueueOptions,
	validateResourceId,
	validateStoredJobRun,
	validateTaskDefinition
} from './handler-helpers'
import {toPublicRun} from './handler-projections'
import {snapshotScheduleDefinition, validateStoredSchedule} from './handler-schedule-validation'

type QueueApi = Pick<ManagedJobs,
	'registerTask' | 'enqueue' | 'upsertSchedule' | 'pauseSchedule' | 'resumeSchedule' |
	'deleteSchedule' | 'getRun' | 'cancelRun'>

export function createJobsQueueApi(context: JobsKernelContext): {
	api: QueueApi
} {
	const scheduleDefinitionIdentity = (schedule: ScheduleDefinition | StoredSchedule) => {
		const {nextRunAt: _nextRunAt, lastTriggeredAt: _lastTriggeredAt, ...definition} = schedule as StoredSchedule
		return definition
	}
	const resolvePolicy = (definition: ScheduleDefinition): ScheduleDefinition => {
		const policy = definition.policy ?? context.options.schedulePolicy.defaults
		if (!context.options.schedulePolicy.misfire.includes(policy.misfire)) throw new Error(`Unsupported jobs misfire policy: ${policy.misfire}`)
		if (!context.options.schedulePolicy.overlap.includes(policy.overlap)) throw new Error(`Unsupported jobs overlap policy: ${policy.overlap}`)
		return {...clone(definition), policy: {...policy}}
	}
	const api: QueueApi = {
		registerTask(definition: TaskDefinition, handler: RegisteredTaskHandler): void {
			context.ensureActive('register tasks')
			if (context.control.registrationClosed || context.control.started) {
				throw new Error('Jobs tasks can only be registered before start')
			}
			const snapshotDefinition = snapshotStableRecord<TaskDefinition>(
				definition,
				'Task definition',
				new Set(['name', 'queue', 'priority', 'concurrency', 'timeoutMs'])
			)
			validateTaskDefinition(snapshotDefinition)
			if (typeof handler !== 'function') throw new Error('Task handler must be a function')
			if (context.tasks.has(snapshotDefinition.name)) throw new Error(`Task already registered: ${snapshotDefinition.name}`)
			if (context.tasks.size >= 1_000) throw new Error('Jobs task registration limit exceeded')
			context.tasks.set(snapshotDefinition.name, {definition: snapshotDefinition, handler})
		},
		async enqueue(task: string, payload: JobPayload = {}, options = {}) {
			context.ensureActive('enqueue runs')
			const snapshotPayload = snapshotJobPayload(payload)
			const snapshotOptions = snapshotStableRecord<typeof options>(
				options,
				'Job enqueue options',
				new Set(['queue', 'runAt', 'priority', 'idempotencyKey'])
			)
			validateEnqueueOptions(snapshotOptions)
			return context.withProducerSpan('jobs.enqueue', {task, queue: snapshotOptions.queue ?? 'default'}, async() => {
				const run = context.createRun(task, snapshotPayload, snapshotOptions)
				const key = run.idempotencyKey
				const payloadHash = payloadChecksum(run.payload)
				const checksum = run.idempotencyChecksum ?? payloadHash
				const idempotency = key ? {
					key, checksum, expiresAt: run.idempotencyExpiresAt as number
				} : undefined
				let appended: Awaited<ReturnType<typeof context.options.backend.appendRun>>
				try {
					appended = await context.options.backend.appendRun(run, idempotency)
				} catch(error) {
					let recovered
					try { recovered = await context.options.backend.getRun(run.id) } catch(recoveryError) {
						throw new AggregateError([error, recoveryError], 'Jobs enqueue recovery failed')
					}
					if (recovered) appended = {run: recovered, existing: false}
					else if (idempotency) {
						try { appended = await context.options.backend.appendRun(run, idempotency) } catch {
							throw error
						}
					} else throw error
				}
				if (!appended || typeof appended !== 'object'
					|| typeof appended.existing !== 'boolean'
					|| !appended.run || typeof appended.run !== 'object') {
					// A remote adapter may represent a lost success response as an empty
					// or structurally incomplete value instead of throwing. Reconcile the
					// exact generated UUID before reporting failure: a caller retry without
					// an idempotency key would otherwise create a duplicate durable run.
					const recovered = await context.options.backend.getRun(run.id)
					if (recovered) appended = {run: recovered, existing: false}
				}
				if (!appended || typeof appended !== 'object' || typeof appended.existing !== 'boolean') throw new Error('Jobs backend returned an invalid append result')
				validateStoredJobRun(appended.run)
				if (appended.run.task !== run.task || payloadChecksum(appended.run.payload) !== payloadHash
					|| appended.run.queue !== run.queue || appended.run.priority !== run.priority
					|| (snapshotOptions.runAt !== undefined && appended.run.runAt !== snapshotOptions.runAt)
					|| (!appended.existing && !isDeepStrictEqual(appended.run, run))
					|| (appended.existing && !key)
					|| (key && (appended.run.idempotencyKey !== key
						|| appended.run.idempotencyChecksum !== checksum
						|| appended.run.idempotencyExpiresAt === undefined
						|| appended.run.idempotencyExpiresAt <= run.createdAt))) {
					throw new Error('Jobs backend returned an inconsistent append result')
				}
				context.telemetry.emit({kind: 'enqueued', result: appended.existing ? 'deduplicated' : 'success'})
				return {runId: appended.run.id}
			})
		},
		async upsertSchedule(definition) {
			context.ensureActive('upsert schedules')
			const snapshotDefinition = snapshotScheduleDefinition(definition)
			if (!context.tasks.has(snapshotDefinition.task)) throw new Error(`Task not registered: ${snapshotDefinition.task}`)
			const normalized = resolvePolicy(snapshotDefinition)
			const desiredDefinition = {...normalized, enabled: normalized.enabled !== false}
			let preserveObservedProgress = false
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const existing = await context.options.backend.getSchedule(desiredDefinition.id)
				if (existing) {
					validateStoredSchedule(existing)
					if (isDeepStrictEqual(scheduleDefinitionIdentity(existing), desiredDefinition)) {
						return {scheduleId: desiredDefinition.id}
					}
				}
				let nextRunAt = getNextScheduleTime(desiredDefinition, context.now(), true)
				if (preserveObservedProgress && existing?.nextRunAt !== undefined
					&& (nextRunAt === undefined || nextRunAt < existing.nextRunAt)) {
					nextRunAt = existing.nextRunAt
				}
				const schedule = {...desiredDefinition, nextRunAt}
				try {
					if (await context.options.backend.saveSchedule(schedule, existing ?? null)) {
						return {scheduleId: schedule.id}
					}
				} catch(error) {
					let confirmed: StoredSchedule | undefined
					try { confirmed = await context.options.backend.getSchedule(schedule.id) } catch(recoveryError) {
						throw new AggregateError([error, recoveryError], 'Jobs schedule upsert recovery failed')
					}
					if (confirmed) validateStoredSchedule(confirmed)
					if (confirmed && isDeepStrictEqual(confirmed, schedule)) {
						return {scheduleId: schedule.id}
					}
					preserveObservedProgress = true
					continue
				}
				preserveObservedProgress = true
			}
			throw new Error('Jobs schedule changed repeatedly while upserting')
		},
		async pauseSchedule(id) {
			context.ensureActive('pause schedules')
			validateResourceId(id, 'schedule id')
			requireBackendBoolean(await context.options.backend.setScheduleEnabled(id, false), 'schedule state')
		},
		async resumeSchedule(id) {
			context.ensureActive('resume schedules')
			validateResourceId(id, 'schedule id')
			for (let attempt = 0; attempt < 3; attempt++) {
				const schedule = await context.options.backend.getSchedule(id); if (!schedule) return
				validateStoredSchedule(schedule)
				if (schedule.enabled !== false) return
				const nextRunAt = getNextScheduleTime(schedule, context.now())
				if (requireBackendBoolean(
					await context.options.backend.setScheduleEnabled(id, true, nextRunAt, schedule), 'schedule state'
				)) return
			}
			throw new Error('Jobs schedule changed repeatedly while resuming')
		},
		async deleteSchedule(id) {
			context.ensureActive('delete schedules')
			validateResourceId(id, 'schedule id')
			await context.options.backend.deleteSchedule(id)
		},
		async getRun(id) { context.ensureActive('read runs'); validateResourceId(id, 'run id'); const run = await context.options.backend.getRun(id); if (run) validateStoredJobRun(run); return run ? toPublicRun(run) : undefined },
		async cancelRun(id, reason) {
			context.ensureActive('cancel runs')
			validateResourceId(id, 'run id')
			validateCancelReason(reason)
			const applyLocalCancellation = (): void => {
				context.rememberCancellation(id)
				const controller = context.state.activeControllers.get(id)
				if (controller) {
					context.state.locallyCancelledActiveRunIds.add(id)
					controller.abort(new Error(reason ?? 'Run cancelled'))
				}
			}
			for (let attempt = 0; attempt < 3; attempt++) {
				const run = await context.options.backend.getRun(id)
				if (!run) return
				validateStoredJobRun(run)
				if (isTerminal(run)) {
					if (run.status === 'cancelled') applyLocalCancellation()
					return
				}
				const now = context.now()
				const expiresAt = context.options.terminalRetentionMs === undefined
					? undefined : addJobsDuration(now, context.options.terminalRetentionMs, 'Jobs terminal expiry')
				let cancelled: unknown
				try {
					cancelled = await context.options.backend.cancelRun(id, reason, run.leaseToken, now, expiresAt)
				} catch(error) {
					const confirmed = await context.options.backend.getRun(id).catch(() => undefined)
					if (confirmed) validateStoredJobRun(confirmed)
					if (confirmed?.status === 'cancelled') { applyLocalCancellation(); return }
					throw error
				}
				if (requireBackendBoolean(cancelled, 'cancellation')) {
					applyLocalCancellation()
					return
				}
			}
			throw new Error('Jobs run changed repeatedly while cancelling')
		}
	}
	return {api}
}
