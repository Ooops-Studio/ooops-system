/**
 * @file Logging utility functions for errors service.
 * Utilities for working with logging types and conversions.
 */

import type {ErrorSeverity} from '@ooopsstudio/core/contracts/errors'
import type {LogLevel} from '@ooopsstudio/core/contracts/logging'

/**
 * Map error severity to log level
 * @param severity - Error severity level
 * @returns Corresponding log level
 */
export function mapErrorSeverityToLogLevel(severity: ErrorSeverity): LogLevel {
	return severity === 'fatal' ? 'fatal' :
		severity === 'error' ? 'error' :
			severity === 'warn' ? 'warn' :
				'info'
}
