/**
 * @file High-resolution clock wrapper for performance measurements.
 * Extends Clock with high-resolution timing using bigint nanoseconds.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'

import {ignoreRuntimePromiseRejection, isRuntimePromise, isRuntimeProxy} from '../utils/safe-object'

/**
 * High-resolution clock interface extending Clock with nanosecond precision
 */
export interface HighResClock extends Clock {

	/** High-resolution monotonic time in nanoseconds (bigint) */
	nowHr(): bigint

	/** Current time in milliseconds (inherited from Clock) */
	now(): number
}

/**
 * Options for creating a high-resolution clock
 */
export interface HighResClockOptions {

	/** Base clock to wrap (defaults to system clock) */
	clock?: Clock
}

const captureClockMethod = (clock: unknown, key: 'now' | 'nowHr'): (() => unknown) | undefined => {
	if (!clock || (typeof clock !== 'object' && typeof clock !== 'function') || isRuntimeProxy(clock)) return undefined
	try {
		let owner: object | null = clock
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...args: never[]) => unknown
				let valid = true
				return () => {
					if (!valid) return undefined
					valid = false
					let result: unknown
					try {
						result = Reflect.apply(method, clock, [])
					} catch(error) {
						valid = true
						throw error
					}
					if (isRuntimePromise(result)) {
						ignoreRuntimePromiseRejection(result)
					} else valid = true
					return result
				}
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

/**
 * Create a high-resolution clock that wraps an existing clock.
 * Uses Node.js hrtime.bigint() or performance.now() for high-resolution timing.
 *
 * @param options - Clock options
 * @returns High-resolution clock instance
 */
export function createHighResClock(options: HighResClockOptions = {}): HighResClock {
	if (!options || typeof options !== 'object' || isRuntimeProxy(options)) {
		throw new Error('High-resolution clock options must be an object')
	}
	const clockDescriptor = Object.getOwnPropertyDescriptor(options, 'clock')
	if (clockDescriptor && !('value' in clockDescriptor)) {
		throw new Error('High-resolution clock requires clock to be a data property')
	}
	const baseClock = clockDescriptor?.value ?? {now: Date.now}
	const providedNow = captureClockMethod(baseClock, 'now')
	if (!providedNow) {
		throw new Error('High-resolution clock requires a clock with now()')
	}
	let lastNow = Number.NEGATIVE_INFINITY
	const now = () => {
		let current = Number.NaN
		try { current = providedNow() as number } catch { /* use the retained timestamp */ }
		if (!Number.isFinite(current)) {
			if (!Number.isFinite(lastNow)) lastNow = Date.now()
			return lastNow
		}
		return lastNow = Math.max(lastNow, current)
	}
	const providedNowHr = captureClockMethod(baseClock, 'nowHr')
	if (providedNowHr) {
		let lastNowHr = 0n
		return {
			now,
			nowHr: () => {
				let current: unknown
				try {
					current = providedNowHr()
				} catch {
					return lastNowHr
				}
				if (typeof current !== 'bigint' || current < 0n) return lastNowHr
				return lastNowHr = current > lastNowHr ? current : lastNowHr
			}
		}
	}

	// Check for Node.js hrtime.bigint() (Node 10.7+)
	if (typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function') {
		// Use hrtime.bigint() for high-resolution timing
		const origin = process.hrtime.bigint()

		return {
			now,
			nowHr: () => process.hrtime.bigint() - origin
		}
	}

	// Check for performance.now() (browser or Node 16+)
	const perf = typeof performance !== 'undefined' && performance
	if (perf && typeof perf.now === 'function') {
		const origin = perf.now()
		return {
			now,
			nowHr: () => BigInt(Math.floor((perf.now() - origin) * 1_000_000))
		}
	}

	// Fallback: use Date.now() with millisecond precision
	// This is not ideal but provides compatibility
	const origin = Date.now()
	return {
		now,
		nowHr: () => BigInt(Math.floor((Date.now() - origin) * 1_000_000))
	}
}

/**
 * Convert bigint nanoseconds to milliseconds
 *
 * @param ns - Nanoseconds as bigint
 * @returns Milliseconds as number
 */
export function nsToMs(ns: bigint): number {

	return Number(ns) / 1_000_000
}
