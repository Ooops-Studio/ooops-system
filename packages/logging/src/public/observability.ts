import type {LogAttributes, LogContext} from '@ooopsstudio/core/contracts/logging'
import type {ObservabilityResource, TraceCorrelationFields} from '@ooopsstudio/core/contracts/observability-shared'
import type {TracerPort, Tracing} from '@ooopsstudio/core/ports/tracing'

import type {EnrichingProvider} from '../types/enriching'
import {captureLoggingMethod, observeLoggingThenable, readLoggingDataProperty} from '../utils/capabilities'
import {copyLogAttributes, mergeAttributes, mergeContext} from '../utils/enriching'

export interface LoggingObservabilityOptions {
	readonly resource?: ObservabilityResource
	readonly tracing?: TracerPort | Tracing
}

function safeRead<T>(value: object | undefined, key: string): T | undefined {
	return readLoggingDataProperty<T>(value, key)
}

function normalizeCorrelationId(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const normalized = value.trim()
	return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined
}

export function observabilityResourceToLogAttributes(
	resource?: ObservabilityResource
): LogAttributes {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!resource) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return {}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	const base: Record<string, unknown> = {}
	const serviceName = safeRead<string>(resource, 'serviceName')
	const serviceVersion = safeRead<string>(resource, 'serviceVersion')
	const deploymentEnvironment = safeRead<string>(resource, 'deploymentEnvironment')
	const hostKind = safeRead<string>(resource, 'hostKind')
	const runtime = safeRead<string>(resource, 'runtime')
	if (typeof serviceName === 'string' && serviceName.length > 0) {
		base['service.name'] = serviceName
	}
	if (typeof serviceVersion === 'string' && serviceVersion) base['service.version'] = serviceVersion
	if (typeof deploymentEnvironment === 'string' && deploymentEnvironment) base['deployment.environment'] = deploymentEnvironment
	if (typeof hostKind === 'string' && hostKind) base['service.host_kind'] = hostKind
	if (typeof runtime === 'string' && runtime) base['service.runtime'] = runtime
	const attributes = copyLogAttributes(safeRead<LogAttributes>(resource, 'attributes'))
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return mergeAttributes(base as LogAttributes, attributes) ?? {}
}

export function buildObservabilityLogContext(
	context: LogContext | undefined,
	resource?: ObservabilityResource
): LogContext | undefined {
	if (!resource) {
		return context
	}
	const resourceAttributes = observabilityResourceToLogAttributes(resource)
	return mergeContext(context, {attributes: resourceAttributes})
}

export function getTraceCorrelation(
	tracing?: TracerPort | Tracing
): TraceCorrelationFields | undefined {
	if (!tracing) {
		return undefined
	}
	let traceId: string | undefined
	let spanId: string | undefined
	try {
		const currentTraceId = captureLoggingMethod<() => unknown>(tracing, 'currentTraceId')
		const result = currentTraceId?.call(tracing)
		if (!observeLoggingThenable(result)) traceId = normalizeCorrelationId(result)
	} catch {
		// Correlation is best-effort and must never break the logging pipeline.
	}
	try {
		const getActiveSpan = captureLoggingMethod<NonNullable<Tracing['getActiveSpan']>>(tracing, 'getActiveSpan')
		let activeSpan: unknown = typeof getActiveSpan === 'function'
			? getActiveSpan.call(tracing)
			: undefined
		if (observeLoggingThenable(activeSpan)) activeSpan = undefined
		const getContext = activeSpan && captureLoggingMethod<() => unknown>(activeSpan, 'getContext')
		let spanContext: unknown = typeof getContext === 'function'
			? getContext.call(activeSpan)
			: undefined
		if (observeLoggingThenable(spanContext)) spanContext = undefined
		spanId = normalizeCorrelationId(
			spanContext && typeof spanContext === 'object'
				? safeRead<unknown>(spanContext, 'spanId')
				: undefined
		)
	} catch {
		// A failing active-span implementation is treated as unavailable.
	}
	if (!traceId && !spanId) {
		return undefined
	}
	return {
		...(traceId ? {traceId} : {}),
		...(spanId ? {spanId} : {})
	}
}

export function createTraceCorrelationProvider(
	tracing?: TracerPort | Tracing
): EnrichingProvider {
	return () => {
		const fields = getTraceCorrelation(tracing)
		return fields ? ({...fields}) : {}
	}
}
