/**
 * @file Clock utility helpers for consistent timestamp access.
 * Provides unified interfaces for getting current time using clock abstraction.
 */

import type {Clock} from '../contracts/clock'
import {containNativePromiseUnchecked} from '../runtime/async/native-promise'
import {captureSyncMethod, isolateUnexpectedThenable} from '../runtime/async/safe-abort-controller'

const nativeDateNow = Date.now.bind(Date)
const nativeNumberIsFinite = Number.isFinite

function readClock(clock: Clock): number {
	const now = captureSyncMethod<[], unknown>(clock, 'now')
	if (!now) throw new TypeError('Clock must provide a stable data-method now()')
	const value = now()
	if (isolateUnexpectedThenable(value)) throw new TypeError('Clock now() must return synchronously')
	if (typeof value !== 'number' || !nativeNumberIsFinite(value)) {
		throw new RangeError('Clock now() must return a finite number')
	}
	return value
}

/**
 * Get current timestamp using clock abstraction if provided, otherwise fall back to Date.now().
 * This ensures consistent time access across services while maintaining testability.
 *
 * @param clock - Optional clock instance for time abstraction
 * @returns Current timestamp in milliseconds
 *
 * @example
 * ```ts
 * const now = getNow(clock) // Uses clock.now() if provided
 * const now = getNow() // Falls back to Date.now()
 * ```
 */
export function getNow(clock?: Clock): number {
	containNativePromiseUnchecked(clock)
	return clock ? readClock(clock) : nativeDateNow()
}

/**
 * Normalize a timestamp to milliseconds since epoch.
 * If timestamp is provided, returns it as-is. Otherwise, uses current time from clock.
 *
 * @param timestamp - Optional timestamp (if not provided, uses current time from clock)
 * @param clock - Clock instance for current time
 * @returns Timestamp in milliseconds since epoch
 */
export function normalizeTimestamp(timestamp: number | undefined, clock: Clock): number {
	containNativePromiseUnchecked(timestamp)
	containNativePromiseUnchecked(clock)
	if (timestamp !== undefined) {
		return timestamp
	}
	return readClock(clock)
}
