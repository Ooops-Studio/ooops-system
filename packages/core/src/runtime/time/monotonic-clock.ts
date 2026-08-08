/**
 * @file Monotonic clock in milliseconds (never goes backwards). DI-free.
 * Uses performance.now() when available, otherwise hrtime.bigint() or a fallback.
 * Example: const mono = createMonotonicClock(); const dt = mono.now() - start
 */

import {containNativePromiseUnchecked, isolateUnexpectedThenable} from '../async/native-promise'

const nativeReflectApply = Reflect.apply

export interface MonotonicMillisClock {
	/** A monotonically increasing millisecond counter (not wall time) */
	now(): number
}

const nativeDateNow = Date.now.bind(Date)
const nativeNumberIsFinite = Number.isFinite
const NativeNumber = Number

function normalizedClock(read: () => unknown): MonotonicMillisClock {
	let last = 0
	return {
		now: () => {
			try {
				const candidate = read()
				if (isolateUnexpectedThenable(candidate)) return last
				if (typeof candidate === 'number' && nativeNumberIsFinite(candidate) && candidate >= last) last = candidate
			} catch(error) {
				containNativePromiseUnchecked(error)
				/* Preserve the last authoritative monotonic observation. */
			}
			return last
		}
	}
}

export function createMonotonicClock(): MonotonicMillisClock {
	// Prefer WHATWG performance if present (browser / Node 16+)
	try {
		const perf = typeof performance !== 'undefined' && performance
		if (perf && typeof perf.now === 'function') {
			const readPerformance = perf.now.bind(perf)
			return normalizedClock(readPerformance)
		}
	} catch(error) {
		containNativePromiseUnchecked(error)
		/* Continue to the independent Node fallback. */
	}

	// Node fallback: hrtime.bigint()
	try {
		const hrtime = typeof process !== 'undefined' ? process.hrtime : undefined
		if (typeof hrtime?.bigint === 'function') {
			const readHrtime = hrtime.bigint.bind(hrtime)
			const origin = readHrtime()
			if (isolateUnexpectedThenable(origin) || typeof origin !== 'bigint') throw new TypeError('Invalid hrtime origin')
			return normalizedClock(() => {
				const current = readHrtime()
				if (isolateUnexpectedThenable(current) || typeof current !== 'bigint') return undefined
				return (nativeReflectApply(NativeNumber, undefined, [current - origin]) as number) / 1_000_000
			})
		}
	} catch(error) {
		containNativePromiseUnchecked(error)
		/* Continue to the captured wall-clock fallback. */
	}

	// Last-resort monotonic-ish counter (not ideal, but stable per process)
	return normalizedClock(nativeDateNow)
}
