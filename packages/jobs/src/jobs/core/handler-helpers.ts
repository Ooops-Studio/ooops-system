import {createHash} from 'node:crypto'

import type {
	JobPayload,
	RetryPolicy,
	QueueStats,
	TaskDefinition
} from '@ooopsstudio/core/contracts/jobs'

import type {JobTraceContext, StoredJobRun, StoredSchedule} from '../types/backend'
import type {InternalRun} from '../types/jobs'

import {
	hasInvalidJsonText,
	hasJobsNumberPrecision,
	validateJobPayload,
	validateJobResult
} from './handler-payload'

export {
	hasInvalidJsonText,
	hasJobsNumberPrecision,
	snapshotJobPayload,
	snapshotJobResult,
	validateJobPayload,
	validateJobResult
} from './handler-payload'

const MAX_TIMER_MS = 2_147_483_647
export const MAX_JOBS_TIMESTAMP = 99_999_999_999_999
const MIN_SQL_INTEGER = -2_147_483_648
const MAX_SQL_INTEGER = 2_147_483_647
const MAX_RETRY_ATTEMPTS = 100
const JOB_STATUSES = new Set(['queued', 'running', 'retryable', 'completed', 'failed', 'cancelled', 'dead-lettered'])
const RUN_FIELDS = new Set(['id', 'task', 'queue', 'payload', 'status', 'createdAt', 'updatedAt', 'runAt', 'priority', 'attempt', 'maxAttempts', 'scheduleId', 'output', 'failureCode', 'error', 'cancelReason', 'startedAt', 'completedAt', 'terminalAt', 'retryPolicy', 'idempotencyKey', 'idempotencyExpiresAt', 'idempotencyChecksum', 'leaseOwner', 'leaseToken', 'leaseExpiresAt', 'lastHeartbeatAt', 'terminalExpiresAt', 'traceContext'])
const QUEUE_STATS_FIELDS = new Set(['queue', 'queued', 'running', 'retryable', 'deadLettered', 'completed', 'failed', 'cancelled', 'paused', 'lagMs'])

export function assertStableRecord(value: unknown, label: string, allowed?: ReadonlySet<string>): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
	let prototype: object | null
	try { prototype = Object.getPrototypeOf(value) } catch { throw new Error(`${label} must expose stable data fields`) }
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain data object`)
	let descriptors: PropertyDescriptorMap
	try { descriptors = Object.getOwnPropertyDescriptors(value) } catch {
		throw new Error(`${label} must expose stable data fields`)
	}
	const symbols = Reflect.ownKeys(descriptors).filter((key) => typeof key === 'symbol')
	if (symbols.length > 0 || Object.hasOwn(descriptors, 'toJSON')) throw new Error(`${label} contains unsupported fields`)
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!descriptor.enumerable || !('value' in descriptor) || (allowed && !allowed.has(key))) {
			throw new Error(`${label} contains unsupported fields`)
		}
	}
}

/** Snapshot a public data record without invoking getters or retaining caller-owned state. */
export function snapshotStableRecord<T extends object>(
	value: unknown,
	label: string,
	allowed: ReadonlySet<string>
): T {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	try {
		prototype = Object.getPrototypeOf(value)
		descriptors = Object.getOwnPropertyDescriptors(value)
	} catch { throw new Error(`${label} must expose stable data fields`) }
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain data object`)
	const snapshot: Record<string, unknown> = {}
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`${label} contains unsupported fields`)
		const descriptor = descriptors[key]
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new Error(`${label} contains unsupported fields`)
		}
		Object.defineProperty(snapshot, key, {
			value: descriptor.value,
			enumerable: true,
			configurable: true,
			writable: true
		})
	}
	return snapshot as T
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function snapshotJobTraceContext(value: unknown): JobTraceContext | undefined {
	if (value === undefined) return undefined
	assertStableRecord(value, 'Jobs trace context', new Set(['traceparent', 'tracestate', 'baggage']))
	const context = value as Partial<JobTraceContext>
	if (typeof context.traceparent !== 'string' || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(context.traceparent)
		|| /^00-0{32}-/u.test(context.traceparent) || /-0{16}-/u.test(context.traceparent)) {
		throw new Error('Jobs trace context contains an invalid W3C traceparent')
	}
	if (context.tracestate !== undefined && (typeof context.tracestate !== 'string' || context.tracestate.length > 512
		|| hasControlCharacters(context.tracestate))) throw new Error('Jobs trace context contains an invalid tracestate')
	if (context.baggage !== undefined && (typeof context.baggage !== 'string'
		|| new TextEncoder().encode(context.baggage).byteLength > 8_192 || hasControlCharacters(context.baggage))) {
		throw new Error('Jobs trace context contains invalid baggage')
	}
	return Object.freeze({
		traceparent: context.traceparent,
		...(context.tracestate ? {tracestate: context.tracestate} : {}),
		...(context.baggage ? {baggage: context.baggage} : {})
	})
}

