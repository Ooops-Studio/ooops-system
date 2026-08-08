/**
 * @file Canonical normalized error model shared across packages. This lets
 * services report errors uniformly without coupling to concrete error classes.
 * It is a passive data model (no behavior) for cross-package communication.
 */

export interface NormalizedError {
	/** Error class name or category (e.g., 'TypeError', 'HttpError') */
	readonly kind: string
	/** Human-readable message after normalization/redaction */
	readonly message: string
	/** Optional stack trace (redacted/trimmed if needed) */
	readonly stack?: string
	/** Optional machine-readable code */
	readonly code?: string
	/** Optional causal chain (kept as unknown to avoid 'any') */
	readonly cause?: unknown
	/** Optional extra safe data (scrubbed and JSON-serializable) */
	readonly data?: Readonly<Record<string, unknown>>
}

/**
 * Error severity levels for observability and filtering
 */
export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal'

/**
 * Error categories for classification and analytics
 */
export type ErrorCategory =
	| 'VALIDATION'
	| 'NETWORK'
	| 'CONFIG'
	| 'AUTHENTICATION'
	| 'AUTHORIZATION'
	| 'RATE_LIMIT'
	| 'TIMEOUT'
	| 'RESOURCE'
	| 'BUSINESS_LOGIC'
	| 'UNKNOWN'

/**
 * Enriched error type with additional metadata for error handling.
 * Extends the base NormalizedError with severity, category, timestamp,
 * correlation ID, trace ID, source, and context.
 */
export interface EnrichedError extends NormalizedError {

	/** Severity level for observability and filtering */
	readonly severity: ErrorSeverity

	/** Semantic category for classification and analytics */
	readonly category: ErrorCategory

	/** Timestamp in epoch milliseconds (from Clock) */
	readonly timestamp: number

	/** Optional unique identifier (UUID) */
	readonly id?: string

	/** Optional correlation ID for async tracing */
	readonly correlationId?: string

	/** Optional trace ID from tracing service */
	readonly traceId?: string

	/** Source/origin of the error (e.g., 'api', 'worker', 'scheduler') */
	readonly source?: string

	/** Additional context data (safe, JSON-serializable) */
	readonly context?: Readonly<Record<string, unknown>>
}