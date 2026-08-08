/**
 * @file Error boundary utilities for service operations.
 * Provides standardized patterns for error handling and silent failures.
 * Used by services to wrap operations that must not throw.
 */

import type {Errors} from '../ports/errors'
import {
	captureNativePromiseResult,
	containNativePromiseUnchecked,
	createNativePromise,
	isolateUnexpectedThenable,
	mapNativePromise
} from '../runtime/async/native-promise'
import {createServiceErrorReporter} from '../runtime/runtime/service-error-reporter'

import {hasSafePrototypeChain, isProxyObject} from './safe-object'

const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf

/**
 * Options for creating an error boundary
 */
export interface ErrorBoundaryOptions {
	/** Service name (e.g., 'logging', 'metrics', 'performance') */
	readonly serviceName: string
	/** Stage name for error reporting (e.g., 'enriching', 'recorder', 'monitor') */
	readonly stage: string
	/** Optional step name for error reporting (e.g., 'custom', 'production') */
	readonly step?: string
	/** Optional preset name for error reporting (e.g., 'custom', 'production',
	 * 'development', 'testing', 'minimal') */
	readonly preset?: string
	/** Optional errors port for error reporting */
	readonly errors?: Errors
}

/**
 * No-op function for when error handler is not provided
 */
function noopErrorHandler(_error: unknown): void {
	// Silent failure - no error handler provided. A rejected Promise can itself
	// be used as an error value and still owns an independent rejection.
	containNativePromiseUnchecked(_error)
}

function isSafePromiseResolutionValue(value: unknown): boolean {
	if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return true
	if (!hasSafePrototypeChain(value)) return false
	let current: object | null = value as object
	try {
		for (let depth = 0; current && depth < 32; depth += 1) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, 'then')
			if (descriptor) {
				if (!('value' in descriptor)) return false
				containNativePromiseUnchecked(descriptor.value)
				return typeof descriptor.value !== 'function'
			}
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
	} catch { return false }
	return true
}

function executeBoundaryOperation<T>(
	operation: () => Promise<T> | T,
	onError: (error: unknown) => void,
	fallback: T
): Promise<T> {
	containNativePromiseUnchecked(operation)
	containNativePromiseUnchecked(onError)
	containNativePromiseUnchecked(fallback)
	try {
		const result = operation()
		const nativeCompletion = captureNativePromiseResult<T>(result)
		if (nativeCompletion) return mapNativePromise(
			nativeCompletion,
			(value) => {
				if (isSafePromiseResolutionValue(value)) return value
				const error = new TypeError('Error boundary operation resolved to an unsafe thenable')
				onError(error)
				if (!isSafePromiseResolutionValue(fallback)) {
					throw new TypeError('Error boundary fallback is an unsafe thenable')
				}
				return fallback
			},
			(error) => {
				onError(error)
				if (!isSafePromiseResolutionValue(fallback)) {
					throw new TypeError('Error boundary fallback is an unsafe thenable')
				}
				return fallback
			}
		)
		if (!isSafePromiseResolutionValue(result)) {
			throw new TypeError('Error boundary operation returned an unsafe thenable')
		}
		return createNativePromise((resolve) => { resolve(result) })
	} catch(error) {
		containNativePromiseUnchecked(error)
		onError(error)
		if (!isSafePromiseResolutionValue(fallback)) {
			return createNativePromise((_resolve, reject) => {
				reject(new TypeError('Error boundary fallback is an unsafe thenable'))
			})
		}
		return createNativePromise((resolve) => { resolve(fallback) })
	}
}

function readBoundaryOption(options: unknown, key: keyof ErrorBoundaryOptions): unknown {
	containNativePromiseUnchecked(options)
	if (!options || typeof options !== 'object') return undefined
	if (isProxyObject(options)) throw new TypeError('Error boundary options must not be a Proxy')
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(options, key)
		if (!descriptor) return undefined
		if (!('value' in descriptor)) throw new TypeError('Error boundary options must use data properties')
		containNativePromiseUnchecked(descriptor.value)
		return descriptor.value
	} catch(error) {
		if (error instanceof TypeError) throw error
		throw new TypeError('Error boundary options cannot be inspected safely')
	}
}

