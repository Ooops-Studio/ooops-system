import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {
	captureSyncMethod,
	isolateUnexpectedThenable
} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {isPlainObject} from '@ooopsstudio/core/utils/guards'

const nativeMathTrunc = Math.trunc
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsSafeInteger = Number.isSafeInteger

/** Capture a callable capability without invoking accessor-backed properties. */
export function captureCapability<Args extends unknown[], Result>(
	target: unknown,
	key: PropertyKey
): ((...args: Args) => Result) | undefined {
	const capability = captureSyncMethod<Args, Result>(target, key)
	if (!capability) return undefined
	return (...args: Args): Result => {
		const result = capability(...args)
		isolateUnexpectedThenable(result)
		return result
	}
}

/** Capture a finite method set once so later rewiring cannot change a port. */
export function captureCapabilities(
	target: unknown,
	keys: readonly string[]
): Readonly<Record<string, (...args: unknown[]) => unknown>> | undefined {
	const result: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<
		string,
		(...args: unknown[]) => unknown
	>
	let captured = 0
	for (const key of keys) {
		const method = captureCapability<unknown[], unknown>(target, key)
		if (!method) continue
		result[key] = method
		captured += 1
	}
	return captured > 0 ? Object.freeze(result) : undefined
}

/** Snapshot a clock method once and reject invalid timestamps at the boundary. */
export function captureClock(clock: Clock): Clock {
	const now = captureCapability<[], number>(clock, 'now')
	if (!now) throw new Error('Tracing clock must provide now()')
	return Object.freeze({
		now: () => {
			const value = now()
			if (!nativeNumberIsFinite(value) || value < 0 || !nativeNumberIsSafeInteger(nativeMathTrunc(value))) {
				throw new Error('Tracing clock returned an invalid timestamp')
			}
			return value
		}
	})
}

/** Snapshot a bounded plain data object without executing accessors. */
export function snapshotDataFields(
	value: unknown,
	maxFields: number,
	maxKeyLength: number,
	allowed?: ReadonlySet<string>
): Readonly<Record<string, unknown>> {
	// Reject Proxies before enumeration: an ownKeys trap can materialize an
	// attacker-sized key list before the loop's field budget can stop it.
	if (!isPlainObject(value)) throw new TypeError()
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	let fields = 0
	for (const key in value) {
		if (++fields > maxFields || key.length > maxKeyLength) throw new TypeError()
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (!descriptor) continue
		if (!descriptor.enumerable || !('value' in descriptor) || (allowed && !allowed.has(key))) throw new TypeError()
		result[key] = descriptor.value
	}
	return Object.freeze(result)
}
