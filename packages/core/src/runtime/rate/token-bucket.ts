import {isProxyObject} from '../../utils/safe-object'
import {containNativePromiseUnchecked, isolateUnexpectedThenable} from '../async/native-promise'
import type {MonotonicMillisClock} from '../time/monotonic-clock'

const nativeReflectApply = Reflect.apply
const nativeMathMin = Math.min
const nativeNumberIsFinite = Number.isFinite
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeNumberMaxSafeInteger = Number.MAX_SAFE_INTEGER
const nativeObjectPrototype = Object.prototype

export interface TokenBucketSnapshot {
	readonly tokens: number
	readonly capacity: number
	readonly lastRefillAt: number
}

export interface TokenBucket {
	tryRemove(tokens: number): boolean
	refill(now?: number): void
	snapshot(): TokenBucketSnapshot
}

function requirePositiveBounded(value: number, name: string): void {
	containNativePromiseUnchecked(value)
	if (!nativeNumberIsFinite(value) || value <= 0 || value > nativeNumberMaxSafeInteger) {
		throw new RangeError(`${name} must be positive, finite, and no greater than Number.MAX_SAFE_INTEGER`)
	}
}

type ClockNow = (this: MonotonicMillisClock) => number

function captureClockNow(clock: unknown): ClockNow | undefined {
	containNativePromiseUnchecked(clock)
	if (!clock || (typeof clock !== 'object' && typeof clock !== 'function')) return undefined
	if (isProxyObject(clock)) return undefined
	let current: object | null = clock as object
	try {
		for (let depth = 0; current && current !== nativeObjectPrototype && depth < 16; depth += 1) {
			if (isProxyObject(current)) return undefined
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, 'now')
			if (descriptor) {
				if (!('value' in descriptor)) return undefined
				containNativePromiseUnchecked(descriptor.value)
				return typeof descriptor.value === 'function' ? descriptor.value as ClockNow : undefined
			}
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

/** Creates an in-memory token bucket driven by a caller-owned monotonic clock. */
export function createTokenBucket(
	tokensPerInterval: number,
	intervalMs: number,
	burst: number,
	clock: MonotonicMillisClock
): TokenBucket {
	containNativePromiseUnchecked(clock)
	requirePositiveBounded(tokensPerInterval, 'tokensPerInterval')
	requirePositiveBounded(intervalMs, 'intervalMs')
	requirePositiveBounded(burst, 'burst')

	const clockNow = captureClockNow(clock)
	if (!clockNow) throw new TypeError('clock.now must be a stable function')
	let readingClock = false
	let lastObservedClock = 0
	const readClock = (): number => {
		// A caller-owned clock can synchronously invoke the bucket again. Returning
		// the last observation keeps that re-entry bounded without advancing time.
		if (readingClock) return lastObservedClock
		readingClock = true
		try {
			const observed = nativeReflectApply(clockNow, clock, []) as number
			if (isolateUnexpectedThenable(observed)) {
				throw new RangeError('clock.now() must return synchronously')
			}
			if (!nativeNumberIsFinite(observed)) throw new RangeError('clock.now() must return a finite number')
			lastObservedClock = observed
			return observed
		} catch(error) {
			containNativePromiseUnchecked(error)
			throw error
		} finally {
			readingClock = false
		}
	}

	const initialNow = readClock()
	if (!nativeNumberIsFinite(initialNow)) {
		throw new RangeError('clock.now() must return a finite number')
	}

	let availableTokens = burst
	let lastRefillAt = initialNow

	function refill(now = readClock()): void {
		containNativePromiseUnchecked(now)
		if (!nativeNumberIsFinite(now)) {
			throw new RangeError('refill time must be a finite number')
		}

		const elapsed = now - lastRefillAt
		if (elapsed <= 0) return

		const replenished = (elapsed / intervalMs) * tokensPerInterval
		availableTokens = nativeMathMin(burst, availableTokens + replenished)
		lastRefillAt = now
	}

	return {
		tryRemove(tokens: number): boolean {
			requirePositiveBounded(tokens, 'tokens')
			refill()
			if (availableTokens < tokens) return false
			const remaining = availableTokens - tokens
			// At large capacities, a positive cost smaller than the current ULP can
			// round back to the same value. Treat that request as denied instead of
			// granting an unlimited number of zero-cost removals.
			if (remaining === availableTokens) return false
			availableTokens = remaining
			return true
		},
		refill,
		snapshot: () => ({
			tokens: availableTokens,
			capacity: burst,
			lastRefillAt
		})
	}
}
