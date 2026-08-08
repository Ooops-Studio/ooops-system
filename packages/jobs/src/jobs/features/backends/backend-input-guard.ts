
import {validateDeadLetterRecord} from '../../core/handler-dead-letter-validation'
import {clone, MAX_JOBS_TIMESTAMP, validateQueueName, validateResourceId, validateScheduledRun, validateStoredJobRun} from '../../core/handler-helpers'
import {snapshotRunQuery, snapshotScheduleQuery} from '../../core/handler-query-helpers'
import {validateStoredSchedule} from '../../core/handler-schedule-validation'
import type {
	FlatJobsBackendRuntime,
	JobsAdminStore,
	JobsBackend,
	JobsBackendRuntime
} from '../../types/backend'

import {
	decodeProviderBoolean,
	validateAppendInput,
	validateCancelMutation,
	validateClaimRelease,
	validateClaimRequest,
	validateCleanupRequest,
	validateDeadLetterLimit,
	validateLeaseMutation,
	validateQueueStatsRequest,
	validateRecoveryRequest,
	validateScheduleInput,
	snapshotProviderData,
	validateTransitionInput,
	validateTriggeredSchedulePolicy,
	validateTriggerRequest
} from './backend-validation'

const guardedBackends = new WeakSet<object>()

function snapshotBackendInput<T>(value: T, label: string): T {
	try { return snapshotProviderData(value, label) } catch {
		throw new Error(`Jobs backend received unstable ${label}`)
	}
}

const BACKEND_OPERATIONS: ReadonlyArray<keyof FlatJobsBackendRuntime> = [
	'appendRun', 'getRun', 'listRuns', 'claimDueRuns', 'releaseClaim', 'renewLease',
	'completeRun', 'markRunRetryable', 'deadLetterRun', 'cancelRun', 'recoverStaleLeases',
	'saveSchedule', 'setScheduleEnabled', 'getSchedule', 'listSchedules', 'deleteSchedule',
	'triggerDueSchedules', 'setQueuePaused', 'listDeadLetters', 'getDeadLetter',
	'requeueDeadLetter', 'triggerScheduleNow',
	'getQueueStats', 'cleanupTerminalRuns'
]

function readBackendDataProperty(backend: object, key: PropertyKey): unknown {
	let current: object | null = backend
	try {
		for (let depth = 0; current && depth < 32; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) {
				if (!('value' in descriptor)) throw new Error('accessor')
				return descriptor.value
			}
			current = Object.getPrototypeOf(current)
		}
	} catch { throw new Error('Jobs scheduler requires a stable backend adapter') }
	return undefined
}

function snapshotFlatJobsBackendOperations(backend: unknown): FlatJobsBackendRuntime {
	if (!backend || (typeof backend !== 'object' && typeof backend !== 'function')) {
		throw new Error('Jobs scheduler requires a valid backend adapter')
	}
	const source = backend as object
	const durability = readBackendDataProperty(source, 'durability')
	if (durability !== 'ephemeral' && durability !== 'durable') {
		throw new Error('Jobs scheduler requires a valid backend adapter')
	}
	const snapshot: Record<string, unknown> = {durability}
	for (const operation of BACKEND_OPERATIONS) {
		const method = readBackendDataProperty(source, operation)
		if (typeof method !== 'function') throw new Error('Jobs scheduler requires a complete operation-based backend')
		snapshot[operation] = (...arguments_: unknown[]) => Reflect.apply(method, backend, arguments_)
	}
	return snapshot as unknown as FlatJobsBackendRuntime
}

