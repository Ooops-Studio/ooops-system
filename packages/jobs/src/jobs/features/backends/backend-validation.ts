import type {QueueStats} from '@ooopsstudio/core/contracts/jobs'

import {validateDeadLetterForRun, validateDeadLetterRecord} from '../../core/handler-dead-letter-validation'
import {
	clone,
	hasControlCharacters,
	hasInvalidJsonText,
	MAX_JOBS_TIMESTAMP,
	validateCancelReason,
	validateNewJobRun,
	validateQueueStats,
	validateResourceId,
	validateRunTransition,
	validateScheduledRun,
	validateStoredJobRun
} from '../../core/handler-helpers'
import {validateRunQuery, validateScheduleQuery} from '../../core/handler-query-helpers'
import {validateStoredSchedule} from '../../core/handler-schedule-validation'
import type {
	AppendRunIdempotency,
	ClaimRunsRequest,
	StoredDeadLetter,
	StoredJobRun,
	StoredSchedule,
	TriggerSchedulesRequest
} from '../../types/backend'

const MAX_PROVIDER_RESULT_BYTES = 64 * 1024 * 1024
const MAX_PROVIDER_SNAPSHOT_DEPTH = 40
export const MAX_PROVIDER_SNAPSHOT_NODES = 120_001

/**
 * Detaches structured provider output without reading user-defined accessors.
 * Provider adapters are an untrusted runtime boundary: validation must operate on
 * stable data, rather than validating one shape and subsequently reading another.
 */
export function snapshotProviderData<T>(value: T, label: string): T {
	let nodes = 0
	let bytes = 0
	const addBytes = (amount: number): void => {
		bytes += amount
		if (!Number.isSafeInteger(bytes) || bytes > MAX_PROVIDER_RESULT_BYTES) {
			throw new Error(`Jobs ${label} exceeds the provider result size limit`)
		}
	}
	const visit = (candidate: unknown, depth: number): unknown => {
		if (++nodes > MAX_PROVIDER_SNAPSHOT_NODES || depth > MAX_PROVIDER_SNAPSHOT_DEPTH) {
			throw new Error(`Jobs provider returned oversized ${label}`)
		}
		if (candidate === null) { addBytes(4); return candidate }
		if (typeof candidate !== 'object') {
			if (typeof candidate === 'string') addBytes(Buffer.byteLength(candidate) + 2)
			else if (typeof candidate === 'number') addBytes(24)
			else if (typeof candidate === 'boolean') addBytes(5)
			else addBytes(16)
			return candidate
		}
		let prototype: object | null
		let descriptors: PropertyDescriptorMap
		const array = Array.isArray(candidate)
		try {
			prototype = Object.getPrototypeOf(candidate)
			if (array) {
				const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, 'length')
				const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
				if (!Number.isSafeInteger(length) || length < 0
					|| length > MAX_PROVIDER_SNAPSHOT_NODES - nodes) {
					throw new Error(`Jobs provider returned oversized ${label}`)
				}
			}
			descriptors = Object.getOwnPropertyDescriptors(candidate)
		} catch(error) {
			if (error instanceof Error && error.message === `Jobs provider returned oversized ${label}`) throw error
			throw new Error(`Jobs provider returned unstable ${label}`)
		}
		const symbols = Reflect.ownKeys(descriptors).filter((key) => typeof key === 'symbol')
		if ((array && prototype !== Array.prototype)
			|| (!array && prototype !== Object.prototype && prototype !== null)
			|| symbols.length > 0 || Object.hasOwn(descriptors, 'toJSON')) {
			throw new Error(`Jobs provider returned unstable ${label}`)
		}
		if (array) {
			const length = descriptors.length?.value
			if (!Number.isSafeInteger(length) || length < 0) throw new Error(`Jobs provider returned unstable ${label}`)
			if (length > MAX_PROVIDER_SNAPSHOT_NODES - nodes) {
				throw new Error(`Jobs provider returned oversized ${label}`)
			}
			addBytes(2 + Math.max(0, length - 1))
			const result: unknown[] = new Array(length)
			for (let index = 0; index < length; index++) {
				const descriptor = descriptors[String(index)]
				if (!descriptor?.enumerable || !('value' in descriptor)) {
					throw new Error(`Jobs provider returned unstable ${label}`)
				}
				result[index] = visit(descriptor.value, depth + 1)
			}
			for (const [key, descriptor] of Object.entries(descriptors)) {
				if (key === 'length' || (/^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < length)) continue
				if (descriptor.enumerable || !('value' in descriptor)) {
					throw new Error(`Jobs provider returned unstable ${label}`)
				}
			}
			return result
		}
		addBytes(2)
		const result: Record<string, unknown> = {}
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (!descriptor.enumerable || !('value' in descriptor)) {
				throw new Error(`Jobs provider returned unstable ${label}`)
			}
			addBytes(Buffer.byteLength(key) + 3)
			Object.defineProperty(result, key, {
				value: visit(descriptor.value, depth + 1), enumerable: true,
				configurable: true, writable: true
			})
		}
		return result
	}
	return visit(value, 0) as T
}

