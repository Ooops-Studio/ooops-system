/**
 * Wrap a promise-returning operation with a timeout.
 */
import {
	captureNativePromiseResult,
	containNativePromiseUnchecked,
	createNativePromise,
	isolateUnexpectedThenable,
	raceNativePromises
} from './native-promise'
import {captureSyncMethod} from './safe-abort-controller'

class TimeoutError extends Error {
	constructor(ms: number) { super(`Operation timed out after ${ms}ms`) }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
const nativeReflectApply = Reflect.apply
const nativeNumberIsFinite = Number.isFinite

function detachTimer(timer: ReturnType<typeof setTimeout>): void {
	try {
		const unref = captureSyncMethod<[], unknown>(timer, 'unref')
		if (unref) isolateUnexpectedThenable(unref())
	} catch(error) { containNativePromiseUnchecked(error) }
}

export async function withTimeout<T>(op: () => Promise<T>, ms: number): Promise<T> {
	containNativePromiseUnchecked(op)
	containNativePromiseUnchecked(ms)
	// Cleanup ownership must be fixed before the timed operation runs. Otherwise
	// that operation can replace the global with a synchronous no-op, making a
	// still-ref'ed deadline look successfully cancelled.
	const ownedClearTimeout = globalThis.clearTimeout
	const captureOperation = (): Promise<T> => {
		try {
			const operation = captureNativePromiseResult<T>(op())
			if (!operation) throw new TypeError('Timed operation must return a native Promise')
			return operation
		} catch(error) { containNativePromiseUnchecked(error); throw error }
	}
	// Host timers clamp oversized delays to a few milliseconds in some runtimes.
	// Treat values outside the portable timer range like the other explicitly
	// disabled timeout values instead of manufacturing an immediate timeout.
	if (!nativeNumberIsFinite(ms) || ms <= 0 || ms > MAX_TIMER_DELAY_MS) return await captureOperation()
	let to: ReturnType<typeof setTimeout> | undefined
	let rejectTimeout!: (error: TimeoutError) => void
	const timeout = createNativePromise<T>((_, reject) => { rejectTimeout = reject })
	let deadlineFired = false

	try {
		// Secure the deadline before physical work starts. If timer allocation
		// fails, the operation remains known-not-started and is safe to retry.
		try {
			const scheduled = setTimeout(() => {
				deadlineFired = true
				rejectTimeout(new TimeoutError(ms))
			}, ms)
			if (isolateUnexpectedThenable(scheduled)) {
				throw new TypeError('Deadline timer must be allocated synchronously')
			}
			to = scheduled
		} catch(error) {
			containNativePromiseUnchecked(error)
			throw error
		}
		// A non-conforming host may fire the callback before setTimeout returns.
		// Do not start physical work after its deadline has already elapsed.
		if (deadlineFired) return await timeout
		return await raceNativePromises([captureOperation(), timeout])
	} finally {
		// Timer disposal is cleanup only. A hostile or partially torn-down host
		// must not replace the operation's authoritative result with a cleanup
		// failure.
		if (to != null) {
			try {
				const cleanup = nativeReflectApply(ownedClearTimeout, globalThis, [to])
				if (isolateUnexpectedThenable(cleanup)) {
					// An asynchronous cleanup result cannot prove that the host timer
					// was cancelled. Detach it so an invalid host implementation cannot
					// retain the process until a potentially distant deadline.
					detachTimer(to)
				}
			} catch(error) {
				containNativePromiseUnchecked(error)
				// If cancellation itself is unavailable, do not let the orphaned
				// deadline keep a Node.js process alive.
				detachTimer(to)
			}
		}
	}
}
