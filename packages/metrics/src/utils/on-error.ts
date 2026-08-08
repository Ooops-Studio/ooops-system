/**
 * @file Error handling utilities for metrics service.
 * Uses the shared service error reporter with explicit dependency injection.
 */

import type {Errors} from '@ooopsstudio/core/ports/errors'
import {createServiceErrorReporter} from '@ooopsstudio/core/runtime/runtime/service-error-reporter'

/**
 * Create an error handler function for metrics stage errors.
 * Uses shared service error reporter with the explicitly provided errors port.
 *
 * @param errors - Optional errors port
 * @param fixedContext - Fixed context to include with all errors
 * @returns Error handler function
 */
export function createMetricsOnError(
	errors?: Errors,
	fixedContext?: Record<string, string>
): (err: unknown, extra?: Record<string, string>) => void {

	return createServiceErrorReporter({
		...(errors ? {errors} : {}),
		...(fixedContext ? {fixedContext} : {}),
		serviceName: 'metrics'
	})
}
