/**
 * @file Retry engine - pure L1 logic for retry with backoff.
 * No observability, no orchestration - pure retry calculation.
 *
 * CPU Time Tracking:
 * - Callers record synchronous attempt-start execution time
 * - Delays are wall-clock time (mostly idle, minimal CPU overhead)
 * - CPU consumption is tracked per retry attempt via recordCpuConsumption()
 * - maxCpuConsumption enforces hard limit to prevent CPU spikes
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'

import {captureClock, isolateUnexpectedThenable} from '../utils/capabilities'
import {copyDataDescriptorValues, getPlainDataDescriptors} from '../utils/data-object'

import type {RetryPolicy} from './internal-types'
import {MAX_TIMER_DELAY_MS} from './timer-limits'

const MAX_RETRY_ATTEMPTS = 100

/**
 * Retry decision result.
 */
export interface RetryDecision {

	/** Current attempt number (1-based) */
	readonly attempt: number

	/** Delay in milliseconds before next retry */
	readonly delay: number

	/** Whether retry should continue */
	readonly shouldRetry: boolean

	/** Total CPU time consumed so far in milliseconds */
	readonly cpuConsumed: number

}

/**
 * Retry engine options.
 */
export interface RetryEngineOptions {

	/** Clock for time calculations */
	readonly clock: Clock

	/** Retry policy */
	readonly policy: RetryPolicy

	/** Optional random source for jitter calculation (defaults to Math.random) */
	readonly random?: () => number

}

/**
 * Retry engine state.
 */
interface RetryEngineState {

	/** Start time of retry sequence */
	startTime: number

	/** Current attempt number (1-based) */
	attempt: number

	/** Total CPU time consumed */
	cpuConsumed: number

}

function snapshotClassification(value: unknown): {isRetryable: boolean; delay?: number} | undefined {
	const descriptors = getPlainDataDescriptors(value)
	if (!descriptors) return undefined
	const retryable = descriptors.isRetryable?.value
	const category = descriptors.category?.value
	if (typeof retryable !== 'boolean' || typeof category !== 'string' || category.length === 0) return undefined
	const delay = descriptors.delay?.value
	if (delay !== undefined && typeof delay !== 'number') return undefined
	return delay === undefined ? {isRetryable: retryable} : {isRetryable: retryable, delay}
}

/**
 * Calculate delay based on backoff strategy.
 */
function calculateDelay(
	attempt: number,
	policy: RetryPolicy,
	startTime: number,
	clock: Clock,
	random: () => number
): number {

	const elapsed = Math.max(0, clock.now() - startTime)
	const remainingTime = policy.maxTotalTime - elapsed

	if (remainingTime <= 0) {
		return 0
	}

	let delay: number

	switch (policy.backoff) {
		case 'exponential': {
			const multiplier = policy.backoffMultiplier ?? 2
			delay = policy.initialDelay * Math.pow(multiplier, attempt - 1)
			break
		}
		case 'linear': {
			delay = policy.initialDelay * attempt
			break
		}
		case 'fixed': {
			delay = policy.initialDelay
			break
		}
		default: {
			delay = policy.initialDelay
		}
	}

	// Cap delay to maxDelay and remaining time
	delay = Math.min(delay, policy.maxDelay, remainingTime)

	const boundedDelay = Math.max(0, delay)
	const jitter = policy.jitter ?? (policy.backoff === 'exponential' ? 'full' : 'none')

	if (boundedDelay === 0 || jitter === 'none') {
		return boundedDelay
	}

	let randomValue = 0
	try {
		randomValue = random()
		isolateUnexpectedThenable(randomValue)
	} catch {
		// A caller-supplied jitter source must not replace the protected error.
	}
	const safeRandomValue = Number.isFinite(randomValue) ? randomValue : 0
	return boundedDelay * Math.min(1, Math.max(0, safeRandomValue))

}

/**
 * Create a retry engine.
 * Pure logic - no observability, no orchestration.
 */