/** Snapshots and validates every mutable backend input before provider work can await. */
function guardFlatJobsBackendInputs(backend: FlatJobsBackendRuntime): FlatJobsBackendRuntime {
	if (guardedBackends.has(backend)) return backend
	const provider = snapshotFlatJobsBackendOperations(backend)
	const guarded: FlatJobsBackendRuntime = {
		durability: provider.durability,
		async appendRun(run, idempotency) {
			const safeRun = snapshotBackendInput(run, 'append run')
			const safeIdempotency = idempotency === undefined
				? undefined : snapshotBackendInput(idempotency, 'append idempotency')
			validateAppendInput(safeRun, safeIdempotency)
			return snapshotProviderData(
				await provider.appendRun(safeRun, safeIdempotency),
				'append result'
			)
		},
		async getRun(id) {
			validateResourceId(id, 'run id')
			const run = snapshotProviderData(await provider.getRun(id), 'run lookup')
			if (run) { validateStoredJobRun(run); if (run.id !== id) throw new Error('Jobs backend returned an inconsistent run lookup') }
			return run
		},
		async listRuns(query) {
			const snapshot = snapshotRunQuery(query)
			return snapshotProviderData(await provider.listRuns(
				snapshot
			), 'run listing')
		},
		async claimDueRuns(request) {
			const safeRequest = snapshotBackendInput(request, 'claim request')
			validateClaimRequest(safeRequest)
			return snapshotProviderData(await provider.claimDueRuns(safeRequest), 'claim batch')
		},
		releaseClaim(id, token, now) {
			validateClaimRelease(id, token, now)
			return provider.releaseClaim(id, token, now)
		},
		renewLease(id, token, expiresAt, now) {
			validateLeaseMutation(id, token, expiresAt, now)
			return provider.renewLease(id, token, expiresAt, now)
		},
		completeRun(run, token) {
			const safeRun = snapshotBackendInput(run, 'completion run')
			validateResourceId(token, 'lease token'); validateTransitionInput(safeRun, 'completed')
			return provider.completeRun(safeRun, token)
		},
		markRunRetryable(run, token) {
			const safeRun = snapshotBackendInput(run, 'retry run')
			validateResourceId(token, 'lease token'); validateTransitionInput(safeRun, 'retryable')
			return provider.markRunRetryable(safeRun, token)
		},
		deadLetterRun(run, token, dead) {
			const safeRun = snapshotBackendInput(run, 'dead-letter run')
			const safeDead = snapshotBackendInput(dead, 'dead-letter record')
			validateResourceId(token, 'lease token'); validateTransitionInput(safeRun, 'dead-lettered', safeDead)
			return provider.deadLetterRun(safeRun, token, safeDead)
		},
		cancelRun(id, reason, token, now, terminalExpiresAt) {
			validateCancelMutation(id, reason, token, now, terminalExpiresAt)
			return provider.cancelRun(id, reason, token, now, terminalExpiresAt)
		},
		recoverStaleLeases(now, recoveryAfterMs, terminalExpiresAt) {
			validateRecoveryRequest(now, recoveryAfterMs, terminalExpiresAt)
			return provider.recoverStaleLeases(now, recoveryAfterMs, terminalExpiresAt)
		},
		async saveSchedule(schedule, expected) {
			const safeSchedule = snapshotBackendInput(schedule, 'schedule')
			validateScheduleInput(safeSchedule)
			const safeExpected = expected === undefined || expected === null
				? expected : snapshotBackendInput(expected, 'expected schedule')
			if (safeExpected) validateScheduleInput(safeExpected)
			return decodeProviderBoolean(
				await provider.saveSchedule(safeSchedule, safeExpected), 'schedule save result'
			)
		},
		setScheduleEnabled(id, enabled, nextRunAt, expected) {
			validateResourceId(id, 'schedule id')
			if (typeof enabled !== 'boolean' || (nextRunAt !== undefined
				&& (!Number.isSafeInteger(nextRunAt) || nextRunAt < 0 || nextRunAt > MAX_JOBS_TIMESTAMP))) {
				throw new Error('Jobs backend received an invalid schedule state mutation')
			}
			const safeExpected = expected === undefined
				? undefined : snapshotBackendInput(expected, 'expected schedule')
			if (safeExpected) validateScheduleInput(safeExpected)
			return provider.setScheduleEnabled(id, enabled, nextRunAt, safeExpected)
		},
		async getSchedule(id) {
			validateResourceId(id, 'schedule id')
			const schedule = snapshotProviderData(await provider.getSchedule(id), 'schedule lookup')
			if (schedule) {
				validateStoredSchedule(schedule)
				if (schedule.id !== id) throw new Error('Jobs backend returned an inconsistent schedule lookup')
			}
			return schedule
		},
		async listSchedules(query) {
			const snapshot = snapshotScheduleQuery(query)
			return snapshotProviderData(await provider.listSchedules(snapshot), 'schedule listing')
		},
		deleteSchedule(id) { validateResourceId(id, 'schedule id'); return provider.deleteSchedule(id) },
		async triggerDueSchedules(request) {
			const safeRequest = snapshotBackendInput(request, 'schedule trigger request')
			validateTriggerRequest(safeRequest)
			const createRun = safeRequest.createRun
			return snapshotProviderData(await provider.triggerDueSchedules({
				...safeRequest,
				createRun: (schedule, triggerTime) => {
					const safeSchedule = snapshotProviderData(schedule, 'schedule trigger input')
					validateStoredSchedule(safeSchedule)
					if (safeRequest.allowedTasks && !safeRequest.allowedTasks.includes(safeSchedule.task)) {
						throw new Error('Jobs backend supplied a schedule outside the allowed tasks')
					}
					validateTriggeredSchedulePolicy(safeSchedule, safeRequest)
					if (!Number.isSafeInteger(triggerTime) || triggerTime < 0 || triggerTime > MAX_JOBS_TIMESTAMP) {
						throw new Error('Jobs backend supplied an invalid schedule trigger time')
					}
					const run = createRun(clone(safeSchedule), triggerTime)
					validateScheduledRun(run, safeSchedule, triggerTime)
					return clone(run)
				}
			}), 'schedule trigger result')
		},
		setQueuePaused(queue, paused) {
			validateQueueName(queue)
			if (typeof paused !== 'boolean') throw new Error('Jobs backend received an invalid queue pause state')
			return provider.setQueuePaused(queue, paused)
		},
		async listDeadLetters(limit = 1_000) {
			validateDeadLetterLimit(limit)
			return snapshotProviderData(await provider.listDeadLetters(limit), 'dead-letter listing')
		},
		async getDeadLetter(id) {
			validateResourceId(id, 'dead-letter id')
			const dead = snapshotProviderData(await provider.getDeadLetter(id), 'dead-letter lookup')
			if (dead) {
				validateDeadLetterRecord(dead)
				if (dead.id !== id) throw new Error('Jobs backend returned an inconsistent dead-letter lookup')
			}
			return dead
		},
		async requeueDeadLetter(id, run, idempotency) {
			const safeRun = snapshotBackendInput(run, 'dead-letter requeue run')
			const safeIdempotency = idempotency === undefined
				? undefined : snapshotBackendInput(idempotency, 'dead-letter requeue idempotency')
			validateResourceId(id, 'dead-letter id'); validateAppendInput(safeRun, safeIdempotency)
			return snapshotProviderData(await provider.requeueDeadLetter(
				id, safeRun, safeIdempotency
			), 'dead-letter requeue result')
		},
		async triggerScheduleNow(id, createRun) {
			validateResourceId(id, 'schedule id')
			if (typeof createRun !== 'function') throw new Error('Jobs backend requires a schedule run factory')
			return snapshotProviderData(await provider.triggerScheduleNow(id, (schedule) => {
				const safeSchedule = snapshotProviderData(schedule, 'manual schedule input')
				validateStoredSchedule(safeSchedule)
				if (safeSchedule.id !== id) throw new Error('Jobs backend supplied an inconsistent manual schedule')
				const run = createRun(clone(safeSchedule))
				validateScheduledRun(run, safeSchedule, run.runAt)
				return clone(run)
			}), 'manual schedule trigger result')
		},
		async getQueueStats(queue, now) {
			validateQueueStatsRequest(queue, now)
			return snapshotProviderData(await provider.getQueueStats(queue, now), 'queue stats')
		},
		cleanupTerminalRuns(now, limit) {
			validateCleanupRequest(now, limit); return provider.cleanupTerminalRuns(now, limit)
		}
	}
	guardedBackends.add(guarded)
	return guarded
}