export function parseProviderJson(raw: string, label: string): unknown {
	if (typeof raw !== 'string') throw new Error(`Jobs provider returned invalid ${label} JSON`)
	if (Buffer.byteLength(raw) > MAX_PROVIDER_RESULT_BYTES) {
		throw new Error(`Jobs ${label} exceeds the provider result size limit`)
	}
	try { return JSON.parse(raw) } catch { throw new Error(`Jobs provider returned invalid ${label} JSON`) }
}

export function decodeRun(raw: string | null): StoredJobRun | undefined {
	if (raw === null) return undefined
	const value = parseProviderJson(raw, 'run')
	validateStoredJobRun(value)
	return value
}

export function decodeRunValue(value: unknown): StoredJobRun {
	if (typeof value === 'string') return decodeRun(value)!
	validateStoredJobRun(value)
	return clone(value)
}

export function decodeRuns(raw: string, maximum = 1_000): StoredJobRun[] {
	const encoded = parseProviderJson(raw, 'run list')
	if (!Array.isArray(encoded) || encoded.length > maximum) throw new Error('Jobs provider returned an invalid run list')
	const runs = encoded.map((item) => decodeRunValue(item))
	if (new Set(runs.map((run) => run.id)).size !== runs.length) throw new Error('Jobs provider returned duplicate runs')
	return runs
}

export function decodeSchedule(raw: string | null): StoredSchedule | undefined {
	if (raw === null) return undefined
	const value = parseProviderJson(raw, 'schedule')
	validateStoredSchedule(value)
	return value
}

export function decodeScheduleValue(value: unknown): StoredSchedule {
	if (typeof value === 'string') return decodeSchedule(value)!
	validateStoredSchedule(value)
	return clone(value)
}

export function decodeSchedules(raw: string, maximum = 1_000): StoredSchedule[] {
	const encoded = parseProviderJson(raw, 'schedule list')
	if (!Array.isArray(encoded) || encoded.length > maximum) throw new Error('Jobs provider returned an invalid schedule list')
	const schedules = encoded.map((item) => decodeScheduleValue(item))
	if (new Set(schedules.map((schedule) => schedule.id)).size !== schedules.length) {
		throw new Error('Jobs provider returned duplicate schedules')
	}
	return schedules
}

export function decodeDeadLetter(raw: string | null): StoredDeadLetter | undefined {
	if (raw === null) return undefined
	const value = parseProviderJson(raw, 'dead letter')
	validateDeadLetterRecord(value)
	return value
}

export function decodeDeadLetterValue(value: unknown): StoredDeadLetter {
	if (typeof value === 'string') return decodeDeadLetter(value)!
	validateDeadLetterRecord(value)
	return clone(value)
}

export function decodeDeadLetters(raw: string, maximum = 1_000): StoredDeadLetter[] {
	const encoded = parseProviderJson(raw, 'dead-letter list')
	if (!Array.isArray(encoded) || encoded.length > maximum) throw new Error('Jobs provider returned an invalid dead-letter list')
	const records = encoded.map((item) => {
		return decodeDeadLetterValue(item)
	})
	if (new Set(records.map((record) => record.id)).size !== records.length) {
		throw new Error('Jobs provider returned duplicate dead letters')
	}
	return records
}

export function validateAppendInput(run: StoredJobRun, idempotency?: AppendRunIdempotency): void {
	validateNewJobRun(run)
	if (idempotency && (typeof idempotency.key !== 'string' || idempotency.key.length < 1 || idempotency.key.length > 256
		|| hasControlCharacters(idempotency.key) || hasInvalidJsonText(idempotency.key)
		|| typeof idempotency.checksum !== 'string' || idempotency.checksum.length < 1 || idempotency.checksum.length > 256
		|| !Number.isSafeInteger(idempotency.expiresAt) || idempotency.expiresAt < run.createdAt
		|| idempotency.expiresAt > MAX_JOBS_TIMESTAMP)) {
		throw new Error('Jobs backend received invalid idempotency metadata')
	}
}

