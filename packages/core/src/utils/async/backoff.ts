/**
 * Exponential backoff with optional jitter.
 */
import {containNativePromiseUnchecked, isolateUnexpectedThenable} from '../../runtime/async/native-promise'
import {isProxyObject} from '../safe-object'

export interface BackoffCfg {
	readonly baseDelayMs: number
	readonly multiplier: number
	readonly maxDelayMs: number
	/** 0..1 ratio */
	readonly jitter: number
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
const nativeMathRandom = Math.random.bind(Math)
const nativeMathMax = Math.max
const nativeMathMin = Math.min
const nativeMathPow = Math.pow
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor

function readFiniteDataNumber(cfg: BackoffCfg, key: keyof BackoffCfg): number {
	containNativePromiseUnchecked(cfg)
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(cfg, key)
		const value = descriptor && 'value' in descriptor ? descriptor.value : undefined
		containNativePromiseUnchecked(value)
		if (typeof value !== 'number' || !nativeNumberIsFinite(value)) {
			throw new RangeError(`backoff ${key} must be a finite data property`)
		}
		return value
	} catch(error) {
		if (error instanceof RangeError) throw error
		throw new RangeError(`backoff ${key} must be a finite data property`)
	}
}

export function exponentialBackoff(
	attempt: number,
	cfg: BackoffCfg,
	rand = nativeMathRandom
): number {
	containNativePromiseUnchecked(attempt)
	containNativePromiseUnchecked(cfg)
	containNativePromiseUnchecked(rand)
	if (!nativeNumberIsSafeInteger(attempt) || attempt < 1) {
		throw new RangeError('backoff attempt must be a positive safe integer')
	}
	if (!cfg || typeof cfg !== 'object') throw new TypeError('backoff config is invalid')
	if (isProxyObject(cfg)) throw new TypeError('backoff config must not be a Proxy')
	if (typeof rand !== 'function') throw new TypeError('backoff random source must be a function')
	const baseDelayMs = readFiniteDataNumber(cfg, 'baseDelayMs')
	const multiplier = readFiniteDataNumber(cfg, 'multiplier')
	const maxDelayMs = readFiniteDataNumber(cfg, 'maxDelayMs')
	const jitter = readFiniteDataNumber(cfg, 'jitter')
	const boundedBaseDelayMs = nativeMathMax(0, nativeMathMin(MAX_TIMER_DELAY_MS, baseDelayMs))
	const boundedMaxDelayMs = nativeMathMax(0, nativeMathMin(MAX_TIMER_DELAY_MS, maxDelayMs))
	const boundedMultiplier = nativeMathMax(0, multiplier)
	const boundedJitter = nativeMathMax(0, nativeMathMin(1, jitter))

	const pow = nativeMathMax(0, attempt - 1)
	// Avoid 0 * Infinity => NaN when a zero-delay policy is evaluated at a very
	// large attempt. Returning zero preserves the configured no-delay contract
	// without handing NaN to host timers as an immediate retry storm.
	if (boundedBaseDelayMs === 0 || boundedMaxDelayMs === 0) return 0
	const raw = nativeMathMin(boundedMaxDelayMs, boundedBaseDelayMs * nativeMathPow(boundedMultiplier, pow))
	if (boundedJitter === 0 || raw === 0) return raw
	let observedRandom: unknown
	try {
		observedRandom = rand()
		if (isolateUnexpectedThenable(observedRandom)) observedRandom = 0.5
	} catch(error) { containNativePromiseUnchecked(error); observedRandom = 0.5 }
	const boundedRandom = typeof observedRandom === 'number' && nativeNumberIsFinite(observedRandom)
		? nativeMathMax(0, nativeMathMin(1, observedRandom)) : 0.5
	const spread = raw * boundedJitter
	const jitterOffset = (boundedRandom * 2 - 1) * spread // [-spread, +spread]
	return nativeMathMax(0, nativeMathMin(boundedMaxDelayMs, raw + jitterOffset))
}