const RUN_KEYS = [
	'appendRun', 'getRun', 'claimDueRuns', 'releaseClaim', 'renewLease', 'completeRun',
	'markRunRetryable', 'deadLetterRun', 'cancelRun', 'recoverStaleLeases'
] as const
const SCHEDULE_KEYS = [
	'saveSchedule', 'setScheduleEnabled', 'getSchedule', 'deleteSchedule', 'triggerDueSchedules'
] as const
const ADMIN_KEYS = [
	'listRuns', 'listSchedules', 'setQueuePaused', 'listDeadLetters', 'getDeadLetter',
	'requeueDeadLetter', 'triggerScheduleNow', 'getQueueStats'
] as const

function projectMethods(source: object, keys: readonly string[]): Record<string, unknown> {
	const projected: Record<string, unknown> = {}
	for (const key of keys) {
		const method = readBackendDataProperty(source, key)
		if (typeof method !== 'function') throw new Error('Jobs scheduler requires a complete operation-based backend')
		projected[key] = (...arguments_: unknown[]) => Reflect.apply(method, source, arguments_)
	}
	return projected
}

export function composeJobsBackend(backend: FlatJobsBackendRuntime): JobsBackend {
	const guarded = guardFlatJobsBackendInputs(backend)
	return Object.freeze({
		durability: guarded.durability,
		runs: Object.freeze(projectMethods(guarded, RUN_KEYS)),
		schedules: Object.freeze(projectMethods(guarded, SCHEDULE_KEYS)),
		maintenance: Object.freeze(projectMethods(guarded, ['cleanupTerminalRuns'])),
		admin: Object.freeze(projectMethods(guarded, ADMIN_KEYS)) as unknown as JobsAdminStore
	}) as unknown as JobsBackend
}

