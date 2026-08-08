import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {createServiceErrorReporter} from '@ooopsstudio/core/runtime/runtime/service-error-reporter'

import {readLoggingDataProperty} from './capabilities'
import {sanitizeLoggingErrorDiagnostic} from './sanitize-diagnostic'

/**
 * Create an error handler function for logging stage errors.
 * Uses shared service error reporter from engines.
 *
 * @param errors - Optional errors port
 * @param fixedContext - Fixed context to include with all errors
 * @returns Error handler function
 */
export function createStageOnError(errors?: Errors, fixedContext?: LogAttributes) {
	const report = createServiceErrorReporter({
		...(errors ? {errors} : {}),
		fixedContext: {
			source: 'logging',
			...(fixedContext ?? {})
		},
		serviceName: 'logging'
	})
	// Reuse projections while the same failure is active so the shared reporter's
	// recursion guard still observes stable identity without retaining failures.
	const projections = new WeakMap<object, Readonly<{name: string; message: string}>>()
	const project = (error: unknown): unknown => {
		if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
			const existing = projections.get(error as object)
			if (existing) return existing
			const candidate = readLoggingDataProperty<unknown>(error, 'name')
			const name = typeof candidate === 'string' ? sanitizeLoggingErrorDiagnostic(candidate) : 'Error'
			const projection = {name, message: sanitizeLoggingErrorDiagnostic(error)}
			projections.set(error as object, projection)
			return projection
		}
		return typeof error === 'string' ? sanitizeLoggingErrorDiagnostic(error) : error
	}

	return (error: unknown, extra?: Record<string, unknown>): void => {
		report(project(error), extra)
	}
}
