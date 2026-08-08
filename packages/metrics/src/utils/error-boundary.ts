/**
 * @file Error boundary utilities for metrics service.
 * Provides standardized patterns for error handling and silent failures.
 * Similar to createSafeObserve() in errors service, but tailored for metrics.
 */

import type {Errors} from '@ooopsstudio/core/ports/errors'
import {
	createErrorBoundary as createEngineErrorBoundary,
	createSilentFailure as createEngineSilentFailure,
	createSilentFailureWithFallback as createEngineSilentFailureWithFallback
} from '@ooopsstudio/core/utils/error-boundary'

/**
 * Options for creating an error boundary
 */
export interface ErrorBoundaryOptions {
	/** Stage name for error reporting (e.g., 'recorder', 'aggregator', 'exporter-manager') */
	readonly stage: string
	/** Optional step name for error reporting (e.g., 'custom', 'production') */
	readonly step?: string
	/** Optional preset name for error reporting (custom, production, or development). */
	readonly preset?: string
	/** Optional errors port for error reporting */
	readonly errors?: Errors
}

/**
 * Create an error boundary function for metrics service stages.
 * Wraps operations with standardized error handling that reports errors
 * via createServiceErrorReporter() and prevents errors from propagating.
 *
 * **When to use:** Metrics pipeline operations that need error reporting.
 * Use `createSafeObserve()` for errors service observability instead.
 *
 * **When Silent Failures Are Acceptable:**
 * - Metrics pipeline operations (recording, aggregation, export)
 * - Best-effort observation paths only; configuration and explicit lifecycle
 *   operations still fail visibly.
 * - Error reporting itself (to avoid infinite loops)
 * - Observable hooks and callbacks (to prevent breaking main flow)
 *
 * @param options - Error boundary options
 * @returns Error handler function that never throws
 *
 * @example
 * ```ts
 * const onError = createErrorBoundary({
 *   stage: 'recorder',
 *   step: 'custom',
 *   errors
 * })
 *
 * try {
 *   // Some operation that might fail
 *   await someOperation()
 * } catch (error) {
 *   onError(error) // Reports error but doesn't throw
 * }
 * ```
 */
export function createErrorBoundary(options: ErrorBoundaryOptions): (error: unknown) => void {

	return createEngineErrorBoundary({
		serviceName: 'metrics',
		stage: options.stage,
		...(options.step ? {step: options.step} : {}),
		...(options.preset ? {preset: options.preset} : {}),
		...(options.errors ? {errors: options.errors} : {})
	})
}

/**
 * Create a wrapper function that executes an operation within an error boundary.
 * If the operation throws, the error is caught and reported, but not rethrown.
 *
 * **Use Cases:**
 * - Wrapping async operations in metrics pipeline
 * - Wrapping callbacks that must not throw
 * - Wrapping observable hooks
 *
 * @param operation - The operation to execute
 * @param options - Error boundary options
 * @returns Promise that resolves even if operation fails
 *
 * @example
 * ```ts
 * const safeOperation = createSilentFailure(
 *   async () => {
 *     await riskyOperation()
 *   },
 *   { stage: 'exporter-manager', preset: 'production', errors }
 * )
 *
 * await safeOperation() // Never throws, errors are reported silently
 * ```
 */
export function createSilentFailure<T>(
	operation: () => Promise<T> | T,
	options: ErrorBoundaryOptions
): Promise<T | undefined> {
	return createEngineSilentFailure(operation, {
		serviceName: 'metrics',
		stage: options.stage,
		...(options.step ? {step: options.step} : {}),
		...(options.preset ? {preset: options.preset} : {}),
		...(options.errors ? {errors: options.errors} : {})
	})
}

/**
 * Create a wrapper function that executes an operation and returns a fallback value on error.
 * Similar to createSilentFailure but allows specifying a fallback value.
 *
 * @param operation - The operation to execute
 * @param fallback - Value to return if operation fails
 * @param options - Error boundary options
 * @returns Promise that resolves with operation result or fallback
 *
 * @example
 * ```ts
 * const result = await createSilentFailureWithFallback(
 *   async () => await fetchData(),
 *   { default: 'fallback' },
 *   { stage: 'recorder', errors }
 * )
 * ```
 */
export function createSilentFailureWithFallback<T, F>(
	operation: () => Promise<T> | T,
	fallback: F,
	options: ErrorBoundaryOptions
): Promise<T | F> {
	return createEngineSilentFailureWithFallback(operation, fallback, {
		serviceName: 'metrics',
		stage: options.stage,
		...(options.step ? {step: options.step} : {}),
		...(options.preset ? {preset: options.preset} : {}),
		...(options.errors ? {errors: options.errors} : {})
	})
}
