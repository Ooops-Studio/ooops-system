/**
 * @file Error boundary utilities for safe error handling.
 * Wraps operations with standardized error handling.
 */

import type {Errors} from '@ooopsstudio/core/ports/errors'

import {isolateUnexpectedThenable} from './capabilities'
import {
	describeResilienceError,
	fingerprintResilienceValue,
	sanitizeResilienceErrorType
} from './sanitizer'

function toNormalizedError(error: unknown): import('@ooopsstudio/core/contracts/errors').NormalizedError {
	const details = describeResilienceError(error)

	return {
		kind: sanitizeResilienceErrorType(details.type),
		message: 'Resilience boundary captured an error'
	}
}

/**
 * Error boundary options.
 */
export interface ErrorBoundaryOptions {

	/** Optional errors port for error reporting */
	readonly errors?: Errors

	/** Service name for error context */
	readonly serviceName: string

	/** Stage name for error context */
	readonly stage: string

}

/**
 * No-op error handler.
 */
function noopErrorHandler(_error: unknown): void {

	// Silent failure - no error handler provided

}

/**
 * Create an error boundary function for resilience operations.
 * Wraps operations with standardized error handling that reports errors
 * via errors port and prevents errors from propagating.
 *
 * @param options - Error boundary options
 * @returns Error handler function that never throws
 */
export function createErrorBoundary(options: ErrorBoundaryOptions): (error: unknown) => void {

	if (!options.errors) {
		return noopErrorHandler
	}

	const {errors, serviceName, stage} = options

	return (error: unknown): void => {
		const details = describeResilienceError(error)

		try {

			isolateUnexpectedThenable(errors.report(toNormalizedError(error), {
				service: serviceName,
				stage,
				severity: 'error',
				errorType: sanitizeResilienceErrorType(details.type),
				error: fingerprintResilienceValue(details.message)
			}))

		} catch {
			// Silent failure - don't break resilience even if error reporting fails
		}

	}

}

/**
 * Create a wrapper function that executes an operation within an error boundary.
 * If the operation throws, the error is caught and reported, but not rethrown.
 *
 * @param operation - The operation to execute
 * @param options - Error boundary options
 * @returns Promise that resolves even if operation fails
 */
export async function createSilentFailure<T>(
	operation: () => T | Promise<T>,
	options: ErrorBoundaryOptions
): Promise<T | undefined> {

	const onError = createErrorBoundary(options)

	try {

		return await operation()

	} catch(error) {

		onError(error)
		return undefined

	}

}