export function validateClaimRequest(request: ClaimRunsRequest): void {
	if (!request || typeof request !== 'object' || Array.isArray(request)
		|| !Number.isSafeInteger(request.now) || request.now < 0 || request.now > MAX_JOBS_TIMESTAMP
		|| !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_024
		|| !Number.isSafeInteger(request.maxConcurrentRuns)
		|| request.maxConcurrentRuns < 1 || request.maxConcurrentRuns > 1_024
		|| !Number.isSafeInteger(request.leaseMs) || request.leaseMs < 1 || request.leaseMs > 2_147_483_647
		|| request.now > MAX_JOBS_TIMESTAMP - request.leaseMs) {
		throw new Error('Jobs backend received an invalid claim request')
	}
	validateResourceId(request.workerId, 'worker id')
	validateAllowedTasks(request.allowedTasks)
	const entries = Object.entries(request.concurrencyByTask ?? {})
	if (entries.length > 1_000 || entries.some(([task, limit]) => !/^[a-z][a-z0-9_.-]{0,127}$/iu.test(task)
		|| !Number.isSafeInteger(limit) || limit < 1 || limit > 1_024)) {
		throw new Error('Jobs backend received invalid task concurrency limits')
	}
}

function validateAllowedTasks(allowedTasks: readonly string[] | undefined): void {
	if (allowedTasks !== undefined && (!Array.isArray(allowedTasks) || allowedTasks.length > 1_000
		|| new Set(allowedTasks).size !== allowedTasks.length
		|| allowedTasks.some((task) => typeof task !== 'string'
			|| !/^[a-z][a-z0-9_.-]{0,127}$/iu.test(task)))) {
		throw new Error('Jobs backend received invalid allowed tasks')
	}
}

export function validateTriggerRequest(request: TriggerSchedulesRequest): void {
	if (!request || typeof request !== 'object' || Array.isArray(request)
		|| !Number.isSafeInteger(request.now) || request.now < 0
		|| request.now > MAX_JOBS_TIMESTAMP - 30_000
		|| !Number.isSafeInteger(request.maxCatchUp) || request.maxCatchUp < 1 || request.maxCatchUp > 100
		|| (request.misfireGraceMs !== undefined
			&& (!Number.isSafeInteger(request.misfireGraceMs) || request.misfireGraceMs < 0
				|| request.misfireGraceMs > 2_147_483_647))
		|| (request.terminalExpiresAt !== undefined
			&& (!Number.isSafeInteger(request.terminalExpiresAt) || request.terminalExpiresAt < request.now
				|| request.terminalExpiresAt > MAX_JOBS_TIMESTAMP))
		|| typeof request.createRun !== 'function') {
		throw new Error('Jobs backend received an invalid schedule trigger request')
	}
	validateAllowedTasks(request.allowedTasks)
	const misfire = request.allowedMisfire
	const overlap = request.allowedOverlap
	if ((misfire !== undefined && (!Array.isArray(misfire) || misfire.length < 1
		|| misfire.length > 3 || new Set(misfire).size !== misfire.length
		|| misfire.some((value) => !['skip', 'fire-once', 'catch-up'].includes(value))))
		|| (overlap !== undefined && (!Array.isArray(overlap) || overlap.length < 1
			|| overlap.length > 3 || new Set(overlap).size !== overlap.length
			|| overlap.some((value) => !['queue', 'skip', 'allow'].includes(value))))) {
		throw new Error('Jobs backend received invalid schedule policy constraints')
	}
}

export function shouldTriggerSkippedMisfire(dueAt: number, request: TriggerSchedulesRequest): boolean {
	return dueAt <= request.now && request.now - dueAt <= (request.misfireGraceMs ?? 0)
}

export function validateTriggeredSchedulePolicy(
	schedule: StoredSchedule,
	request: TriggerSchedulesRequest
): void {
	const misfire = schedule.policy?.misfire ?? 'fire-once'
	const overlap = schedule.policy?.overlap ?? 'queue'
	if ((request.allowedMisfire && !request.allowedMisfire.includes(misfire))
		|| (request.allowedOverlap && !request.allowedOverlap.includes(overlap))) {
		throw new Error('Jobs persisted schedule policy is not supported by this runtime')
	}
}

export function validateLeaseMutation(id: string, token: string, expiresAt: number, now: number): void {
	validateResourceId(id, 'run id')
	validateResourceId(token, 'lease token')
	if (!Number.isSafeInteger(now) || now < 0 || now > MAX_JOBS_TIMESTAMP
		|| !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > MAX_JOBS_TIMESTAMP) {
		throw new Error('Jobs backend received invalid lease timestamps')
	}
}