function validateBoundaryLabel(
	value: unknown,
	key: 'serviceName' | 'stage' | 'step' | 'preset'
): string | undefined {
	if (value === undefined && (key === 'step' || key === 'preset')) return undefined
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
		throw new TypeError(`Error boundary ${key} must be a string of 1-256 characters`)
	}
	return value
}

/**
 * Create an error boundary function for service stages.
 * Wraps operations with standardized error handling that reports errors
 * via createServiceErrorReporter() and prevents errors from propagating.
 *
 * **When to use:** Service pipeline operations that need error reporting.
 * Use `createSafeObserve()` for errors service observability instead.
 *
 * **When Silent Failures Are Acceptable:**
 * - Service pipeline operations (enriching, formatting, transferring, recording, etc.)
 * - Services must never throw - they're fire-and-forget operations
 * - Error reporting itself (to avoid infinite loops)
 * - Observable hooks and callbacks (to prevent breaking main flow)
 *
 * @param options - Error boundary options
 * @returns Error handler function that never throws
 *
 * @example
 * ```ts
 * const onError = createErrorBoundary({
 *   serviceName: 'logging',
 *   stage: 'enriching',
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
	if (isolateUnexpectedThenable(options)) throw new TypeError('Error boundary options must be synchronous')
	const errors = readBoundaryOption(options, 'errors') as Errors | undefined
	const configuredServiceName = readBoundaryOption(options, 'serviceName')
	const configuredStage = readBoundaryOption(options, 'stage')
	const configuredStep = readBoundaryOption(options, 'step')
	const configuredPreset = readBoundaryOption(options, 'preset')
	if (isolateUnexpectedThenable(errors)) throw new TypeError('Error boundary errors port must be synchronous')
	if (!errors) {
		return noopErrorHandler
	}
	const serviceName = validateBoundaryLabel(configuredServiceName, 'serviceName')!
	const stage = validateBoundaryLabel(configuredStage, 'stage')!
	const step = validateBoundaryLabel(configuredStep, 'step')
	const preset = validateBoundaryLabel(configuredPreset, 'preset')

	const onError = createServiceErrorReporter({
		errors,
		fixedContext: {
			stage,
			...(step ? {step} : {}),
			...(preset ? {preset} : {})
		},
		serviceName
	})

	return (error: unknown): void => {
		try {
			onError(error)
		} catch {
			// Silent failure - don't break service even if error reporting fails
		}
	}
}

/**
 * Create a wrapper function that executes an operation within an error boundary.
 * If the operation throws, the error is caught and reported, but not rethrown.
 *
 * **Use Cases:**
 * - Wrapping async operations in service pipelines
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
 *   { serviceName: 'logging', stage: 'transferring', preset: 'production', errors }
 * )
 *
 * await safeOperation() // Never throws, errors are reported silently
 * ```
 */
export function createSilentFailure<T>(
	operation: () => Promise<T> | T,
	options: ErrorBoundaryOptions
): Promise<T | undefined> {
	containNativePromiseUnchecked(operation)
	containNativePromiseUnchecked(options)
	const onError = createErrorBoundary(options)
	return executeBoundaryOperation<T | undefined>(operation, onError, undefined)
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
 *   { serviceName: 'logging', stage: 'enriching', errors }
 * )
 * ```
 */
export function createSilentFailureWithFallback<T, F>(
	operation: () => Promise<T> | T,
	fallback: F,
	options: ErrorBoundaryOptions
): Promise<T | F> {
	containNativePromiseUnchecked(operation)
	containNativePromiseUnchecked(fallback)
	containNativePromiseUnchecked(options)
	const onError = createErrorBoundary(options)
	if (!isSafePromiseResolutionValue(fallback)) {
		containNativePromiseUnchecked(fallback)
		throw new TypeError('Error boundary fallback must not be an unsafe thenable')
	}
	return executeBoundaryOperation<T | F>(operation, onError, fallback)
}
