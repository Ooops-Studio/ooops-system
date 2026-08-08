
import {validateDeadLetterRecord} from '../../core/handler-dead-letter-validation'
import {validateStoredJobRun} from '../../core/handler-helpers'
import {validateStoredSchedule} from '../../core/handler-schedule-validation'
import type {
	AppendRunIdempotency,
	StoredDeadLetter,
	StoredJobRun,
	StoredSchedule
} from '../../types/backend'

export interface LegacyJobsState {
	runs: Record<string, StoredJobRun>
	schedules: Record<string, StoredSchedule>
	deadLetters: Record<string, StoredDeadLetter>
	idempotency: Record<string, AppendRunIdempotency & {runId: string}>
	queuePaused: string[]
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown, maximum: number): value is string => typeof value === 'string' && new RegExp(`^[a-z][a-z0-9_.-]{0,${maximum - 1}}$`, 'iu').test(value)
const resourceIdentifier = (value: unknown): value is string => typeof value === 'string'
	&& value.length >= 1 && value.length <= 256
	&& ![...value].some((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127
	})
const statuses = new Set(['queued', 'running', 'retryable', 'completed', 'failed', 'cancelled', 'dead-lettered'])
const backoffKinds = new Set(['fixed', 'linear', 'exponential'])
const jitters = new Set(['none', 'full', 'bounded'])
const misfires = new Set(['skip', 'fire-once', 'catch-up'])
const overlaps = new Set(['allow', 'skip', 'queue'])
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const optionalFinite = (value: unknown): boolean => value === undefined || finite(value)