export function createRetryEngine(options: RetryEngineOptions) {

	const clock = captureClock(options.clock)
	const {random = Math.random} = options
	const policyDescriptors = getPlainDataDescriptors(options.policy)
	if (!policyDescriptors) throw new Error('[Resilience] RetryPolicy must be a plain data object')
	const inputPolicy = copyDataDescriptorValues(policyDescriptors) as unknown as RetryPolicy

	// Validate policy
	if (!Number.isSafeInteger(inputPolicy.maxAttempts) || inputPolicy.maxAttempts < 1 || inputPolicy.maxAttempts > MAX_RETRY_ATTEMPTS) {
		throw new Error('[Resilience] RetryPolicy.maxAttempts must be >= 1')
	}
	if (!Number.isFinite(inputPolicy.maxTotalTime) || inputPolicy.maxTotalTime <= 0 || inputPolicy.maxTotalTime > MAX_TIMER_DELAY_MS) {
		throw new Error('[Resilience] RetryPolicy.maxTotalTime must be > 0')
	}
	if (!Number.isFinite(inputPolicy.initialDelay) || inputPolicy.initialDelay < 0 || inputPolicy.initialDelay > MAX_TIMER_DELAY_MS) {
		throw new Error('[Resilience] RetryPolicy.initialDelay must be >= 0')
	}
	if (!Number.isFinite(inputPolicy.maxDelay) || inputPolicy.maxDelay < 0 || inputPolicy.maxDelay > MAX_TIMER_DELAY_MS) {
		throw new Error(`[Resilience] RetryPolicy.maxDelay must be >= 0 and <= ${MAX_TIMER_DELAY_MS}`)
	}
	if (inputPolicy.maxDelay < inputPolicy.initialDelay) {
		throw new Error('[Resilience] RetryPolicy.maxDelay must be >= initialDelay')
	}
	if (!Number.isFinite(inputPolicy.maxCpuConsumption) || inputPolicy.maxCpuConsumption <= 0) {
		throw new Error('[Resilience] RetryPolicy.maxCpuConsumption must be > 0')
	}
	if (!['exponential', 'linear', 'fixed'].includes(inputPolicy.backoff)) {
		throw new Error('[Resilience] RetryPolicy.backoff must be exponential, linear, or fixed')
	}
	if (inputPolicy.jitter !== undefined && !['none', 'full'].includes(inputPolicy.jitter)) {
		throw new Error('[Resilience] RetryPolicy.jitter must be none or full')
	}
	if (inputPolicy.errorClassifier !== undefined && typeof inputPolicy.errorClassifier !== 'function') {
		throw new Error('[Resilience] RetryPolicy.errorClassifier must be a function when provided')
	}
	if (inputPolicy.backoff === 'exponential' && inputPolicy.backoffMultiplier !== undefined && (
		!Number.isFinite(inputPolicy.backoffMultiplier) || inputPolicy.backoffMultiplier <= 0
	)) {
		throw new Error('[Resilience] RetryPolicy.backoffMultiplier must be > 0 when provided')
	}
	const policy: RetryPolicy = Object.freeze({
		maxAttempts: inputPolicy.maxAttempts,
		maxTotalTime: inputPolicy.maxTotalTime,
		backoff: inputPolicy.backoff,
		initialDelay: inputPolicy.initialDelay,
		maxDelay: inputPolicy.maxDelay,
		maxCpuConsumption: inputPolicy.maxCpuConsumption,
		...(inputPolicy.backoffMultiplier !== undefined ? {backoffMultiplier: inputPolicy.backoffMultiplier} : {}),
		...(inputPolicy.jitter !== undefined ? {jitter: inputPolicy.jitter} : {}),
		...(inputPolicy.errorClassifier !== undefined ? {errorClassifier: inputPolicy.errorClassifier} : {})
	})

	const state: RetryEngineState = {
		startTime: clock.now(),
		attempt: 0,
		cpuConsumed: 0
	}
	let generation = 0
	let evaluating = false
	let resetting = false
	const stopped = (): RetryDecision => ({
		attempt: state.attempt,
		delay: 0,
		shouldRetry: false,
		cpuConsumed: state.cpuConsumed
	})

	return {

		/** Whether a retry may start now after any scheduled backoff has elapsed. */
		canRetryNow(): boolean {
			if (evaluating || resetting) return false
			evaluating = true
			try {
				const elapsed = Math.max(0, clock.now() - state.startTime)
				return state.attempt < policy.maxAttempts
					&& elapsed < policy.maxTotalTime
					&& state.cpuConsumed < policy.maxCpuConsumption
			} finally { evaluating = false }
		},

		/**
		 * Check if error should be retried and calculate next delay.
		 * Tracks CPU consumption and enforces limits.
		 */
		shouldRetry(error: unknown): RetryDecision {
			if (evaluating || resetting) return stopped()
			evaluating = true
			const observedGeneration = generation
			try {

				state.attempt++
				const elapsed = Math.max(0, clock.now() - state.startTime)
				if (generation !== observedGeneration) return stopped()

				// maxAttempts is the total physical-attempt ceiling. Because shouldRetry
				// is called after the current failure, reaching the ceiling denies another.
				if (state.attempt >= policy.maxAttempts) {
					return stopped()
				}

				// Check if max total time exceeded
				if (elapsed >= policy.maxTotalTime) {
					return stopped()
				}

				// Check if CPU limit exceeded
				if (state.cpuConsumed >= policy.maxCpuConsumption) {
					return stopped()
				}

				// Classify error if classifier provided
				if (policy.errorClassifier) {
					let rawClassification: unknown
					try {
						rawClassification = policy.errorClassifier(error)
						isolateUnexpectedThenable(rawClassification)
					} catch {
					// Classifier failures are configuration faults, not operation failures.
					}
					if (generation !== observedGeneration) return stopped()
					const classification = snapshotClassification(rawClassification)
					if (!classification || classification.isRetryable !== true) {
						return stopped()
					}

					// Use classifier delay if provided
					if (classification.delay !== undefined) {
						if (!Number.isFinite(classification.delay) || classification.delay < 0) {
							return stopped()
						}
						const delay = Math.max(0, Math.min(
							classification.delay,
							policy.maxDelay,
							policy.maxTotalTime - elapsed
						))
						const canRetryAfterDelay = elapsed + delay < policy.maxTotalTime
							&& state.cpuConsumed < policy.maxCpuConsumption
						return {
							attempt: state.attempt,
							delay: canRetryAfterDelay ? delay : 0,
							shouldRetry: canRetryAfterDelay,
							cpuConsumed: state.cpuConsumed
						}
					}
				}

				// Calculate delay based on backoff strategy
				const delay = calculateDelay(state.attempt, policy, state.startTime, clock, random)
				if (generation !== observedGeneration) return stopped()
				const canRetryAfterDelay = elapsed + delay < policy.maxTotalTime

				return {
					attempt: state.attempt,
					delay: canRetryAfterDelay ? delay : 0,
					shouldRetry: canRetryAfterDelay && state.cpuConsumed < policy.maxCpuConsumption,
					cpuConsumed: state.cpuConsumed
				}
			} finally { evaluating = false }

		},

		/**
		 * Record CPU consumption (called by handler after operation execution).
		 *
		 * This method should be called with synchronous attempt-start execution
		 * time. Awaited I/O is wall time and is enforced by maxTotalTime instead.
		 *
		 * @param consumed - CPU time consumed in milliseconds (process CPU time when available)
		 */
		recordCpuConsumption(consumed: number): void {

			if (!Number.isFinite(consumed) || consumed < 0) {
				throw new Error('[Resilience] recordCpuConsumption: consumed must be finite and >= 0')
			}

			state.cpuConsumed += consumed

		},

		/**
		 * Reset engine state for new retry sequence.
		 */
		reset(): void {
			if (resetting) return
			generation++
			resetting = true
			try {
				const startTime = clock.now()
				state.startTime = startTime
				state.attempt = 0
				state.cpuConsumed = 0
			} finally { resetting = false }
		}

	}

}
