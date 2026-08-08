/**
 * @file Public tracing helpers for common production operations.
 */
import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanKind} from '@ooopsstudio/core/contracts/tracing'
import type {SpanOptions, Tracing, TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {captureNativePromiseResult} from '@ooopsstudio/core/runtime/async/native-promise'
import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {describeSpanException, snapshotSpanAttributes} from '../core/span-recorder-safety'
import {captureCapability, snapshotDataFields} from '../utils/capabilities'
import {SEMCONV_DB, SEMCONV_HTTP, SEMCONV_MESSAGING, SEMCONV_RPC} from '../utils/semantic-conventions'
function snapshotHelperOptions<T extends object>(value: T): T {
	try {
		return snapshotDataFields(value, 16, 64) as T
	} catch { throw new TypeError('Tracing helper options must be a plain data object') }
}
function compact(attrs: Record<string, unknown>): LogAttributes {
	const result: Record<string, JsonValue> = {}
	for (const [key, value] of Object.entries(attrs)) {
		if (value !== undefined) {
			result[key] = value as JsonValue
		}
	}
	return result
}
function mergeAttributes(custom: LogAttributes | undefined, canonical: Record<string, unknown>): LogAttributes {
	const canonicalAttributes = compact(canonical)
	const customAttributes = snapshotSpanAttributes(custom ?? {}, 128, 8_192) ?? {}
	// Canonical fields are inserted first so downstream span limits cannot evict
	// them behind a caller-controlled attribute flood. Re-applying them last fixes
	// their values without changing their original insertion positions.
	return snapshotSpanAttributes({
		...canonicalAttributes,
		...customAttributes,
		...canonicalAttributes
	}, 128, 8_192) ?? canonicalAttributes
}
function parentOptions(options: {parent?: SpanOptions['parent']}): Pick<SpanOptions, 'parent'> | undefined {
	return options.parent === undefined ? undefined : {parent: options.parent}
}
function runSpanDiagnostic(operation: (() => unknown) | undefined): void {
	if (!operation) return
	try {
		const outcome = operation()
		isolateUnexpectedThenable(outcome)
	} catch { /* span diagnostics are best-effort */ }
}
async function traceOperation<T>(
	tracing: Tracing,
	name: string,
	kind: SpanKind,
	attributes: LogAttributes,
	fn: () => T | Promise<T>,
	options?: Omit<SpanOptions, 'kind' | 'attributes'>,
	httpErrorStatus?: number
): Promise<T> {
	const inSpan = captureCapability<Parameters<Tracing['inSpan']>, ReturnType<Tracing['inSpan']>>(tracing, 'inSpan')
	if (!inSpan) throw new TypeError('Tracing helper requires an inSpan() data method')
	const spanOptions: SpanOptions = {
		kind,
		attributes,
		...(options?.parent !== undefined ? {parent: options.parent} : {})
	}
	const result = inSpan(name, async(span) => {
		const setStatus = captureCapability<Parameters<TracingSpan['setStatus']>, unknown>(span, 'setStatus')
		const recordException = captureCapability<Parameters<TracingSpan['recordException']>, unknown>(span, 'recordException')
		try {
			const result = await fn()
			runSpanDiagnostic(setStatus ? () => setStatus(httpErrorStatus !== undefined
				? {code: 'error', description: `HTTP ${httpErrorStatus}`}
				: {code: 'ok'}) : undefined)
			return result
		} catch(error) {
			runSpanDiagnostic(recordException ? () => recordException(error) : undefined)
			const description = describeSpanException(error).message
			runSpanDiagnostic(setStatus ? () => setStatus({code: 'error', description}) : undefined)
			throw error
		}
	}, spanOptions)
	const completion = captureNativePromiseResult<T>(result)
	if (!completion) throw new TypeError('Tracing helper inSpan() must return a native Promise')
	return await completion
}
export async function traceHttpServer<T>(
	tracing: Tracing,
	name: string,
	fn: () => T | Promise<T>,
	options: {
		method: string
		route?: string
		url?: string
		statusCode?: number
		attributes?: LogAttributes
		parent?: SpanOptions['parent']
	}): Promise<T> {
	options = snapshotHelperOptions(options)
	return traceOperation(tracing, name, 'server', mergeAttributes(options.attributes, {
		[SEMCONV_HTTP.METHOD]: options.method,
		[SEMCONV_HTTP.ROUTE]: options.route,
		[SEMCONV_HTTP.URL]: options.url,
		[SEMCONV_HTTP.STATUS_CODE]: options.statusCode
	}), fn, parentOptions(options),
	typeof options.statusCode === 'number' && options.statusCode >= 500 ? options.statusCode : undefined)
}
export async function traceHttpClient<T>(
	tracing: Tracing,
	name: string,
	fn: () => T | Promise<T>,
	options: {
		method: string
		url?: string
		statusCode?: number
		attributes?: LogAttributes
		parent?: SpanOptions['parent']
	}): Promise<T> {
	options = snapshotHelperOptions(options)
	return traceOperation(tracing, name, 'client', mergeAttributes(options.attributes, {
		[SEMCONV_HTTP.METHOD]: options.method,
		[SEMCONV_HTTP.URL]: options.url,
		[SEMCONV_HTTP.STATUS_CODE]: options.statusCode
	}), fn, parentOptions(options),
	typeof options.statusCode === 'number' && options.statusCode >= 400 ? options.statusCode : undefined)
}
export async function traceDb<T>(
	tracing: Tracing,
	name: string,
	fn: () => T | Promise<T>,
	options: {
		system: string
		operation?: string
		name?: string
		table?: string
		attributes?: LogAttributes
		parent?: SpanOptions['parent']
	}): Promise<T> {
	options = snapshotHelperOptions(options)
	return traceOperation(tracing, name, 'client', mergeAttributes(options.attributes, {
		[SEMCONV_DB.SYSTEM]: options.system,
		[SEMCONV_DB.OPERATION]: options.operation,
		[SEMCONV_DB.NAME]: options.name,
		[SEMCONV_DB.SQL_TABLE]: options.table
	}), fn, parentOptions(options))
}
export async function traceMessageProduce<T>(
	tracing: Tracing,
	name: string,
	fn: () => T | Promise<T>,
	options: {
		system: string
		destination: string
		messageId?: string
		attributes?: LogAttributes
		parent?: SpanOptions['parent']
	}): Promise<T> {
	options = snapshotHelperOptions(options)
	return traceOperation(tracing, name, 'producer', mergeAttributes(options.attributes, {
		[SEMCONV_MESSAGING.SYSTEM]: options.system,
		[SEMCONV_MESSAGING.DESTINATION]: options.destination,
		[SEMCONV_MESSAGING.MESSAGE_ID]: options.messageId,
		[SEMCONV_MESSAGING.OPERATION]: 'publish'
	}), fn, parentOptions(options))
}
export async function traceMessageConsume<T>(
	tracing: Tracing,
	name: string,
	fn: () => T | Promise<T>,
	options: {
		system: string
		destination: string
		consumerId?: string
		messageId?: string
		attributes?: LogAttributes
		parent?: SpanOptions['parent']
	}): Promise<T> {
	options = snapshotHelperOptions(options)
	return traceOperation(tracing, name, 'consumer', mergeAttributes(options.attributes, {
		[SEMCONV_MESSAGING.SYSTEM]: options.system,
		[SEMCONV_MESSAGING.DESTINATION]: options.destination,
		[SEMCONV_MESSAGING.CONSUMER_ID]: options.consumerId,
		[SEMCONV_MESSAGING.MESSAGE_ID]: options.messageId,
		[SEMCONV_MESSAGING.OPERATION]: 'process'
	}), fn, parentOptions(options))
}
export async function traceRpcClient<T>(
	tracing: Tracing,
	name: string,
	fn: () => T | Promise<T>,
	options: {
		system: string
		service: string
		method: string
		attributes?: LogAttributes
		parent?: SpanOptions['parent']
	}): Promise<T> {
	options = snapshotHelperOptions(options)
	return traceOperation(tracing, name, 'client', mergeAttributes(options.attributes, {
		[SEMCONV_RPC.SYSTEM]: options.system,
		[SEMCONV_RPC.SERVICE]: options.service,
		[SEMCONV_RPC.METHOD]: options.method
	}), fn, parentOptions(options))
}
export async function traceRpcServer<T>(
	tracing: Tracing,
	name: string,
	fn: () => T | Promise<T>,
	options: {
		system: string
		service: string
		method: string
		attributes?: LogAttributes
		parent?: SpanOptions['parent']
	}): Promise<T> {
	options = snapshotHelperOptions(options)
	return traceOperation(tracing, name, 'server', mergeAttributes(options.attributes, {
		[SEMCONV_RPC.SYSTEM]: options.system,
		[SEMCONV_RPC.SERVICE]: options.service,
		[SEMCONV_RPC.METHOD]: options.method
	}), fn, parentOptions(options))
}
export async function traceJob<T>(
	tracing: Tracing,
	name: string,
	fn: () => T | Promise<T>,
	options: {
		jobType: string
		jobId?: string
		attributes?: LogAttributes
		parent?: SpanOptions['parent']
	}): Promise<T> {
	options = snapshotHelperOptions(options)
	return traceOperation(tracing, name, 'internal', mergeAttributes(options.attributes, {
		'job.type': options.jobType,
		'job.id': options.jobId
	}), fn, parentOptions(options))
}
