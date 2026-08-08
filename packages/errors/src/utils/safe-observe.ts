/**
 * @file Observer utility functions for safe observability event emission.
 * Caches pre-bound safeObserve reference to reduce closure churn.
 */

import type {ErrorObservabilityEvent, ObservabilityTap} from '../types/observability'

/**
 * No-op function for when observer is not provided
 */
function noop(): void {
	// Silent failure - no observer provided
}

/**
 * Create a cached, pre-bound safe observer function.
 * Reduces closure churn by creating once per handler instance and reusing.
 *
 * @param observe - Optional observability tap
 * @returns Safe observer function that never throws
 */
export function createSafeObserve(observe?: ObservabilityTap): ObservabilityTap {
	if (!observe) {
		return noop
	}
	const invoke = observe as (event: ErrorObservabilityEvent, data: unknown) => void | Promise<void>

	// Cache pre-bound reference to avoid closure churn
	let observing = false
	return ((event: ErrorObservabilityEvent, data: unknown): void => {
		// Observer diagnostics must not recursively generate more observer
		// diagnostics on the same synchronous stack. Async re-entry remains allowed
		// after this invocation has returned and is bounded by each owning service.
		if (observing) return
		observing = true
		try {
			const result = invoke(event, data)
			if (result && (typeof result === 'object' || typeof result === 'function')) {
				void Promise.resolve(result).then(
					() => { observing = false },
					() => { observing = false }
				)
				return
			}
			observing = false
		} catch {
			// Silent failure - don't break error handling
			observing = false
		}
	}) as ObservabilityTap
}
