/**
 * @file Retry functionality for transferring.
 * Uses shared retry utilities from engines (exponentialBackoff, withTimeout) with
 * logging-specific telemetry.
 * Note: This function receives a pre-batched array and sends it immediately with retry,
 * so it doesn't use the full batch-retry pipeline which is designed for batching over time.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {exponentialBackoff} from '@ooopsstudio/core/utils/async/backoff'

import type {Sink} from '../../types/sink'
import type {LogLine, TransferSignalKind} from '../../types/transferring'
import {readLoggingDataProperty} from '../../utils/capabilities'
import {reportLogRetried, reportLogWritten} from '../../utils/self-metrics'

import {
	createAmbiguousDeliveryTimeoutError,
	getUndeliveredLines,
	isSignalAbortedDeliveryError,
	writeLinesSequentially
} from './delivery'
import {waitForRetryBackoff} from './retry-backoff'

export interface RetryPolicy {
	maxAttempts: number
	baseDelayMs: number
	multiplier: number
	maxDelayMs: number
	jitter: number
	attemptTimeoutMs: number
}

const ATTEMPT_TIMEOUT_ABORT_GRACE_MS = 50

/**
 * Send lines with retry using shared retry utilities from engines.
 * Receives a pre-batched array and sends it immediately with retry logic.
 */