export const positiveInteger = (value: number | undefined, fallback: number, minimum = 1): number =>
	Number.isInteger(value) && (value ?? 0) >= minimum ? value as number : fallback

export const isTerminal = (run: InternalRun): boolean =>
	['completed', 'failed', 'cancelled', 'dead-lettered'].includes(run.status)

export function requireBackendBoolean(value: unknown, operation: string): boolean {
	if (typeof value !== 'boolean') throw new Error(`Jobs backend returned an invalid ${operation} result`)
	return value
}

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize)
	if (value && typeof value === 'object') return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
			.map(([key, item]) => [key, canonicalize(item)])
	)
	return value
}

export const payloadChecksum = (payload: JobPayload): string =>
	createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex')

export const enqueueRequestChecksum = (
	payload: JobPayload,
	queue: string,
	priority: number,
	explicitRunAt?: number
): string => createHash('sha256').update(JSON.stringify(canonicalize({
	payload,
	queue,
	priority,
	...(explicitRunAt === undefined ? {} : {runAt: explicitRunAt})
}))).digest('hex')

export const idempotencyStorageKey = (namespace: string, task: string, key: string): string =>
	`jobs:idem:${createHash('sha256').update(`${namespace}\0${task}\0${key}`).digest('hex')}`

export function validateCancelReason(reason: unknown): asserts reason is string | undefined {
	if (reason !== undefined && (typeof reason !== 'string' || reason.length < 1 || reason.length > 256
		|| hasControlCharacters(reason) || hasInvalidJsonText(reason))) {
		throw new Error('Job cancellation reason must contain 1 to 256 characters')
	}
}

export function computeRetryDelay(attempt: number, policy: RetryPolicy, random = Math.random): number {
	const factor = policy.backoff?.factor ?? 2
	const multiplier = policy.backoff?.kind === 'linear'
		? attempt
		: policy.backoff?.kind === 'exponential'
			? factor ** Math.max(0, attempt - 1)
			: 1
	const maximum = Math.min(policy.maxDelayMs ?? MAX_TIMER_MS, MAX_TIMER_MS)
	const scaled = policy.baseDelayMs === 0 ? 0 : policy.baseDelayMs * multiplier
	const capped = Number.isFinite(scaled) ? Math.min(maximum, scaled) : maximum
	if (policy.jitter === 'full') return Math.floor(random() * capped)
	if (policy.jitter === 'bounded') return Math.floor(Math.min(
		maximum,
		capped * (0.75 + random() * 0.5)
	))
	return Math.floor(capped)
}

export function addJobsDuration(timestamp: number, durationMs: number, label: string): number {
	if (!Number.isSafeInteger(timestamp) || timestamp < 0
		|| !Number.isSafeInteger(durationMs) || durationMs < 0
		|| timestamp > MAX_JOBS_TIMESTAMP - durationMs) {
		throw new Error(`${label} exceeds the supported timestamp range`)
	}
	return timestamp + durationMs
}

