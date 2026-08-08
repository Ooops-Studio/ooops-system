import type {PerformanceSpanOptions} from '@ooopsstudio/core/contracts/performance'
import type {Tracing, TracingSpan} from '@ooopsstudio/core/ports/tracing'

import type {PerformanceTracingBridge} from '../types/ports'
import {isSensitivePerformanceKey, sanitizePerformanceLabelValue} from '../utils/safe-identifiers'
import {ignoreRuntimePromiseRejection, isRuntimeProxy} from '../utils/safe-object'
import {createSingleFlightMethodCapture} from '../utils/single-flight-method'

import {snapshotSafeDBMetadata} from './utils/event-helpers'
import {normalizeHttpMetadata} from './utils/request-helpers'

const sanitizeSpanValue = (value: unknown): string | number | boolean => {
	if (typeof value === 'string') return value.length <= 256 ? sanitizePerformanceLabelValue(value) : '[redacted]'
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'boolean') return value
	return '[redacted]'
}

const SPAN_OPTION_FIELDS = ['labels', 'kind', 'attributes', 'http', 'dbMetadata', 'createSpan'] as const

export const snapshotPerformanceSpanOptions = (
	options: PerformanceSpanOptions | undefined
): PerformanceSpanOptions | undefined => {
	if (options === undefined) return undefined
	if (!options || typeof options !== 'object' || isRuntimeProxy(options) || Array.isArray(options)) return undefined
	const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		for (const key of SPAN_OPTION_FIELDS) {
			const descriptor = Object.getOwnPropertyDescriptor(options, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) continue
			if (key === 'http') {
				try {
					snapshot[key] = normalizeHttpMetadata(descriptor.value as never)
				} catch {
					// Omit invalid or accessor-backed optional metadata.
				}
			} else if (key === 'dbMetadata') {
				const metadata = snapshotSafeDBMetadata(descriptor.value)
				if (metadata) snapshot[key] = metadata
			} else snapshot[key] = descriptor.value
		}
	} catch { return undefined }
	return snapshot as PerformanceSpanOptions
}

const sanitizeSpanAttributes = (attributes: Record<string, unknown> | undefined): Record<string, string | number | boolean> => {
	const sanitized: Record<string, string | number | boolean> = {}
	try {
		const source = attributes ?? {}
		if (isRuntimeProxy(source)) return {}
		const prototype = Object.getPrototypeOf(source)
		if (prototype !== Object.prototype && prototype !== null) return {}
		let inspected = 0
		for (const key in source) {
			if (inspected >= 32) break
			const descriptor = Object.getOwnPropertyDescriptor(source, key)
			if (!descriptor?.enumerable) continue
			if (!('value' in descriptor)) continue
			inspected += 1
			if (/^[a-z][a-z0-9_.-]{0,63}$/iu.test(key)) {
				sanitized[key] = isSensitivePerformanceKey(key) ? '[redacted]' : sanitizeSpanValue(descriptor.value)
			}
		}
	} catch {
		return {}
	}
	return sanitized
}

const sanitizeCorrelationId = (value: unknown, length: number): string | undefined =>
	typeof value === 'string' && value.length === length && /^[0-9a-f]+$/iu.test(value) && !/^0+$/u.test(value)
		? value.toLowerCase()
		: undefined

