import type {JsonValue} from '@ooopsstudio/core'
import type {SpanOptions, TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {normalizeError} from '@ooopsstudio/core/utils'

const HTTP_SERVER_ERROR_STATUS = 500

export const createHttpSpanOptions = (
	kind: 'client' | 'server',
	method: string,
	route: string,
	attributes: Readonly<Record<string, JsonValue>> = {}
): SpanOptions => {
	const safeAttributes: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
	try {
		for (const key of Reflect.ownKeys(attributes).slice(0, 64)) {
			if (typeof key !== 'string' || key.length === 0 || key.length > 128) continue
			const descriptor = Object.getOwnPropertyDescriptor(attributes, key)
			if (descriptor?.enumerable && 'value' in descriptor) safeAttributes[key] = descriptor.value
		}
	} catch {
		// Hostile optional attributes are ignored.
	}
	return {
		kind,
		attributes: {
			...safeAttributes,
			'http.request.method': method,
			'http.route': route
		}
	}
}

export const setHttpRequestSpanAttributes = (
	span: TracingSpan,
	method: string,
	route: string
): void => {
	try { span.setAttribute('http.request.method', method) } catch { /* tracing is fail-open */ }
	try { span.setAttribute('http.route', route) } catch { /* tracing is fail-open */ }
}

export const completeHttpSpan = (span: TracingSpan, statusCode: number): void => {
	try { span.setAttribute('http.response.status_code', statusCode) } catch { /* tracing is fail-open */ }
	try {
		span.setStatus(statusCode >= HTTP_SERVER_ERROR_STATUS
			? {code: 'error', description: `HTTP ${statusCode}`}
			: {code: 'ok'})
	} catch { /* tracing is fail-open */ }
}

export const failHttpSpan = (span: TracingSpan, error: unknown): void => {
	const normalized = normalizeError(error)
	try {
		span.recordException(error, {
			errorKind: normalized.kind,
			errorMessage: normalized.message
		})
	} catch { /* tracing is fail-open */ }
	try { span.setStatus({code: 'error', description: normalized.message}) } catch { /* tracing is fail-open */ }
}
