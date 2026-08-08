/**
 * @file Default constants for error handling service.
 */

import type {ErrorClassificationRegistry} from './types/error-handler'
import type {ErrorCategory, ErrorSeverity} from './types/normalized-error'

export {ERROR_CATEGORIES, SEVERITY_LEVELS} from './utils/error-values'

/** Default severity level */
export const DEFAULT_SEVERITY: ErrorSeverity = 'error'

/** Default error code for unknown errors */
export const ERROR_CODE_UNKNOWN = 'E_UNKNOWN'

/** Default source for errors */
export const DEFAULT_SOURCE = 'unknown'

/** Default deduplication TTL in milliseconds (10 seconds) */
export const DEFAULT_DEDUPLICATE_TTL = 10_000

export const DEFAULT_ERRORS_FLUSH_TIMEOUT_MS = 5_000

export const DEFAULT_ERRORS_SHUTDOWN_TIMEOUT_MS = 10_000

export const DEFAULT_ERRORS_REPORT_TIMEOUT_MS = 5_000

export const DEFAULT_ERRORS_DEDUPLICATION_TIMEOUT_MS = 250

export const MAX_ACTIVE_ERROR_REPORTS = 1_000

export const MAX_ACTIVE_ERROR_HANDLES = 1_000

export const MAX_ACTIVE_ERROR_DEDUPLICATIONS = 1_000

export const MAX_ACTIVE_ERROR_FLUSHES = 64

export const MAX_ACTIVE_ERROR_FINALIZATIONS = 64

export const MAX_PENDING_ERROR_FLUSH_REQUESTS = 64

export const MAX_PENDING_ERROR_FINALIZATION_REQUESTS = 64

/**
 * Classification rule defining category, severity overrides, and matching patterns
 */
export interface ClassificationRule {
	/** Error category */
	readonly category: ErrorCategory
	/** Optional severity overrides based on original severity */
	readonly severityOverride?: Partial<Record<ErrorSeverity, ErrorSeverity>>
	/** Patterns to match against error kind or code */
	readonly patterns: readonly string[]
}

/**
 * Explicit classification rules table
 * Maps error patterns to categories with documented severity adjustments
 */
export const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
	{
		category: 'VALIDATION',
		severityOverride: {error: 'info'}, // Validation errors are often expected
		patterns: ['ValidationError']
	},
	{
		category: 'NETWORK',
		severityOverride: {error: 'warn'}, // Network errors are often recoverable
		patterns: ['FetchError', 'NetworkError', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND']
	},
	{
		category: 'CONFIG',
		severityOverride: {info: 'error', warn: 'error', error: 'error', fatal: 'fatal'}, // Config errors are always errors
		patterns: ['ConfigError', 'ConfigurationError', 'ENOENT']
	},
	{
		category: 'AUTHENTICATION',
		severityOverride: {info: 'warn'}, // Auth errors should be at least warnings
		patterns: ['AuthenticationError', 'UnauthorizedError', 'UNAUTHORIZED', 'AUTHENTICATION_FAILED']
	},
	{
		category: 'AUTHORIZATION',
		severityOverride: {info: 'warn'}, // Auth errors should be at least warnings
		patterns: ['AuthorizationError', 'ForbiddenError', 'FORBIDDEN', 'AUTHORIZATION_FAILED', 'EACCES', 'EPERM']
	},
	{
		category: 'RATE_LIMIT',
		severityOverride: {error: 'warn'}, // Rate limits are warnings
		patterns: ['RateLimitError', 'TooManyRequestsError', 'RATE_LIMIT', 'RATE_LIMITED', 'TOO_MANY_REQUESTS']
	},
	{
		category: 'TIMEOUT',
		severityOverride: {error: 'warn'}, // Timeouts are often recoverable
		patterns: ['TimeoutError', 'TIMEOUT', 'ETIMEDOUT']
	},
	{
		category: 'RESOURCE',
		patterns: ['ResourceError', 'ENOSPC', 'EMFILE', 'ENFILE']
	},
	{
		category: 'BUSINESS_LOGIC',
		patterns: ['BusinessError', 'DomainError']
	},
	{
		category: 'UNKNOWN',
		// No severity override - unclassified errors default to ERROR severity
		patterns: ['Error', 'UnknownError']
	}
] as const

/**
 * Default error classification registry mapping error names/types to categories
 * Derived from CLASSIFICATION_RULES for backward compatibility
 */
export const DEFAULT_ERROR_CATEGORIES: ErrorClassificationRegistry =
	CLASSIFICATION_RULES.reduce<Record<string, ReadonlyArray<string>>>(
		(acc, rule) => {
			acc[rule.category] = rule.patterns
			return acc
		},
		{}
	) as ErrorClassificationRegistry
