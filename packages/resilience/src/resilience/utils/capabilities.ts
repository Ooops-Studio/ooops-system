import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {
	captureSyncMethod,
	isolateUnexpectedThenable
} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

export {captureNativePromise, isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

/** Capture a capability method once without evaluating accessor-backed fields. */
export function captureCapability<TArguments extends unknown[], TResult>(
	owner: unknown,
	key: PropertyKey
): ((...args: TArguments) => TResult) | undefined {
	return captureSyncMethod<TArguments, TResult>(owner, key)
}

/** Capture an optional injected dependency, but reject it when explicitly malformed. */
export function captureInjectedCapability<TArguments extends unknown[], TResult>(
	owner: unknown,
	key: PropertyKey
): ((...args: TArguments) => TResult) | undefined {
	const capability = captureCapability<TArguments, TResult>(owner, key)
	if (owner !== undefined && !capability) {
		throw new TypeError('Invalid port')
	}
	return capability
}

/** Freeze the injected time source so runtime behavior cannot be rewired later. */
export function captureClock(clock: Clock): Clock {
	const now = captureCapability<[], number>(clock, 'now')
	if (!now) throw new TypeError('Invalid clock.now')
	return Object.freeze({
		now(): number {
			const value = now()
			isolateUnexpectedThenable(value)
			if (!Number.isFinite(value) || Math.abs(value) > 9_007_197_107_257_344) throw new Error('invalid clock')
			return value
		}
	})
}
