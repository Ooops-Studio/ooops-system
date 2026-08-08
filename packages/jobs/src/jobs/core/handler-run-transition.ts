import {isDeepStrictEqual} from 'node:util'

import type {StoredJobRun} from '../types/backend'

/** Ensure a lease-guarded write cannot replace the identity of the claimed run. */
export function validateRunTransitionIdentity(current: StoredJobRun, next: StoredJobRun): void {
	const scalarFields = [
		'id', 'task', 'queue', 'createdAt', 'priority', 'attempt', 'maxAttempts', 'scheduleId',
		'startedAt', 'idempotencyKey', 'idempotencyExpiresAt', 'idempotencyChecksum'
	] as const
	if (scalarFields.some((field) => current[field] !== next[field])
		|| next.updatedAt < current.updatedAt
		|| (next.status !== 'retryable' && next.runAt !== current.runAt)
		|| !isDeepStrictEqual(current.payload, next.payload)
		|| !isDeepStrictEqual(current.retryPolicy, next.retryPolicy)) {
		throw new Error('Jobs run identity changed during a lease-guarded transition')
	}
}
