import {isRuntimeError, isRuntimeProxy} from '../utils/safe-object'

export interface PerformanceExportError extends Error {
	statusCode?: number
	retryable: boolean
	code: string
}

export interface PerformanceExportErrorMetadata {
	retryable: boolean
	code: string
}

const readDataProperty = (value: unknown, key: PropertyKey): unknown => {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch {
		return undefined
	}
}

export function getPerformanceExportErrorMetadata(
	error: unknown
): PerformanceExportErrorMetadata | undefined {
	try {
		if (isRuntimeProxy(error) || !isRuntimeError(error)) return undefined
		const retryable = readDataProperty(error, 'retryable')
		const code = readDataProperty(error, 'code')
		return typeof retryable === 'boolean' && typeof code === 'string'
			? {retryable, code}
			: undefined
	} catch {
		return undefined
	}
}

export function isPerformanceExportError(error: unknown): error is PerformanceExportError {
	return getPerformanceExportErrorMetadata(error) !== undefined
}

export function createPerformanceExportError(
	message: string,
	options: {
		statusCode?: number
		retryable: boolean
		code: string
		cause?: unknown
	}
): PerformanceExportError {
	const error = new Error(
		message,
		Object.prototype.hasOwnProperty.call(options, 'cause') ? {cause: options.cause} : undefined
	) as PerformanceExportError
	error.retryable = options.retryable
	error.code = options.code
	if (typeof options.statusCode === 'number') {
		error.statusCode = options.statusCode
	}
	return error
}

export function classifyHttpStatus(statusCode: number): {retryable: boolean; code: string} {
	if (statusCode === 429) {
		return {retryable: true, code: 'http_rate_limited'}
	}
	if (statusCode >= 500) {
		return {retryable: true, code: 'http_server_error'}
	}
	if (statusCode >= 400) {
		return {retryable: false, code: 'http_client_error'}
	}
	return {retryable: false, code: 'http_unexpected_status'}
}

export function classifyFetchFailure(error: unknown): PerformanceExportError {
	if (isPerformanceExportError(error)) {
		return error
	}
	if (isRuntimeProxy(error)) {
		return createPerformanceExportError('Performance export failed', {
			retryable: true, code: 'fetch_failed', cause: error
		})
	}
	const errorInstance = isRuntimeError(error)
	const name = readDataProperty(error, 'name')
	const message = readDataProperty(error, 'message')
	let domExceptionName = name
	let domExceptionInstance = false
	if (typeof DOMException !== 'undefined') {
		try {
			const nativeName = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get
			const detectedName = typeof nativeName === 'function' ? Reflect.apply(nativeName, error, []) : undefined
			if (typeof detectedName === 'string') {
				domExceptionInstance = true
				domExceptionName ??= detectedName
			}
		} catch {
			// A non-DOMException fails the native brand check without prototype traversal.
		}
	}
	if (domExceptionInstance && domExceptionName === 'AbortError') {
		return createPerformanceExportError(
			typeof message === 'string' && message ? message : 'Performance export aborted', {
				retryable: true,
				code: 'fetch_aborted',
				cause: error
			})
	}
	if (errorInstance) {
		return createPerformanceExportError(typeof message === 'string' ? message : 'Performance export failed', {
			retryable: true,
			code: 'fetch_failed',
			cause: error
		})
	}
	const messageValue = typeof error === 'string' ? error
		: typeof error === 'number' || typeof error === 'boolean' ? String(error)
			: 'Performance export failed'
	return createPerformanceExportError(messageValue, {
		retryable: true,
		code: 'fetch_failed',
		cause: error
	})
}
