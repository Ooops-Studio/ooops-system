import type {StoredDeadLetter, StoredJobRun} from '../types/backend'

import {
	assertStableRecord,
	isJobsDiagnosticCode,
	MAX_JOBS_TIMESTAMP,
	payloadChecksum,
	validateJobPayload,
	validateNewJobRun,
	validateQueueName,
	validateResourceId
} from './handler-helpers'

const DEAD_LETTER_FIELDS = new Set([
	'id', 'runId', 'queue', 'task', 'failureCode', 'reason', 'error', 'attempts', 'failedAt', 'payload'
])

export function validateDeadLetterRecord(value: unknown): asserts value is StoredDeadLetter {
	assertStableRecord(value, 'Jobs backend dead letter', DEAD_LETTER_FIELDS)
	const record = value as Partial<StoredDeadLetter>
	validateResourceId(record.id, 'dead-letter id')
	validateResourceId(record.runId, 'run id')
	if (typeof record.queue !== 'string') throw new Error('Jobs backend returned an invalid dead-letter queue')
	validateQueueName(record.queue)
	if (typeof record.task !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/iu.test(record.task)
		|| !isJobsDiagnosticCode(record.failureCode ?? record.reason)
		|| (record.error !== undefined && !isJobsDiagnosticCode(record.error))
		|| !Number.isSafeInteger(record.attempts) || (record.attempts as number) < 1
		|| !Number.isSafeInteger(record.failedAt) || (record.failedAt as number) < 0
		|| (record.failedAt as number) > MAX_JOBS_TIMESTAMP) {
		throw new Error('Jobs backend returned invalid dead-letter fields')
	}
	if (record.payload !== undefined) validateJobPayload(record.payload)
}

export function validateDeadLetterForRun(run: StoredJobRun, dead: unknown): asserts dead is StoredDeadLetter {
	validateDeadLetterRecord(dead)
	if (dead.runId !== run.id || dead.queue !== run.queue || dead.task !== run.task
		|| dead.attempts !== run.attempt) {
		throw new Error('Jobs dead letter does not match its run')
	}
}

export function validateDeadLetterRequeue(run: StoredJobRun, dead: StoredDeadLetter): void {
	validateNewJobRun(run)
	validateDeadLetterRecord(dead)
	if (run.task !== dead.task || run.queue !== dead.queue
		|| payloadChecksum(run.payload) !== payloadChecksum(dead.payload ?? {})) {
		throw new Error('Jobs dead-letter requeue does not match its source')
	}
}
