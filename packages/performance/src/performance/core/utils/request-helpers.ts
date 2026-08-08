import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {
	HttpPerfMetadata,
	PerfEvent,
	PerformanceEventRecord
} from '@ooopsstudio/core/contracts/performance'

import {sanitizePerformanceLabelValue} from '../../utils/safe-identifiers'
import {isRuntimeProxy} from '../../utils/safe-object'

const UUID_SEGMENT =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LONG_HEX_SEGMENT = /^[0-9a-f]{16,}$/i
const NUMERIC_SEGMENT = /^\d+$/
const EMAIL_SEGMENT = /^[^/@\s]+@[^/@\s]+\.[^/@\s]+$/u
const OPAQUE_SEGMENT = /^[a-z0-9+_=-]{24,}$/iu
const HTTP_OUTCOMES = new Set(['ok', 'client_error', 'server_error', 'timeout', 'aborted'])
const MAX_NORMALIZED_ROUTE_LENGTH = 256

const isDynamicRouteSegment = (segment: string): boolean => {
	let decoded = segment
	try { decoded = decodeURIComponent(segment) } catch { /* malformed encodings remain opaque input */ }
	return UUID_SEGMENT.test(decoded)
		|| LONG_HEX_SEGMENT.test(decoded)
		|| NUMERIC_SEGMENT.test(decoded)
		|| EMAIL_SEGMENT.test(decoded)
		|| OPAQUE_SEGMENT.test(decoded)
}

export function normalizeHttpRoute(route: string): string {
	if (typeof route !== 'string' || route.length > 2_048) {
		throw new Error('Performance HTTP route must be a string of at most 2048 characters')
	}
	if (!route.trim()) {
		return '/'
	}

	const withoutOrigin = route.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]+/i, '')
	const pathOnly = withoutOrigin.split('?')[0]?.split('#')[0] ?? '/'
	const normalized = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`
	const parts = normalized
		.split('/')
		.filter(Boolean)
		.map((segment) => {
			if (segment.startsWith(':') || (segment.startsWith('[') && segment.endsWith(']'))) {
				return segment
			}
			if (isDynamicRouteSegment(segment)) {
				return ':id'
			}
			return segment
		})

	return (parts.length === 0 ? '/' : `/${parts.join('/')}`).slice(0, MAX_NORMALIZED_ROUTE_LENGTH)
}

export function classifyHttpOutcome(metadata: HttpPerfMetadata): NonNullable<HttpPerfMetadata['outcome']> {

	if (metadata.aborted) {
		return 'aborted'
	}
	if (metadata.timedOut) {
		return 'timeout'
	}
	if (typeof metadata.statusCode === 'number') {
		if (metadata.statusCode >= 500) {
			return 'server_error'
		}
		if (metadata.statusCode >= 400) {
			return 'client_error'
		}
	}
	return 'ok'
}

export function normalizeHttpMetadata(metadata: HttpPerfMetadata): HttpPerfMetadata {
	if (!metadata || typeof metadata !== 'object' || isRuntimeProxy(metadata) || Array.isArray(metadata)) {
		throw new Error('Performance HTTP metadata must be an object')
	}
	const readField = (key: keyof HttpPerfMetadata): unknown => {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(metadata, key) } catch {
			throw new Error('Performance HTTP metadata must use readable data properties')
		}
		return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined
	}
	const rawRoute = readField('route')
	const rawMethod = readField('method')
	const rawStatusCode = readField('statusCode')
	const rawRequestSize = readField('requestSize')
	const rawResponseSize = readField('responseSize')
	const rawHostKind = readField('hostKind')
	const rawRuntime = readField('runtime')
	const rawAborted = readField('aborted')
	const rawTimedOut = readField('timedOut')
	const rawOutcome = readField('outcome')
	if (typeof rawRoute !== 'string') throw new Error('Performance HTTP route must be a string')
	const normalizedRoute = normalizeHttpRoute(rawRoute)
	if (typeof rawMethod !== 'string') {
		throw new Error('Performance HTTP method must be a string')
	}
	const methodCandidate = rawMethod.length <= 32 ? rawMethod.trim().toUpperCase() : ''
	const normalizedMethod = /^[A-Z][A-Z0-9_-]{0,31}$/.test(methodCandidate)
		? methodCandidate
		: 'UNKNOWN'
	const statusCode = Number.isInteger(rawStatusCode) && (rawStatusCode as number) >= 100 && (rawStatusCode as number) <= 599
		? rawStatusCode as number
		: undefined
	const requestSize = Number.isSafeInteger(rawRequestSize) && (rawRequestSize as number) >= 0
		? rawRequestSize as number
		: undefined
	const responseSize = Number.isSafeInteger(rawResponseSize) && (rawResponseSize as number) >= 0
		? rawResponseSize as number
		: undefined
	const normalized: HttpPerfMetadata = {
		method: normalizedMethod,
		route: normalizedRoute,
		...(statusCode !== undefined ? {statusCode} : {}),
		...(requestSize !== undefined ? {requestSize} : {}),
		...(responseSize !== undefined ? {responseSize} : {}),
		...(typeof rawHostKind === 'string' && rawHostKind.length <= 256
			? {hostKind: sanitizePerformanceLabelValue(rawHostKind)}
			: {}),
		...(typeof rawRuntime === 'string' && rawRuntime.length <= 256
			? {runtime: sanitizePerformanceLabelValue(rawRuntime)}
			: {}),
		...(rawAborted === true ? {aborted: true} : {}),
		...(rawTimedOut === true ? {timedOut: true} : {})
	}
	const observedOutcome = normalized.aborted || normalized.timedOut ||
		(typeof normalized.statusCode === 'number' && normalized.statusCode >= 200)
		? classifyHttpOutcome(normalized)
		: undefined
	const outcome = observedOutcome ?? (
		typeof rawOutcome === 'string' && rawOutcome.length <= 16 && HTTP_OUTCOMES.has(rawOutcome)
			? rawOutcome as NonNullable<HttpPerfMetadata['outcome']>
			: classifyHttpOutcome(normalized)
	)

	normalized.outcome = outcome
	return normalized
}

export function buildHttpLabels(
	metadata: HttpPerfMetadata,
	labels?: Record<string, string>
): Record<string, string> {

	const normalized = normalizeHttpMetadata(metadata)
	return {
		...(labels ?? {}),
		method: normalized.method,
		route: normalized.route,
		status_code: String(normalized.statusCode ?? 0),
		status_class:
			typeof normalized.statusCode === 'number'
				? `${Math.floor(normalized.statusCode / 100)}xx`
				: 'unknown',
		...(normalized.hostKind ? {host_kind: normalized.hostKind} : {}),
		...(normalized.runtime ? {runtime: normalized.runtime} : {}),
		outcome: normalized.outcome ?? 'ok'
	}
}

export function toPerformanceEventRecord(
	event: PerfEvent,
	resource?: ObservabilityResource
): PerformanceEventRecord {

	return {
		recordedAt: event.end,
		event,
		source: event.source,
		...(event.traceId ? {traceId: event.traceId} : {}),
		...(event.spanId ? {spanId: event.spanId} : {}),
		...(event.http ? {http: event.http} : {}),
		...(event.dbMetadata ? {dbMetadata: event.dbMetadata} : {}),
		...(resource ? {resource} : {})
	}
}
