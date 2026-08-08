import {describe, expect, it, vi} from 'vitest'

import {snapshotTransferringPolicies, validateTransferringPolicies} from '../../src/utils/transferring-validation'

describe('logging transferring policy validation', () => {
	it('rejects non-object policy containers', () => {
		for (const policy of [null, [], {batching: null}, {retry: []}, {circuitBreaker: false}]) {
			expect(() => validateTransferringPolicies(policy as never)).toThrow('must be an object')
		}
	})
	it('accepts valid low-level policies', () => {
		expect(() => validateTransferringPolicies({
			batching: {maxBatch: 10, maxIntervalMs: 100, maxBytes: 1_000},
			retry: {maxAttempts: 3, baseDelayMs: 0, multiplier: 2, maxDelayMs: 1_000, jitter: 0.2, attemptTimeoutMs: 5_000},
			backpressure: {maxQueuedItems: 0, maxQueuedBytes: 0, onOverflow: 'drop-newest'},
			circuitBreaker: {failureThreshold: 3, halfOpenAfterMs: 0, maxHalfOpenProbes: 1}
		})).not.toThrow()
	})

	it.each([
		[{batching: {maxBatch: Number.NaN, maxIntervalMs: 100, maxBytes: 1_000}}, 'logging.batching.maxBatch'],
		[{retry: {maxAttempts: 3, baseDelayMs: 0, multiplier: 2, maxDelayMs: 1_000, jitter: Number.NaN, attemptTimeoutMs: 5_000}}, 'logging.retry.jitter'],
		[{
			batching: {maxBatch: 1, maxIntervalMs: 1, maxBytes: 1},
			backpressure: {maxQueuedItems: 1, maxQueuedBytes: Number.POSITIVE_INFINITY, onOverflow: 'drop-oldest'}
		}, 'logging.backpressure.maxQueuedBytes'],
		[{circuitBreaker: {failureThreshold: 0, halfOpenAfterMs: 100, maxHalfOpenProbes: 1}}, 'logging.circuitBreaker.failureThreshold']
	] as const)('rejects unsafe policy %s', (policy, field) => {
		expect(() => validateTransferringPolicies(policy as never)).toThrow(field)
	})

	it('rejects legacy or unknown overflow modes', () => {
		expect(() => validateTransferringPolicies({
			batching: {maxBatch: 1, maxIntervalMs: 1, maxBytes: 1},
			backpressure: {maxQueuedItems: 1, maxQueuedBytes: 1, onOverflow: 'block' as never}
		})).toThrow('logging.backpressure.onOverflow')
	})

	it('rejects backpressure when there is no bounded batching queue', () => {
		expect(() => snapshotTransferringPolicies({
			backpressure: {maxQueuedItems: 1, maxQueuedBytes: 1, onOverflow: 'drop-newest'}
		})).toThrow('backpressure requires logging.batching')
	})

	it('rejects timer values that Node would silently truncate or clamp', () => {
		for (const policy of [
			{batching: {maxBatch: 1, maxIntervalMs: 0.5, maxBytes: 1}},
			{retry: {maxAttempts: 1, baseDelayMs: 2_147_483_648, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1}},
			{retry: {maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 2_147_483_648}},
			{circuitBreaker: {failureThreshold: 1, halfOpenAfterMs: 0.25, maxHalfOpenProbes: 1}}
		]) {
			expect(() => validateTransferringPolicies(policy as never)).toThrow('2147483647')
		}
	})

	it('rejects resource-exhausting bounds and accessor-backed policies', () => {
		expect(() => validateTransferringPolicies({batching: {
			maxBatch: 10_001, maxIntervalMs: 1, maxBytes: 1
		}})).toThrow('supported bounds')
		expect(() => validateTransferringPolicies({retry: {
			maxAttempts: 101, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1
		}})).toThrow('no greater than 100')
		const getter = vi.fn(() => ({maxBatch: 1, maxIntervalMs: 1, maxBytes: 1}))
		const policy = Object.defineProperty({}, 'batching', {enumerable: true, get: getter})
		expect(() => snapshotTransferringPolicies(policy as never)).toThrow('invalid or unexpected')
		expect(getter).not.toHaveBeenCalled()
	})
})
