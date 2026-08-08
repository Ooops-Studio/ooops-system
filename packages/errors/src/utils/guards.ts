/**
 * @file Guard functions for error handling.
 * Runtime validation functions for error shapes.
 */

import type {ErrorSeverity} from '../types/normalized-error'

/**
 * Get severity from error type/code
 */
export function inferSeverity(error: {kind?: string; code?: string}): ErrorSeverity {
	if (error.code) {
		// Authentication/authorization errors are warnings (not fatal, but important)
		if (/(?:^|_)(?:AUTH(?:_|$)|AUTHENTICATION(?:_|$)|AUTHORIZATION(?:_|$)|UNAUTHORIZED(?:_|$)|FORBIDDEN(?:_|$)|EACCES(?:_|$)|EPERM(?:_|$))/u.test(error.code)) {
			return 'warn'
		}
		// Rate limit errors are warnings
		if (/(?:^|_)(?:RATE_LIMIT(?:ED)?|TOO_MANY(?:_REQUESTS)?)(?:_|$)/u.test(error.code)) {
			return 'warn'
		}
		// Timeout errors are warnings
		if (/(?:^|_)(?:TIMEOUT|ETIMEDOUT)(?:_|$)/u.test(error.code)) {
			return 'warn'
		}
	}

	if (error.kind) {
		// Validation errors are info (expected in some cases)
		if (error.kind === 'ValidationError') {
			return 'info'
		}
		// Network errors are warnings (often recoverable)
		if (error.kind === 'NetworkError' || error.kind === 'FetchError') {
			return 'warn'
		}
	}

	return 'error'
}