export function parseLegacyJobsState(version: number, data: string): LegacyJobsState {
	if (version !== 1) throw new Error(`Unsupported jobs snapshot version: ${version}`)
	if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024 * 1024) throw new Error('Jobs snapshot exceeds the migration size limit')
	const parsed: unknown = JSON.parse(data)
	if (!object(parsed)) throw new Error('Invalid jobs snapshot state')
	for (const section of ['runs', 'schedules', 'deadLetters', 'idempotency'] as const) {
		if (parsed[section] !== undefined && !object(parsed[section])) {
			throw new Error(`Invalid jobs snapshot ${section}`)
		}
	}
	const runs = (parsed.runs ?? {}) as Record<string, unknown>
	const schedules = (parsed.schedules ?? {}) as Record<string, unknown>
	const deadLetters = (parsed.deadLetters ?? {}) as Record<string, unknown>
	const idempotency = (parsed.idempotency ?? {}) as Record<string, unknown>
	const queuePaused = parsed.queuePaused === undefined ? [] : parsed.queuePaused
	if (Object.keys(runs).length > 100_000 || Object.keys(schedules).length > 10_000
		|| Object.keys(deadLetters).length > 100_000 || Object.keys(idempotency).length > 100_000) {
		throw new Error('Jobs snapshot exceeds migration record limits')
	}
	if (!Array.isArray(queuePaused) || queuePaused.length > 1_000
		|| new Set(queuePaused).size !== queuePaused.length
		|| queuePaused.some((queue) => !identifier(queue, 64))) throw new Error('Invalid jobs paused queues')
	for (const [id, value] of Object.entries(runs)) {
		const retry = object(value) && object(value.retryPolicy) ? value.retryPolicy : undefined
		const invalidLease = object(value) && value.status === 'running' && (typeof value.leaseToken !== 'string' || !finite(value.leaseExpiresAt))
		const backoff = retry && retry.backoff
		if (!object(value) || !resourceIdentifier(id) || value.id !== id || !identifier(value.task, 128) || !identifier(value.queue, 64) || !object(value.payload) || !statuses.has(String(value.status)) || !finite(value.runAt) || !finite(value.createdAt) || !finite(value.updatedAt) || !Number.isSafeInteger(value.priority) || !nonNegativeInteger(value.attempt) || !nonNegativeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.attempt > value.maxAttempts || !retry || !nonNegativeInteger(retry.attempts) || retry.attempts < 1 || !finite(retry.baseDelayMs) || retry.baseDelayMs < 0 || (retry.maxDelayMs !== undefined && (!finite(retry.maxDelayMs) || retry.maxDelayMs < 0)) || (retry.jitter !== undefined && !jitters.has(String(retry.jitter))) || (backoff !== undefined && (!object(backoff) || !backoffKinds.has(String(backoff.kind)) || (backoff.factor !== undefined && (!finite(backoff.factor) || backoff.factor <= 0)))) || invalidLease) throw new Error(`Invalid jobs run: ${id}`)
		delete value.history
		validateStoredJobRun(value)
	}
	const queues = new Set<string>(queuePaused)
	for (const run of Object.values(runs)) queues.add((run as StoredJobRun).queue)
	if (queues.size > 1_000) throw new Error('Jobs snapshot exceeds queue cardinality limit')
	for (const [id, value] of Object.entries(schedules)) {
		const policy = object(value) && value.policy
		if (object(policy) && policy.overlap === 'replace') {
			throw new Error('JOBS_SCHEDULE_POLICY_UNSUPPORTED')
		}
		if (!object(value) || value.id !== id || !identifier(id, 128) || !identifier(value.task, 128) || (value.queue !== undefined && !identifier(value.queue, 64)) || (value.kind !== 'cron' && value.kind !== 'interval') || (value.kind === 'cron' && (typeof value.cron !== 'string' || value.cron.length === 0)) || (value.kind === 'interval' && (!finite(value.intervalMs) || value.intervalMs <= 0)) || (value.payload !== undefined && !object(value.payload)) || (value.enabled !== undefined && typeof value.enabled !== 'boolean') || !optionalFinite(value.startAt) || !optionalFinite(value.endAt) || !optionalFinite(value.nextRunAt) || !optionalFinite(value.lastTriggeredAt) || (finite(value.startAt) && finite(value.endAt) && value.endAt < value.startAt) || (policy !== undefined && (!object(policy) || !misfires.has(String(policy.misfire)) || !overlaps.has(String(policy.overlap)) || (policy.timezone !== undefined && typeof policy.timezone !== 'string')))) throw new Error(`Invalid jobs schedule: ${id}`)
		validateStoredSchedule(value)
	}
	const deadLetterRunIds = new Set<string>()
	for (const [id, value] of Object.entries(deadLetters)) {
		if (!object(value) || value.id !== id || !resourceIdentifier(id) || !resourceIdentifier(value.runId) || !identifier(value.queue, 64) || !identifier(value.task, 128) || typeof value.reason !== 'string' || (value.error !== undefined && typeof value.error !== 'string') || !nonNegativeInteger(value.attempts) || !finite(value.failedAt) || (value.payload !== undefined && !object(value.payload))) throw new Error(`Invalid jobs dead letter: ${id}`)
		validateDeadLetterRecord(value)
		const source = runs[value.runId as string] as StoredJobRun | undefined
		if (!source || source.status !== 'dead-lettered' || source.queue !== value.queue
			|| source.task !== value.task || source.attempt !== value.attempts) {
			throw new Error(`Invalid jobs dead letter relationship: ${id}`)
		}
		if (deadLetterRunIds.has(source.id)) throw new Error(`Invalid jobs dead letter relationship: ${id}`)
		deadLetterRunIds.add(source.id)
	}
	const idempotentRunIds = new Set<string>()
	for (const [key, value] of Object.entries(idempotency)) {
		if (!object(value) || !resourceIdentifier(key) || !resourceIdentifier(value.runId)
			|| typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(value.checksum)
			|| !nonNegativeInteger(value.expiresAt) || !runs[value.runId as string]) {
			throw new Error(`Invalid jobs idempotency record: ${key}`)
		}
		const run = runs[value.runId as string] as StoredJobRun
		if (idempotentRunIds.has(run.id)) throw new Error(`Invalid jobs idempotency relationship: ${key}`)
		idempotentRunIds.add(run.id)
		if (run.idempotencyKey === undefined) {
			run.idempotencyKey = key
			run.idempotencyChecksum = value.checksum
			run.idempotencyExpiresAt = value.expiresAt
		} else if (run.idempotencyKey !== key
			|| run.idempotencyChecksum !== value.checksum
			|| run.idempotencyExpiresAt !== value.expiresAt) {
			throw new Error(`Invalid jobs idempotency relationship: ${key}`)
		}
		try { validateStoredJobRun(run) } catch { throw new Error(`Invalid jobs idempotency relationship: ${key}`) }
	}
	return {runs, schedules, deadLetters, idempotency, queuePaused} as LegacyJobsState
}