export function validateTaskDefinition(definition: TaskDefinition): void {
	assertStableRecord(definition, 'Task definition', new Set(['name', 'queue', 'priority', 'concurrency', 'timeoutMs']))
	if (!/^[a-z][a-z0-9_.-]{0,127}$/i.test(definition.name)) throw new Error('Task name must be a safe identifier')
	if (definition.queue !== undefined && !/^[a-z][a-z0-9_.-]{0,63}$/i.test(definition.queue)) throw new Error('Task queue must be a safe identifier')
	if (definition.concurrency !== undefined && (!Number.isInteger(definition.concurrency) || definition.concurrency < 1 || definition.concurrency > 1_024)) throw new Error('Task concurrency must be between 1 and 1024')
	if (definition.priority !== undefined && (!Number.isInteger(definition.priority) || definition.priority < MIN_SQL_INTEGER || definition.priority > MAX_SQL_INTEGER)) throw new Error('Task priority must be a signed 32-bit integer')
	if (definition.timeoutMs !== undefined && (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0 || definition.timeoutMs > MAX_TIMER_MS)) throw new Error('Task timeoutMs must be between 1 and 2147483647')
}

export function validateEnqueueOptions(options: {queue?: string; runAt?: number; priority?: number; idempotencyKey?: string}): void {
	assertStableRecord(options, 'Job enqueue options', new Set(['queue', 'runAt', 'priority', 'idempotencyKey']))
	if (options.queue !== undefined && !/^[a-z][a-z0-9_.-]{0,63}$/i.test(options.queue)) throw new Error('Job queue must be a safe identifier')
	if (options.runAt !== undefined && (!Number.isSafeInteger(options.runAt) || options.runAt < 0 || options.runAt > MAX_JOBS_TIMESTAMP)) throw new Error('Job runAt must be a supported non-negative timestamp')
	if (options.priority !== undefined && (!Number.isInteger(options.priority) || options.priority < MIN_SQL_INTEGER || options.priority > MAX_SQL_INTEGER)) throw new Error('Job priority must be a signed 32-bit integer')
	if (options.idempotencyKey !== undefined && (typeof options.idempotencyKey !== 'string'
		|| options.idempotencyKey.length < 1 || options.idempotencyKey.length > 256
		|| hasControlCharacters(options.idempotencyKey) || hasInvalidJsonText(options.idempotencyKey))) {
		throw new Error('Job idempotencyKey must contain 1 to 256 safe characters')
	}
}

export function validateQueueName(queue: string): void {
	if (!/^[a-z][a-z0-9_.-]{0,63}$/iu.test(queue)) throw new Error('Job queue must be a safe identifier')
}

export function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code < 32 || code === 127) return true
	}
	return false
}

export function isJobsDiagnosticCode(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value)
}

export function validateJobsNamespace(value: unknown, label = 'Jobs namespace'): asserts value is string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 128
		|| hasControlCharacters(value) || hasInvalidJsonText(value)) {
		throw new Error(`${label} must contain 1 to 128 safe characters`)
	}
}

export function validateResourceId(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 256
		|| hasControlCharacters(value) || hasInvalidJsonText(value)) {
		throw new Error(`Jobs ${label} must be a bounded identifier`)
	}
}

