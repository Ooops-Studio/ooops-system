/**
 * @file Observability tap contract for cross-service event hooks.
 * Provides typed event names for error handling and other observability events.
 */

import type {EnrichedError} from './normalized-error'

/**
 * Typed observability event names for error handling and logging.
 * Keep the event set small and stable; add new ones sparingly.
 */
export type ErrorObservabilityEvent =
	| 'error:normalized'
	| 'error:handled'
	| 'error:retry'
	| 'error:classified'
	| 'error:deduplicated'
	| 'error:throttled'
	| 'error:reported'
	| 'error:reporter'
	| 'error:recovered'
	| 'error:flushed'
	| 'error:policy:failed'

export interface ErrorNormalizedPayload {
	readonly error: EnrichedError
}

export interface ErrorClassifiedPayload {
	readonly error: EnrichedError
}

export interface ErrorDeduplicatedPayload {
	readonly error: EnrichedError
	readonly key: string
}

export interface ErrorHandledPayload {
	readonly error: EnrichedError
	readonly handling: {
		readonly deduplicated: boolean
		readonly rethrow: boolean
	}
}

export interface ErrorReporterPayload {
	readonly reporter: 'custom' | 'log' | 'metrics' | 'trace' | 'sink' | 'unknown'
	readonly durationMs?: number
	readonly status: 'ok' | 'error' | 'timeout'
	readonly error: EnrichedError
	readonly reason?: string
}

export interface ErrorReportedPayload {
	readonly error: EnrichedError
	readonly delivery: {
		readonly configured: number
		readonly delivered: number
		readonly failed: number
	}
}

export interface ErrorRecoveredPayload {
	readonly error: EnrichedError
	readonly originalSeverity: EnrichedError['severity']
	readonly newSeverity: EnrichedError['severity']
	readonly elapsedMs: number
}

export interface ErrorRetryPayload {
	readonly error: EnrichedError
	readonly policy?: string
	readonly attempts?: number
	readonly delayMs?: number
}

export interface ErrorThrottledPayload {
	readonly kind: string
	readonly category: string
	readonly key: string
	readonly count: number
	readonly threshold: number
	readonly correlationId?: string
}

export interface ErrorPolicyFailedPayload {
	readonly policy: string
	readonly priority: number
	readonly index: number
	readonly error: EnrichedError
	readonly policyError: {
		readonly message: string
		readonly name?: string
	}
}

export interface ErrorFlushedPayload {
	readonly error: EnrichedError
}

export interface ErrorObservabilityPayloadMap {
	readonly 'error:normalized': ErrorNormalizedPayload
	readonly 'error:handled': ErrorHandledPayload
	readonly 'error:retry': ErrorRetryPayload
	readonly 'error:classified': ErrorClassifiedPayload
	readonly 'error:deduplicated': ErrorDeduplicatedPayload
	readonly 'error:throttled': ErrorThrottledPayload
	readonly 'error:reported': ErrorReportedPayload
	readonly 'error:reporter': ErrorReporterPayload
	readonly 'error:recovered': ErrorRecoveredPayload
	readonly 'error:flushed': ErrorFlushedPayload
	readonly 'error:policy:failed': ErrorPolicyFailedPayload
}

export type ErrorObservabilityPayload<E extends ErrorObservabilityEvent> = ErrorObservabilityPayloadMap[E]

/**
 * Observability tap function for cross-service event hooks
 * @param event - Typed event name
 * @param data - Event data payload
 */
export type ObservabilityTap = <E extends ErrorObservabilityEvent>(
	event: E,
	data: ErrorObservabilityPayload<E>
) => void | Promise<void>