export function snapshotJobsBackendOperations(backend: unknown): JobsBackendRuntime {
	if (!backend || (typeof backend !== 'object' && typeof backend !== 'function')) {
		throw new Error('Jobs scheduler requires a valid backend adapter')
	}
	const source = backend as object
	const durability = readBackendDataProperty(source, 'durability')
	const runs = readBackendDataProperty(source, 'runs')
	const schedules = readBackendDataProperty(source, 'schedules')
	const maintenance = readBackendDataProperty(source, 'maintenance')
	const admin = readBackendDataProperty(source, 'admin')
	if ((durability !== 'ephemeral' && durability !== 'durable') || !runs || !schedules || !maintenance) {
		throw new Error('Jobs scheduler requires a valid backend adapter')
	}
	const flat: Record<string, unknown> & {durability: 'ephemeral' | 'durable'} = {
		durability,
		...projectMethods(runs as object, RUN_KEYS),
		...projectMethods(schedules as object, SCHEDULE_KEYS),
		...projectMethods(maintenance as object, ['cleanupTerminalRuns']),
		...(admin ? projectMethods(admin as object, ADMIN_KEYS) : {})
	}
	const required = [...RUN_KEYS, ...SCHEDULE_KEYS, 'cleanupTerminalRuns']
	for (const key of required) if (typeof flat[key] !== 'function') {
		throw new Error('Jobs scheduler requires a complete operation-based backend')
	}
	if (!admin) {
		const unavailable = async() => { throw new Error('Jobs admin capability is unavailable') }
		const guarded = guardFlatJobsBackendInputs({
			...flat,
			listRuns: unavailable,
			listSchedules: unavailable,
			setQueuePaused: unavailable,
			listDeadLetters: unavailable,
			getDeadLetter: unavailable,
			requeueDeadLetter: unavailable,
			triggerScheduleNow: unavailable,
			getQueueStats: unavailable
		} as unknown as FlatJobsBackendRuntime)
		return {
			durability: guarded.durability,
			...projectMethods(guarded, RUN_KEYS),
			...projectMethods(guarded, SCHEDULE_KEYS),
			...projectMethods(guarded, ['cleanupTerminalRuns'])
		} as unknown as JobsBackendRuntime
	}
	const guarded = guardFlatJobsBackendInputs(flat as unknown as FlatJobsBackendRuntime)
	return {
		durability: guarded.durability,
		...projectMethods(guarded, RUN_KEYS),
		...projectMethods(guarded, SCHEDULE_KEYS),
		...projectMethods(guarded, ['cleanupTerminalRuns']),
		admin: projectMethods(guarded, ADMIN_KEYS) as unknown as JobsAdminStore
	} as JobsBackendRuntime
}

export function guardJobsBackendInputs(backend: JobsBackend): JobsBackendRuntime {
	return snapshotJobsBackendOperations(backend)
}