const readCorrelationField = (context: unknown, key: 'traceId' | 'spanId'): unknown => {
	if (!context || typeof context !== 'object' || isRuntimeProxy(context)) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(context, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch { return undefined }
}

const toSpanAttributes = (
	options: PerformanceSpanOptions | undefined,
	duration: number,
	outcome: 'ok' | 'error'
): Record<string, unknown> => ({
	...sanitizeSpanAttributes(options?.attributes),
	...sanitizeSpanAttributes(options?.labels),
	'perf.duration_ms': duration,
	'perf.outcome': outcome,
	...(options?.http?.route ? {'http.route': sanitizeSpanValue(options.http.route)} : {}),
	...(options?.http?.method ? {'http.method': sanitizeSpanValue(options.http.method)} : {}),
	...(typeof options?.http?.statusCode === 'number' ? {'http.status_code': sanitizeSpanValue(options.http.statusCode)} : {}),
	...(options?.dbMetadata?.collection ? {'db.collection': sanitizeSpanValue(options.dbMetadata.collection)} : {}),
	...(options?.dbMetadata?.table ? {'db.table': sanitizeSpanValue(options.dbMetadata.table)} : {}),
	...(options?.dbMetadata?.operation ? {'db.operation': sanitizeSpanValue(options.dbMetadata.operation)} : {}),
	...(options?.dbMetadata?.queryHash ? {'db.query_hash': sanitizeSpanValue(options.dbMetadata.queryHash)} : {})
})

export function createPerformanceTracingBridge(
	tracer?: Tracing
): PerformanceTracingBridge {
	const captureMethod = createSingleFlightMethodCapture()
	const captureSpanMethod = createSingleFlightMethodCapture()
	const getActiveSpan = captureMethod(tracer, 'getActiveSpan')
	const readCurrentTraceId = captureMethod(tracer, 'currentTraceId')
	const inSpan = captureMethod(tracer, 'inSpan')

	return {
		getCorrelation(): {traceId?: string; spanId?: string} {
			let context: unknown
			try {
				const activeSpan = getActiveSpan?.()
				context = captureSpanMethod(activeSpan, 'getContext')?.()
			} catch { /* optional tracing context */ }
			let currentTraceId: unknown
			try { currentTraceId = readCurrentTraceId?.() } catch { /* fall back to active context */ }
			const traceId = sanitizeCorrelationId(currentTraceId, 32) ??
				sanitizeCorrelationId(readCorrelationField(context, 'traceId'), 32)
			const spanId = sanitizeCorrelationId(readCorrelationField(context, 'spanId'), 16)
			return {
				...(traceId ? {traceId} : {}),
				...(spanId ? {spanId} : {})
			}
		},
		async withSpan<T>(
			name: string,
			options: PerformanceSpanOptions | undefined,
			fn: (span?: TracingSpan) => Promise<T>
		): Promise<T> {
			if (!tracer) {
				return await fn(undefined)
			}
			const capturedOptions = snapshotPerformanceSpanOptions(options)
			const createSpan = capturedOptions?.createSpan === true
			if (createSpan) {
				if (!inSpan) return await fn(undefined)
				let spanOptions: NonNullable<Parameters<Tracing['inSpan']>[2]>
				try {
					spanOptions = {
						...(capturedOptions?.kind ? {kind: capturedOptions.kind} : {}),
						...(capturedOptions?.attributes ? {attributes: sanitizeSpanAttributes(capturedOptions.attributes)} : {})
					}
				} catch {
					return await fn(undefined)
				}
				let invoked = false
				let callbackPromise: Promise<T> | undefined
				const invokeOnce = (span?: TracingSpan): Promise<T> => {
					callbackPromise ??= Promise.resolve().then(async() => await fn(span))
					return callbackPromise
				}
				try {
					const tracerOperation = inSpan(name, async(span: TracingSpan | undefined) => {
						invoked = true
						try {
							return await invokeOnce(span)
						} catch {
							// A broken tracer may ignore the callback Promise. Resolve its
							// wrapper and rethrow the original operation error from this bridge.
							return undefined as T
						}
					}, {...spanOptions})
					ignoreRuntimePromiseRejection(tracerOperation)
					// Give tracers one microtask to invoke their callback. A tracer that
					// delays or never settles must not delay the measured business work.
					await Promise.resolve()
					if (!invoked) return await invokeOnce(undefined)
					return await callbackPromise as T
				} catch {
					if (!invoked) return await invokeOnce(undefined)
					return await callbackPromise as T
				}
			}
			let activeSpan: TracingSpan | undefined
			try { activeSpan = getActiveSpan?.() as TracingSpan | undefined } catch { /* tracing is optional */ }
			return await fn(activeSpan)
		},
		annotate(
			span: TracingSpan | undefined,
			options: PerformanceSpanOptions | undefined,
			duration: number,
			outcome: 'ok' | 'error'
		): void {
			if (!span) {
				return
			}
			try {
				const setAttribute = captureSpanMethod(span, 'setAttribute')
				const addEvent = captureSpanMethod(span, 'addEvent')
				const setStatus = captureSpanMethod(span, 'setStatus')
				const capturedOptions = snapshotPerformanceSpanOptions(options)
				for (const [key, value] of Object.entries(toSpanAttributes(capturedOptions, duration, outcome))) {
					setAttribute?.(key, value)
				}
				addEvent?.('performance.measurement', {
					...sanitizeSpanAttributes(capturedOptions?.labels),
					duration_ms: duration,
					outcome
				})
				setStatus?.({code: outcome === 'ok' ? 'ok' : 'error'})
			} catch {
				// Tracing decoration must not alter the measured operation.
			}
		},
		recordError(span: TracingSpan | undefined, _error: unknown): void {
			if (!span) {
				return
			}
			try {
				const recordException = captureSpanMethod(span, 'recordException')
				const setStatus = captureSpanMethod(span, 'setStatus')
				// The measured operation's exception can contain credentials, query text,
				// payloads, or a sensitive stack. Performance only owns the outcome signal;
				// detailed error capture belongs to the errors service and its redaction policy.
				const message = 'Performance measured operation failed'
				recordException?.(new Error(message))
				setStatus?.({code: 'error', description: message})
			} catch {
				// Tracing failures must not replace the operation's original error.
			}
		}
	}
}
