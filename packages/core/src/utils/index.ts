/**
 * @file Utility functions - pure, stateless helpers.
 * Exports all utility modules that are pure functions with no side effects.
 */

// Core utils
export {byteSize} from './byte-size'
export {computeErrorKey} from './compute-error-key'
export type {ComputeErrorKeyOptions} from './compute-error-key'
export {normalizeError, isErrorLike, type ErrorLike} from './error/normalize-error'
// Internal guards (exported for testing purposes)
export {isPlainObject, safeStringify} from './guards'
export {sleep, formatErrorMessage} from './misc'
export {getNow, normalizeTimestamp} from './clock'
export {
	ConfigValidationError,
	validatePositiveFinite,
	validateNonNegativeFinite,
	validatePositiveInteger,
	validateNonNegativeInteger,
	validateFiniteNumber,
	validateNumberInRange,
	validateUrl,
	validateHeaders
} from './validation'
export {
	createErrorBoundary,
	createSilentFailure,
	createSilentFailureWithFallback,
	type ErrorBoundaryOptions
} from './error-boundary'
export {
	getMetricsPort,
	safeIncrement,
	safeRecord
} from './self-metrics'

// Hashing (pure)
export * from './hashing'

// Serialization (pure)
export * from './serialization'

// Async backoff (pure math)
export {exponentialBackoff, type BackoffCfg} from './async/backoff'

// Tracing utilities (pure)
export * from './tracing/ids'
export * from './tracing/propagation'
export * from './tracing/sampling'

// Testing constants (pure)
export {FIXED_CLOCK_TIMESTAMP} from './testing/constants'