export function validateStoredJobRun(value: unknown): asserts value is StoredJobRun {
	assertStableRecord(value, 'Jobs backend run', RUN_FIELDS)
	const run = value as Partial<StoredJobRun>
	validateResourceId(run.id, 'run id')
	if (typeof run.task !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/iu.test(run.task)) throw new Error('Jobs backend returned an invalid run task')
	if (typeof run.queue !== 'string') throw new Error('Jobs backend returned an invalid run queue')
	validateQueueName(run.queue)
	validateJobPayload(run.payload)
	if (!JOB_STATUSES.has(String(run.status))) throw new Error('Jobs backend returned an invalid run status')
	for (const timestamp of [run.createdAt, run.updatedAt, run.runAt]) {
		if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0 || (timestamp as number) > MAX_JOBS_TIMESTAMP) throw new Error('Jobs backend returned invalid run timestamps')
	}
	for (const timestamp of [run.startedAt, run.completedAt, run.terminalAt, run.terminalExpiresAt,
		run.idempotencyExpiresAt, run.leaseExpiresAt, run.lastHeartbeatAt]) {
		if (timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_JOBS_TIMESTAMP)) {
			throw new Error('Jobs backend returned invalid optional run timestamps')
		}
	}
	if ((run.updatedAt as number) < (run.createdAt as number)
		|| (run.startedAt !== undefined && run.startedAt < (run.createdAt as number))
		|| (run.startedAt !== undefined && run.startedAt > (run.updatedAt as number))
		|| (run.completedAt !== undefined && run.completedAt < (run.createdAt as number))
		|| (run.completedAt !== undefined && run.startedAt !== undefined && run.completedAt < run.startedAt)
		|| (run.completedAt !== undefined && run.completedAt > (run.updatedAt as number))
		|| (run.terminalAt !== undefined && run.terminalAt < (run.createdAt as number))
		|| (run.terminalAt !== undefined && run.completedAt !== undefined && run.terminalAt < run.completedAt)
		|| (run.terminalAt !== undefined && run.terminalAt > (run.updatedAt as number))
		|| (run.lastHeartbeatAt !== undefined && run.lastHeartbeatAt > (run.updatedAt as number))
		|| (run.terminalAt !== undefined && run.terminalExpiresAt !== undefined
			&& run.terminalExpiresAt < run.terminalAt)) {
		throw new Error('Jobs backend returned inconsistent run timestamps')
	}
	const idempotencyFields = [run.idempotencyKey, run.idempotencyChecksum, run.idempotencyExpiresAt]
	if (idempotencyFields.some((field) => field !== undefined)) {
		if (typeof run.idempotencyKey !== 'string' || run.idempotencyKey.length < 1 || run.idempotencyKey.length > 256
			|| hasControlCharacters(run.idempotencyKey) || hasInvalidJsonText(run.idempotencyKey)
			|| typeof run.idempotencyChecksum !== 'string' || !/^[a-f0-9]{64}$/u.test(run.idempotencyChecksum)
			|| !Number.isSafeInteger(run.idempotencyExpiresAt) || (run.idempotencyExpiresAt as number) < (run.createdAt as number)) {
			throw new Error('Jobs backend returned invalid run idempotency metadata')
		}
	}
	if (!Number.isInteger(run.priority) || (run.priority as number) < MIN_SQL_INTEGER || (run.priority as number) > MAX_SQL_INTEGER
		|| !Number.isSafeInteger(run.attempt) || (run.attempt as number) < 0
		|| !Number.isSafeInteger(run.maxAttempts) || (run.maxAttempts as number) < 1 || (run.attempt as number) > (run.maxAttempts as number)) {
		throw new Error('Jobs backend returned invalid run counters')
	}
	const retry = run.retryPolicy
	if (retry) assertStableRecord(retry, 'Jobs run retry policy', new Set(['attempts', 'baseDelayMs', 'maxDelayMs', 'backoff', 'jitter']))
	if (retry?.backoff) assertStableRecord(retry.backoff, 'Jobs run backoff policy', new Set(['kind', 'factor']))
	if (!retry || !Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > MAX_RETRY_ATTEMPTS
		|| retry.attempts !== run.maxAttempts
		|| !Number.isSafeInteger(retry.baseDelayMs) || retry.baseDelayMs < 0 || retry.baseDelayMs > MAX_TIMER_MS
		|| (retry.maxDelayMs !== undefined && (!Number.isSafeInteger(retry.maxDelayMs)
			|| retry.maxDelayMs < 0 || retry.maxDelayMs > MAX_TIMER_MS))
		|| (retry.jitter !== undefined && !['none', 'full', 'bounded'].includes(retry.jitter))
		|| (retry.backoff !== undefined && (!['fixed', 'linear', 'exponential'].includes(retry.backoff.kind)
			|| (retry.backoff.factor !== undefined && (!Number.isFinite(retry.backoff.factor)
				|| retry.backoff.factor <= 0 || !hasJobsNumberPrecision(retry.backoff.factor)))))) {
		throw new Error('Jobs backend returned an invalid run retry policy')
	}
	if ((run.status === 'queued' && run.attempt !== 0)
		|| (run.status === 'retryable' && run.attempt === run.maxAttempts)
		|| (['running', 'retryable', 'completed', 'failed', 'dead-lettered'].includes(String(run.status))
			&& (run.attempt as number) < 1)) {
		throw new Error('Jobs backend returned an inconsistent run attempt')
	}
	if (run.output !== undefined) validateJobResult(run.output)
	if (run.error !== undefined && !isJobsDiagnosticCode(run.error)) {
		throw new Error('Jobs backend returned invalid run diagnostics')
	}
	if (run.failureCode !== undefined && !isJobsDiagnosticCode(run.failureCode)) {
		throw new Error('Jobs backend returned invalid run diagnostics')
	}
	if (run.cancelReason !== undefined && (typeof run.cancelReason !== 'string'
		|| run.cancelReason.length < 1 || run.cancelReason.length > 256
		|| hasControlCharacters(run.cancelReason) || hasInvalidJsonText(run.cancelReason))) {
		throw new Error('Jobs backend returned invalid run diagnostics')
	}
	if (run.scheduleId !== undefined) validateResourceId(run.scheduleId, 'schedule id')
	if (run.traceContext !== undefined) snapshotJobTraceContext(run.traceContext)
	const running = run.status === 'running'
	const terminal = ['completed', 'failed', 'cancelled', 'dead-lettered'].includes(String(run.status))
	if (terminal !== (run.terminalAt !== undefined)
		|| (run.terminalExpiresAt !== undefined && !terminal)
		|| (run.completedAt !== undefined && run.status !== 'completed')
		|| (run.output !== undefined && run.status !== 'completed')
		|| (run.cancelReason !== undefined && run.status !== 'cancelled')) {
		throw new Error('Jobs backend returned inconsistent terminal run fields')
	}
	if (running && ((run.attempt as number) < 1 || run.startedAt === undefined
		|| run.lastHeartbeatAt === undefined
		|| typeof run.leaseOwner !== 'string' || run.leaseOwner.length < 1 || run.leaseOwner.length > 256
		|| typeof run.leaseToken !== 'string' || run.leaseToken.length < 1 || run.leaseToken.length > 256
		|| !Number.isSafeInteger(run.leaseExpiresAt)
		|| run.lastHeartbeatAt < run.startedAt
		|| (run.leaseExpiresAt as number) <= run.lastHeartbeatAt)) {
		throw new Error('Jobs backend returned an invalid run lease')
	}
	if (!running && (run.leaseOwner !== undefined || run.leaseToken !== undefined
		|| run.leaseExpiresAt !== undefined || run.lastHeartbeatAt !== undefined)) {
		throw new Error('Jobs backend returned stale run lease fields')
	}
}

