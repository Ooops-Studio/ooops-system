/**
 * @file Timeout engine - pure L1 logic for timeout/cancellation wrapper.
 * No observability, no orchestration - pure timeout logic.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {TimedOutError} from '@ooopsstudio/core/contracts/resilience'
import {createSafeAbortController} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {captureClock, isolateUnexpectedThenable} from '../utils/capabilities'
import {getPlainDataDescriptors} from '../utils/data-object'

import type {ResilienceOperationContext} from './internal-types'
import {isSafeTimerDelay, MAX_TIMER_DELAY_MS} from './timer-limits'

/**
 * Timeout engine options.
 */
export interface TimeoutEngineOptions {

	/** Clock for time calculations */
	readonly clock: Clock

}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
	try { if (timer !== undefined) clearTimeout(timer) } catch { /* cleanup is best effort */ }
}

/**
 * Create a timeout wrapper.
 * Pure logic - no observability, no orchestration.
 */
export function createTimeoutEngine(options: TimeoutEngineOptions) {

	const clock = captureClock(options.clock)

	return {

		/**
		 * Wrap operation with timeout.
		 * Distinguishes canceled vs timed-out vs failed.
		 */
		async withTimeout<T>(
			fn: (signal: AbortSignal) => Promise<T>,
			timeoutMs: number,
			context: ResilienceOperationContext,
			options?: {
				parentSignal?: AbortSignal
				onOperationSettled?: (settled: Promise<void>) => void
			}
		): Promise<T> {

			if (!isSafeTimerDelay(timeoutMs)) {
				throw new Error(
					`[Resilience] Timeout must be > 0 and <= ${MAX_TIMER_DELAY_MS}`
				)
			}
			let parentSignal: AbortSignal | undefined
			let onOperationSettled: ((settled: Promise<void>) => void) | undefined
			if (options !== undefined) {
				const descriptors = getPlainDataDescriptors(options, 2)
				if (!descriptors || Object.keys(descriptors).some((key) => !['parentSignal', 'onOperationSettled'].includes(key))) {
					throw new Error('[Resilience] Timeout options must be a plain data object')
				}
				parentSignal = descriptors.parentSignal?.value as AbortSignal | undefined
				onOperationSettled = descriptors.onOperationSettled?.value as typeof onOperationSettled
			}

			clock.now()
			const abortController = createSafeAbortController()
			let abortReason: 'timeout' | 'cancelled' | undefined
			let timeoutError: TimedOutError | undefined
			let timeoutId: ReturnType<typeof setTimeout> | undefined
			let onInternalAbort: (() => void) | undefined
			let operationSettled = false

			const makeTimeoutError = () => timeoutError ??= new TimedOutError(context, timeoutMs, clock.now())
			const makeCancellationError = () => Object.assign(new Error('Resilience operation cancelled'), {
				name: 'AbortError',
				code: 'ABORT_ERR'
			})
			const rejectWithTimeoutError = (reject: (reason?: unknown) => void): void => {
				try {
					reject(makeTimeoutError())
				} catch(error) {
					// Timer and abort listeners must never throw into the host event loop.
					// Surface a failed clock through the wrapper promise instead.
					reject(error)
				}
			}

			const onParentAbort = () => {
				if (operationSettled) return
				// The first abort source is authoritative. Timeout dispatch invokes
				// protected listeners synchronously, and one of those listeners may
				// cascade into the parent signal; that cascade must not relabel an
				// already-authoritative timeout as caller cancellation.
				abortReason ??= 'cancelled'
				abortController.abort()
			}
			const removeParentAbort = () => {
				try { isolateUnexpectedThenable(parentSignal?.removeEventListener?.('abort', onParentAbort)) } catch { /* cleanup is best effort */ }
			}

			if (parentSignal) {
				if (parentSignal.aborted) {
					onParentAbort()
				} else {
					try {
						if (isolateUnexpectedThenable(parentSignal.addEventListener('abort', onParentAbort, {once: true}))) {
							throw new Error('[Resilience] AbortSignal.addEventListener must complete synchronously')
						}
						// Custom signals may become aborted without dispatching while the
						// listener is being published. Recheck after installation so the
						// protected operation cannot start through that cancellation gap.
						if (parentSignal.aborted) onParentAbort()
					} catch(error) {
						// A custom signal may install before throwing. Roll the listener back
						// so failed wrapper construction cannot retain a controller forever.
						removeParentAbort()
						throw error
					}
				}
			}
			if (abortController.signal.aborted) {
				removeParentAbort()
				throw makeCancellationError()
			}

			try {

				let rejectTimeout!: (reason?: unknown) => void
				const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject })
				timeoutId = setTimeout(() => {
					if (operationSettled || abortReason !== undefined) return
					abortReason = 'timeout'
					abortController.abort()
					rejectWithTimeoutError(rejectTimeout)
				}, timeoutMs)
				const cancellation = new Promise<never>((_, reject) => {
					onInternalAbort = () => {
						if (abortReason === 'cancelled') {
							reject(makeCancellationError())
						}
					}
					// Timers and external abort events cannot run until this synchronous
					// listener installation completes.
					abortController.signal.addEventListener('abort', onInternalAbort, {once: true})
				})
				const operation = Promise.resolve().then(() => {
					if (abortController.signal.aborted) throw makeTimeoutError()
					return fn(abortController.signal)
				}).then(
					(value) => {
						if (abortReason === undefined) operationSettled = true
						return value
					},
					(error: unknown) => {
						if (abortReason === undefined) operationSettled = true
						throw error
					}
				)
				try {
					isolateUnexpectedThenable(onOperationSettled?.(
						operation.then(() => undefined, () => undefined)
					))
				} catch {
					// Ownership observation must not replace or detach protected work.
				}

				const result = await Promise.race([operation, timeout, cancellation])
				// An abort-aware operation may resolve synchronously from its abort
				// listener. Never let that cooperative cleanup win the race after the
				// timeout or parent cancellation has already become authoritative.
				if (abortReason === 'timeout') throw makeTimeoutError()
				if (abortReason === 'cancelled') throw makeCancellationError()

				clearTimer(timeoutId)
				if (onInternalAbort) {
					abortController.signal.removeEventListener('abort', onInternalAbort)
				}
				removeParentAbort()

				return result

			} catch(error) {

				clearTimer(timeoutId)
				if (onInternalAbort) {
					abortController.signal.removeEventListener('abort', onInternalAbort)
				}
				removeParentAbort()

				// Check if aborted (timeout)
				if (abortController.signal.aborted) {
					if (abortReason === 'cancelled') throw makeCancellationError()
					throw makeTimeoutError()

				}

				// Re-throw original error
				throw error

			} finally {

				clearTimer(timeoutId)
				if (onInternalAbort) {
					abortController.signal.removeEventListener('abort', onInternalAbort)
				}
				removeParentAbort()

			}

		},

		/**
		 * Destroy engine (no-op for timeout engine, but required for interface).
		 */
		destroy(): void {

			// No resources to clean up

		}

	}

}