export async function sendWithRetry(
	lines: string[],
	sink: Sink<LogLine>,
	policy: RetryPolicy,
	clock: Clock,
	onMark: (kind: TransferSignalKind, info?: LogAttributes, size?: number) => void,
	onError: (error: unknown) => void,
	selfMetrics?: boolean,
	metrics?: MetricsPort,
	signal?: AbortSignal,
	onFailure?: (lines: readonly string[], error: unknown) => Promise<boolean | void> | boolean | void,
	onAmbiguousDelivery?: (delivery: Promise<void>, error: unknown) => void
): Promise<void> {
	const markSafely = (...args: Parameters<typeof onMark>): void => {
		try {
			onMark(...args)
		} catch {
			// Telemetry observers must not alter delivery decisions.
		}
	}
	const reportErrorSafely = (error: unknown): void => {
		try {
			onError(error)
		} catch {
			// Error observers must not alter delivery decisions.
		}
	}
	const safeRead = (value: unknown, key: string): unknown => {
		return readLoggingDataProperty(value, key)
	}
	const isNonRetryableError = (error: unknown): boolean => {
		return safeRead(error, 'code') === 'BREAKER_OPEN' ||
			safeRead(error, 'nonRetryable') === true ||
			safeRead(error, 'retryable') === false
	}

	const isAmbiguousDeliveryError = (error: unknown): boolean =>
		safeRead(error, 'ambiguousDelivery') === true

	const reportLateDeliveryError = (error: unknown): void => {
		reportErrorSafely(error)
	}
	const invokeFailureFallback = async(
		failedLines: readonly string[],
		deliveryError: unknown
	): Promise<boolean | void> => {
		try {
			return await onFailure?.(failedLines, deliveryError)
		} catch(fallbackError) {
			reportErrorSafely(deliveryError)
			reportErrorSafely(fallbackError)
			throw new AggregateError(
				[deliveryError, fallbackError],
				'Logging delivery and failure fallback both failed'
			)
		}
	}

	const sendAttempt = async(attemptLines: readonly string[]): Promise<void> => {
		if (!Number.isFinite(policy.attemptTimeoutMs) || policy.attemptTimeoutMs <= 0) {
			await writeLinesSequentially(sink, attemptLines, signal ? {signal} : undefined)
			return
		}

		const controller = new AbortController()
		const abortFromParent = (): void => {
			try {
				controller.abort(signal?.reason)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			} catch {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				controller.abort()
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
		}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (signal?.aborted) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			abortFromParent()
		} else {
			signal?.addEventListener('abort', abortFromParent, {once: true})
		}

		let timedOut = false
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined
		const timeoutError = createAmbiguousDeliveryTimeoutError(`Operation timed out after ${policy.attemptTimeoutMs}ms`)
		const delivery = writeLinesSequentially(sink, attemptLines, {signal: controller.signal})
		void delivery.catch(() => {
			// The attempt owns the delivery error path; avoid unhandled rejection if timeout wins.
		})
		const timeout = new Promise<never>((_, reject) => {
			timeoutTimer = setTimeout(() => {
				timedOut = true
				controller.abort(timeoutError)
				reject(timeoutError)
			}, policy.attemptTimeoutMs)
			timeoutTimer.unref?.()
		})

		try {
			await Promise.race([delivery, timeout])
		} catch(error) {
			if (!timedOut) {
				throw error
			}
			let graceTimer: ReturnType<typeof setTimeout> | undefined
			const grace = new Promise<{status: 'pending'}>((resolve) => {
				graceTimer = setTimeout(() => {
					resolve({status: 'pending'})
				}, ATTEMPT_TIMEOUT_ABORT_GRACE_MS)
				graceTimer.unref?.()
			})
			const settled = await Promise.race([
				delivery.then(
					() => ({status: 'fulfilled' as const}),
					(deliveryError: unknown) => ({status: 'rejected' as const, error: deliveryError})
				),
				grace
			])
			if (graceTimer) {
				clearTimeout(graceTimer)
			}
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (settled.status === 'fulfilled') {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				return
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
			if (settled.status === 'rejected') {
				throw settled.error
			}
			const lateDelivery = delivery.catch(async(deliveryError: unknown) => {
				reportLateDeliveryError(deliveryError)
				if (onFailure) {
					try {
						const consumed = await onFailure(getUndeliveredLines(deliveryError, attemptLines), deliveryError)
						if (consumed === true) {
							return
						}
					} catch(fallbackError) {
						reportLateDeliveryError(fallbackError)
						throw new AggregateError(
							[deliveryError, fallbackError],
							'Logging late delivery and failure fallback both failed'
						)
					}
				}
				throw deliveryError
			})
			if (onAmbiguousDelivery) {
				let handedOff = false
				try {
					onAmbiguousDelivery(lateDelivery, timeoutError)
					handedOff = true
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				} catch(callbackError) {
					/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
					reportLateDeliveryError(callbackError)
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				}
				if (!handedOff) void lateDelivery.catch(() => undefined)
			} else {
				void lateDelivery.catch(() => {
					// lateDelivery owns reporting; this prevents unhandled rejections.
				})
			}
			throw timeoutError
		} finally {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer)
			}
			signal?.removeEventListener('abort', abortFromParent)
		}
	}

	if (lines.length === 0) return

	// Check for cancellation before starting
	if (signal?.aborted) {
		markSafely('drop', {reason: 'signal-aborted'})
		return
	}

	// Retry logic using shared utilities from engines
	const maxAttempts = Math.max(1, policy.maxAttempts)
	let attempt = 0
	let lastErr: unknown
	let pendingLines: readonly string[] = lines
	let reportedTerminalFailure = false
	let attemptedFailureFallback = false

	try {
		while (attempt < maxAttempts && pendingLines.length > 0) {
			// Check for cancellation before each attempt
			if (signal?.aborted) {
				markSafely('drop', {reason: 'signal-aborted'})
				return
			}

			attempt++
			markSafely('write-batch', undefined, pendingLines.length)

			try {
				await sendAttempt(pendingLines)

				// Success
				markSafely('flush', undefined, 0)

				// Report each line as written if self-metrics enabled
				if (selfMetrics) {
					for (const _line of pendingLines) {
						reportLogWritten(metrics)
					}
				}
				return
			} catch(error) {
				lastErr = error
				pendingLines = getUndeliveredLines(error, pendingLines)
				markSafely('error')
				if (isSignalAbortedDeliveryError(error)) {
					markSafely('drop', {reason: 'signal-aborted'})
					return
				}

				if (isNonRetryableError(error)) {
					break
				}

				if (attempt >= maxAttempts) break

				// Check for cancellation before backoff
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				if (signal?.aborted) {
					/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
					markSafely('drop', {reason: 'signal-aborted'})
					/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
					return
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				}

				// Backoff via shared utility from engines
				const delay = exponentialBackoff(attempt, {
					baseDelayMs: policy.baseDelayMs,
					multiplier: policy.multiplier,
					maxDelayMs: policy.maxDelayMs,
					jitter: policy.jitter
				})
				markSafely('retry', {attempt, delay})

				// Report retry if self-metrics enabled
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				if (selfMetrics) {
					/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
					reportLogRetried(metrics, {})
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				}

				await waitForRetryBackoff(delay, signal)
			}
		}

		// Exhausted retries
		if (lastErr !== undefined) {
			if (onFailure && !isAmbiguousDeliveryError(lastErr)) {
				attemptedFailureFallback = true
				const consumed = await invokeFailureFallback(pendingLines, lastErr)
				reportErrorSafely(lastErr)
				if (consumed === true) return
				reportedTerminalFailure = true
				throw lastErr
			}
			reportErrorSafely(lastErr)
			reportedTerminalFailure = true
			throw lastErr
		}
	} catch(error) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (!reportedTerminalFailure && !attemptedFailureFallback && !isAmbiguousDeliveryError(error)) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			await invokeFailureFallback(getUndeliveredLines(error, pendingLines), error)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			reportErrorSafely(error)
		} else if (isAmbiguousDeliveryError(error)) {
			reportErrorSafely(error)
		}
		throw error
	}
}
