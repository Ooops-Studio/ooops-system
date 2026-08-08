import {
	ConfigValidationError,
	snapshotPlainDataRecord,
	validateNonNegativeInteger,
	validateNumberInRange,
	validatePositiveFinite,
	validatePositiveInteger
} from '@ooopsstudio/core/utils/validation'

import type {BackpressurePolicy, TransferringPolicies} from '../types/transferring'

import {assertNonNegativeTimerMs, assertPositiveTimerMs} from './validation'

function validateBackpressurePolicy(policy: Readonly<BackpressurePolicy>): void {
	validateNonNegativeInteger(policy.maxQueuedItems, 'logging.backpressure.maxQueuedItems')
	validateNonNegativeInteger(policy.maxQueuedBytes, 'logging.backpressure.maxQueuedBytes')
	if (!['drop-oldest', 'drop-newest', 'error'].includes(policy.onOverflow)) {
		throw new ConfigValidationError(
			`logging.backpressure.onOverflow must be drop-oldest, drop-newest, or error, got: ${String(policy.onOverflow)}`
		)
	}
	if (policy.maxQueuedItems > 100_000 || policy.maxQueuedBytes > 100_000_000) {
		throw new ConfigValidationError('logging backpressure limits exceed the supported bounds')
	}
}

export function validateTransferringPolicies(policy: Readonly<TransferringPolicies>): void {
	if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
		throw new TypeError('Logging transferring policy must be an object')
	}
	const requirePolicyObject = (value: unknown, name: string): void => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError(`Logging ${name} policy must be an object`)
		}
	}
	if (policy.batching !== undefined) {
		requirePolicyObject(policy.batching, 'batching')
		validatePositiveInteger(policy.batching.maxBatch, 'logging.batching.maxBatch')
		assertPositiveTimerMs(policy.batching.maxIntervalMs, 'logging.batching.maxIntervalMs')
		validatePositiveInteger(policy.batching.maxBytes, 'logging.batching.maxBytes')
		if (policy.batching.maxBatch > 10_000 || policy.batching.maxBytes > 100_000_000) {
			throw new ConfigValidationError('logging batching limits exceed the supported bounds')
		}
	}
	if (policy.retry !== undefined) {
		requirePolicyObject(policy.retry, 'retry')
		validatePositiveInteger(policy.retry.maxAttempts, 'logging.retry.maxAttempts')
		assertNonNegativeTimerMs(policy.retry.baseDelayMs, 'logging.retry.baseDelayMs')
		validatePositiveFinite(policy.retry.multiplier, 'logging.retry.multiplier')
		assertNonNegativeTimerMs(policy.retry.maxDelayMs, 'logging.retry.maxDelayMs')
		validateNumberInRange(policy.retry.jitter, 'logging.retry.jitter', 0, 1)
		assertPositiveTimerMs(policy.retry.attemptTimeoutMs, 'logging.retry.attemptTimeoutMs')
		if (policy.retry.maxAttempts > 100) {
			throw new ConfigValidationError('logging.retry.maxAttempts must be no greater than 100')
		}
	}
	if (policy.backpressure !== undefined) {
		if (policy.batching === undefined) {
			throw new ConfigValidationError('logging.backpressure requires logging.batching')
		}
		requirePolicyObject(policy.backpressure, 'backpressure')
		validateBackpressurePolicy(policy.backpressure)
	}
	if (policy.circuitBreaker !== undefined) {
		requirePolicyObject(policy.circuitBreaker, 'circuit breaker')
		validatePositiveInteger(policy.circuitBreaker.failureThreshold, 'logging.circuitBreaker.failureThreshold')
		assertNonNegativeTimerMs(policy.circuitBreaker.halfOpenAfterMs, 'logging.circuitBreaker.halfOpenAfterMs')
		validatePositiveInteger(policy.circuitBreaker.maxHalfOpenProbes, 'logging.circuitBreaker.maxHalfOpenProbes')
		if (policy.circuitBreaker.failureThreshold > 100_000 || policy.circuitBreaker.maxHalfOpenProbes > 10_000) {
			throw new ConfigValidationError('logging circuit breaker limits exceed the supported bounds')
		}
	}
}

export function snapshotBackpressurePolicy(
	policy: Readonly<BackpressurePolicy>
): BackpressurePolicy {
	if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('Logging backpressure policy must be an object')
	const data = snapshotPlainDataRecord(policy, new Set(['maxQueuedItems', 'maxQueuedBytes', 'onOverflow']), [
		'maxQueuedItems', 'maxQueuedBytes', 'onOverflow'
	])
	if (!data) throw new TypeError('Logging backpressure policy contains invalid or unexpected fields')
	const snapshot: BackpressurePolicy = {
		maxQueuedItems: data.maxQueuedItems as number,
		maxQueuedBytes: data.maxQueuedBytes as number,
		onOverflow: data.onOverflow as BackpressurePolicy['onOverflow']
	}
	validateBackpressurePolicy(snapshot)
	return snapshot
}

export function snapshotTransferringPolicies(
	policy: Readonly<TransferringPolicies>
): TransferringPolicies {
	if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('Logging transferring policy must be an object')
	const data = snapshotPlainDataRecord(policy, new Set(['batching', 'retry', 'backpressure', 'circuitBreaker']))
	if (!data) throw new TypeError('Logging transferring policy contains invalid or unexpected fields')
	const snapshotNested = (value: unknown, fields: readonly string[], name: string): Record<string, unknown> | undefined => {
		if (value === undefined) return undefined
		const nested = snapshotPlainDataRecord(value, new Set(fields), fields)
		if (!nested) throw new TypeError(`Logging ${name} policy contains invalid or unexpected fields`)
		return nested
	}
	const batching = snapshotNested(data.batching, ['maxBatch', 'maxIntervalMs', 'maxBytes'], 'batching')
	const retry = snapshotNested(data.retry, [
		'maxAttempts', 'baseDelayMs', 'multiplier', 'maxDelayMs', 'jitter', 'attemptTimeoutMs'
	], 'retry')
	const backpressure = data.backpressure === undefined ? undefined
		: snapshotBackpressurePolicy(data.backpressure as BackpressurePolicy)
	const circuitBreaker = snapshotNested(data.circuitBreaker, [
		'failureThreshold', 'halfOpenAfterMs', 'maxHalfOpenProbes'
	], 'circuit breaker')
	const snapshot: TransferringPolicies = {
		...(batching ? {batching: batching as unknown as NonNullable<TransferringPolicies['batching']>} : {}),
		...(retry ? {retry: retry as unknown as NonNullable<TransferringPolicies['retry']>} : {}),
		...(backpressure ? {backpressure} : {}),
		...(circuitBreaker ? {circuitBreaker: circuitBreaker as unknown as NonNullable<TransferringPolicies['circuitBreaker']>} : {})
	}
	validateTransferringPolicies(snapshot)
	return snapshot
}
