/**
 * @file Error boundary for performance monitoring operations.
 * Wraps monitor operations to prevent crashes.
 * Uses engines' error boundary utilities for consistency.
 */

import type {Errors} from '@ooopsstudio/core/ports/errors'

import {createPerformanceOnError} from './on-error'
import {isRuntimePromise} from './safe-object'

/**
 * Wrap a function with error boundary.
 * Catches errors and reports them without throwing.
 *
 * @param fn - Function to wrap
 * @param errors - Optional error handler
 * @param context - Optional context for error reporting
 * @returns Wrapped function
 */
export function withErrorBoundary<T extends (...args: unknown[]) => unknown>(
	fn: T,
	errors?: Errors,
	context?: Record<string, string>
): T {

	const onError = createPerformanceOnError(errors, {
		stage: 'monitor',
		...(context ? {step: Object.values(context)[0]} : {})
	})

	return ((...args: Parameters<T>) => {
		try {
			return fn(...args)
		} catch(error) {
			onError(error)
			// Return undefined instead of throwing
			return undefined as ReturnType<T>
		}
	}) as T
}

/**
 * Wrap an async function with error boundary.
 *
 * @param fn - Async function to wrap
 * @param errors - Optional error handler
 * @param context - Optional context for error reporting
 * @returns Wrapped async function
 */
export function withAsyncErrorBoundary<T extends (...args: unknown[]) => Promise<unknown>>(
	fn: T,
	errors?: Errors,
	context?: Record<string, string>
): T {

	const onError = createPerformanceOnError(errors, {
		stage: 'monitor',
		...(context ? {step: Object.values(context)[0]} : {})
	})

	return ((...args: Parameters<T>) => {
		return Promise.resolve().then(() => {
			const result = fn(...args)
			if (!isRuntimePromise(result)) throw new TypeError('Performance async boundary requires a native Promise')
			return result
		}).catch((error) => {
			onError(error)
			return undefined
		}) as Promise<Awaited<ReturnType<T>> | undefined>
	}) as T
}