export function validateClaimRelease(id: string, token: string, now: number): void {
	validateResourceId(id, 'run id')
	validateResourceId(token, 'lease token')
	if (!Number.isSafeInteger(now) || now < 0 || now > MAX_JOBS_TIMESTAMP) {
		throw new Error('Jobs backend received an invalid claim release timestamp')
	}
}

export function validateCancelMutation(
	id: string,
	reason: string | undefined,
	token: string | undefined,
	now: number,
	terminalExpiresAt: number | undefined
): void {
	validateResourceId(id, 'run id')
	validateCancelReason(reason)
	if (token !== undefined) validateResourceId(token, 'lease token')
	if (!Number.isSafeInteger(now) || now < 0 || now > MAX_JOBS_TIMESTAMP || (terminalExpiresAt !== undefined
		&& (!Number.isSafeInteger(terminalExpiresAt) || terminalExpiresAt < now
			|| terminalExpiresAt > MAX_JOBS_TIMESTAMP))) {
		throw new Error('Jobs backend received invalid cancellation timestamps')
	}
}

export function validateRecoveryRequest(now: number, recoveryAfterMs: number, terminalExpiresAt?: number): void {
	if (!Number.isSafeInteger(now) || now < 0 || now > MAX_JOBS_TIMESTAMP || !Number.isSafeInteger(recoveryAfterMs)
		|| recoveryAfterMs < 0 || recoveryAfterMs > 2_147_483_647
		|| (terminalExpiresAt !== undefined && (!Number.isSafeInteger(terminalExpiresAt)
			|| terminalExpiresAt < now || terminalExpiresAt > MAX_JOBS_TIMESTAMP))) {
		throw new Error('Jobs backend received an invalid stale recovery request')
	}
}

export function validateCleanupRequest(now: number, limit: number): void {
	if (!Number.isSafeInteger(now) || now < 0 || now > MAX_JOBS_TIMESTAMP
		|| !Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) {
		throw new Error('Jobs backend received an invalid cleanup request')
	}
}

export function validateDeadLetterLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) {
		throw new Error('Jobs backend received an invalid dead-letter limit')
	}
}

export function validateQueueStatsRequest(queue: string | undefined, now: number | undefined): void {
	if (queue !== undefined) {
		if (!/^[a-z][a-z0-9_.-]{0,63}$/iu.test(queue)) throw new Error('Job queue must be a safe identifier')
	}
	if (now !== undefined && (!Number.isSafeInteger(now) || now < 0 || now > MAX_JOBS_TIMESTAMP)) {
		throw new Error('Jobs backend received an invalid queue stats timestamp')
	}
}

export {validateRunQuery, validateScheduleQuery}

export function decodeAppendResult(raw: string): {run: StoredJobRun; existing: boolean} {
	const value = parseProviderJson(raw, 'append result')
	if (!value || typeof value !== 'object' || Array.isArray(value)
		|| typeof (value as {existing?: unknown}).existing !== 'boolean') {
		throw new Error('Jobs provider returned an invalid append result')
	}
	const result = value as {run: unknown; existing: boolean}
	validateStoredJobRun(result.run)
	return {run: result.run, existing: result.existing}
}

export function validateTransitionInput(
	run: StoredJobRun,
	status: StoredJobRun['status'],
	dead?: StoredDeadLetter
): void {
	validateRunTransition(run, status)
	if (dead) validateDeadLetterForRun(run, dead)
}

export function validateScheduleInput(schedule: StoredSchedule): void { validateStoredSchedule(schedule) }

export function validateGeneratedRun(run: StoredJobRun, schedule: StoredSchedule, triggerTime: number): void {
	validateScheduledRun(run, schedule, triggerTime)
}

export function validateStats(values: unknown): QueueStats[] {
	if (!Array.isArray(values) || values.length > 1_000) throw new Error('Jobs provider returned invalid queue stats')
	for (const value of values) validateQueueStats(value)
	if (new Set(values.map((value) => value.queue)).size !== values.length) {
		throw new Error('Jobs provider returned duplicate queue stats')
	}
	return clone(values)
}

export function validateBoundedCount(value: unknown, maximum: number, label: string): number {
	const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
	if (!Number.isSafeInteger(number) || (number as number) < 0 || (number as number) > maximum) {
		throw new Error(`Jobs provider returned an invalid ${label}`)
	}
	return number as number
}

export function decodeProviderBoolean(value: unknown, label: string): boolean {
	if (value === 'true' || value === true) return true
	if (value === 'false' || value === false) return false
	throw new Error(`Jobs provider returned an invalid ${label}`)
}