export function validateNewJobRun(value: unknown): asserts value is StoredJobRun {
	validateStoredJobRun(value)
	if (value.status !== 'queued' || value.attempt !== 0
		|| value.startedAt !== undefined || value.completedAt !== undefined
		|| value.output !== undefined || value.failureCode !== undefined
		|| value.error !== undefined || value.cancelReason !== undefined) {
		throw new Error('Jobs backend can only append a clean new queued run')
	}
}

export function validateRunTransition(value: unknown, status: StoredJobRun['status']): asserts value is StoredJobRun {
	validateStoredJobRun(value)
	if (value.status !== status) throw new Error(`Jobs backend transition requires ${status} status`)
	if (value.attempt < 1) throw new Error('Jobs backend transition requires an attempted run')
	if (status === 'retryable' && value.runAt < value.updatedAt) {
		throw new Error('Jobs backend retry transition must not run before its update timestamp')
	}
}

export function validateScheduledRun(run: unknown, schedule: StoredSchedule, triggerTime: number): asserts run is StoredJobRun {
	validateNewJobRun(run)
	if (run.scheduleId !== schedule.id || run.task !== schedule.task
		|| (schedule.queue !== undefined && run.queue !== schedule.queue) || run.runAt !== triggerTime) {
		throw new Error('Jobs schedule produced an inconsistent run')
	}
}

export function validateQueueStats(value: unknown): asserts value is QueueStats {
	assertStableRecord(value, 'Jobs backend queue stats', QUEUE_STATS_FIELDS)
	const stats = value as Partial<QueueStats>
	if (typeof stats.queue !== 'string') throw new Error('Jobs backend returned invalid queue stats')
	validateQueueName(stats.queue)
	for (const field of ['queued', 'running', 'retryable', 'deadLettered', 'completed', 'failed', 'cancelled', 'lagMs'] as const) {
		if (!Number.isSafeInteger(stats[field]) || (stats[field] as number) < 0) throw new Error('Jobs backend returned invalid queue stats')
	}
	if (typeof stats.paused !== 'boolean') throw new Error('Jobs backend returned invalid queue stats')
}
