/**
 * @file Shared constants for rate limit engines.
 * These constants are used across all memory-based engines for consistent cleanup behavior.
 */

import {
	MAX_SAFE_MICROTOKEN_AMOUNT,
	MICROTOKENS_PER_TOKEN,
	MIN_MICROTOKEN_AMOUNT
} from '../../constants'
import {RateLimitBackendError} from '../backend-error'

export {
	MAX_SAFE_MICROTOKEN_AMOUNT,
	MICROTOKENS_PER_TOKEN,
	MIN_MICROTOKEN_AMOUNT
} from '../../constants'

/**
 * Cleanup interval in milliseconds.
 * Engines perform deterministic cleanup every 60 seconds to prevent unbounded memory growth.
 */
export const CLEANUP_INTERVAL_MS = 60_000

/** Bound full-map retries when a full memory engine receives new-key traffic. */
export const CAPACITY_CLEANUP_RETRY_MS = 1_000

/**
 * Maximum keys threshold for triggering cleanup.
 * If the number of keys in the engine's storage exceeds this threshold,
 * cleanup is triggered immediately (in addition to timer-based cleanup).
 */
export const MAX_KEYS_THRESHOLD = 10_000

/** Refuse new active keys once cleanup cannot bring a memory engine below its bound. */
export function assertMemoryKeyCapacity(
	store: ReadonlyMap<string, unknown>,
	key: string,
	engineName: string
): void {
	if (!store.has(key) && store.size >= MAX_KEYS_THRESHOLD) {
		throw new RateLimitBackendError(`${engineName} memory engine reached its maximum active-key capacity`)
	}
}

/**
 * Conversion factor: 1 token = 1,000,000 microtokens
 * This provides 6 decimal places of precision, eliminating drift between memory and Redis.
 * Used by token-bucket engines for consistent precision handling.
 */
/** Validate values stored or compared as microtokens. */
export function assertMicrotokenSafeAmount(amount: number, label: string, allowZero = false): void {

	if (!Number.isFinite(amount) || amount > MAX_SAFE_MICROTOKEN_AMOUNT || (!allowZero && amount <= 0) || (allowZero && amount < 0)) {
		throw new Error(`${label} must be ${allowZero ? 'non-negative' : 'positive'} and no greater than ${MAX_SAFE_MICROTOKEN_AMOUNT} for microtoken precision.`)
	}

}

/**
 * Validate a refill rate without requiring it to add a whole microtoken per
 * millisecond. Slow rates accumulate fractional microtokens over time.
 */
export function assertPositiveFiniteRefillRate(rate: number, label: string): void {

	if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_SAFE_MICROTOKEN_AMOUNT) {
		throw new Error(`${label} must be positive and no greater than ${MAX_SAFE_MICROTOKEN_AMOUNT} for microtoken precision.`)
	}

}

/** Ensure a bucket can calculate finite reset and cleanup deadlines. */
export function assertFiniteRefillDuration(capacity: number, rate: number, label: string): void {

	if (!Number.isFinite(capacity / rate) || capacity / rate > Number.MAX_SAFE_INTEGER) {
		throw new Error(`${label} produces an unrepresentable refill duration.`)
	}

}

/** Validate quantities that are rounded to integer microtokens for storage/admission. */
export function assertRepresentableMicrotokenAmount(amount: number, label: string, allowZero = false): void {
	assertMicrotokenSafeAmount(amount, label, allowZero)
	if (amount > 0 && amount < MIN_MICROTOKEN_AMOUNT) {
		throw new Error(`${label} must be zero or at least ${MIN_MICROTOKEN_AMOUNT} (one microtoken).`)
	}
	const microtokens = amount * MICROTOKENS_PER_TOKEN
	if (Math.abs(microtokens - Math.round(microtokens)) > 0.000_001) {
		throw new Error(`${label} must be exactly representable with at most six decimal places.`)
	}
}

/** Validate a consumption cost before it can reach mutable engine state. */
export function assertPositiveFiniteCost(cost: number): void {

	if (!Number.isFinite(cost) || cost <= 0) {
		throw new Error('checkAndConsume requires a finite cost > 0. Use peek() for probe operations.')
	}

}

/** Validate an admission-probe cost without changing the zero-cost probe semantics. */
export function assertNonNegativeFiniteCost(cost: number): void {

	if (!Number.isFinite(cost) || cost < 0) {
		throw new Error('peek requires a finite cost >= 0.')
	}

}

/** Fixed-window counters require exact integer arithmetic for admission decisions. */
export function assertFixedWindowQuantity(value: number, label: string, allowZero = false): void {
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
		throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`)
	}
}

/** Validate the shared limit/window boundary used by every direct engine call. */
export function assertPositiveFiniteRateLimitParameters(limit: number, windowMs: number): void {

	if (!Number.isFinite(limit) || limit <= 0) {
		throw new Error('Rate limit engines require a finite limit > 0.')
	}
	if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
		throw new Error('Rate limit engines require windowMs to be a positive safe integer.')
	}

}

/**
 * Generate a consistent Redis key with algorithm namespace.
 * Format: rl:<algorithm>:{<key>}[:<suffix>]. The hash tag keeps every key
 * derived by one Lua script in the same Redis Cluster slot.
 *
 * @param algorithm - The rate limit algorithm name
 * @param key - The complete, opaque base key
 * @param suffix - Optional suffix (e.g., window start, component name)
 * @returns Namespaced Redis key
 */
export function createRedisKey(
	algorithm: 'fixed-window' | 'token-bucket',
	key: string,
	suffix?: string | number
): string {

	// Escape the escape marker first so literal "%7B" cannot alias a key that
	// originally contained "{".
	const safeHashTag = key.replace(/%/gu, '%25').replace(/\{/gu, '%7B').replace(/\}/gu, '%7D')
	const parts = ['rl', algorithm, `{${safeHashTag}}`]
	if (suffix !== undefined) {
		parts.push(String(suffix))
	}
	return parts.join(':')

}
