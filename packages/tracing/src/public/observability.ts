import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {ObservabilityResource, TraceCorrelationFields} from '@ooopsstudio/core/contracts/observability-shared'
import type {SpanContext} from '@ooopsstudio/core/contracts/tracing'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'

import {snapshotSpanAttributes, snapshotSpanContext} from '../core/span-recorder-safety'
import type {ResourceDetectionOptions} from '../features/resources/resource-detector'
import {captureCapability, snapshotDataFields} from '../utils/capabilities'
export function getActiveSpanContext(tracing: Tracing): SpanContext | undefined {
	try {
		const getActiveSpan = captureCapability<Parameters<Tracing['getActiveSpan']>, ReturnType<Tracing['getActiveSpan']>>(
			tracing, 'getActiveSpan'
		)
		const activeSpan = getActiveSpan?.()
		const getContext = captureCapability<[], SpanContext>(activeSpan, 'getContext')
		const context = getContext?.()
		return context ? snapshotSpanContext(context) : undefined
	} catch { return undefined }
}
export function getTraceCorrelation(tracing: Tracing): TraceCorrelationFields | undefined {
	const activeContext = getActiveSpanContext(tracing)
	let fallbackTraceId: string | undefined
	try {
		const currentTraceId = captureCapability<[], string | undefined>(tracing, 'currentTraceId')
		fallbackTraceId = currentTraceId?.()
	} catch { /* optional correlation is isolated */ }
	const traceId = activeContext?.traceId ?? (
		typeof fallbackTraceId === 'string' && /^[0-9a-f]{32}$/u.test(fallbackTraceId) && !/^0{32}$/u.test(fallbackTraceId)
			? fallbackTraceId : undefined
	)
	const spanId = activeContext?.spanId
	if (!traceId && !spanId) {
		return undefined
	}
	return {
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(traceId ? {traceId} : {}),
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(spanId ? {spanId} : {})
	}
}
export function observabilityResourceToTracingResource(
	resource?: ObservabilityResource
): LogAttributes | undefined {
	if (!resource) {
		return undefined
	}
	const snapshot = snapshotObservabilityResource(resource)
	const canonical: LogAttributes = {
		'service.name': snapshot.serviceName,
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(snapshot.serviceVersion ? {'service.version': snapshot.serviceVersion} : {}),
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(snapshot.deploymentEnvironment ? {'deployment.environment': snapshot.deploymentEnvironment} : {}),
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(snapshot.hostKind ? {'service.host_kind': snapshot.hostKind} : {}),
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(snapshot.runtime ? {'service.runtime': snapshot.runtime} : {})
	}
	// Keep identity fields ahead of caller attributes so the fixed resource key
	// budget cannot evict service attribution. Re-applying canonical values blocks
	// spoofing without changing their insertion positions.
	return snapshotSpanAttributes({
		...canonical,
		...(snapshot.attributes ?? {}),
		...canonical
	}, 64, 16_000) ?? canonical
}
export function observabilityResourceToDetectionOptions(
	resource?: ObservabilityResource
): ResourceDetectionOptions | undefined {
	if (!resource) {
		return undefined
	}
	const snapshot = snapshotObservabilityResource(resource)
	return {
		serviceName: snapshot.serviceName,
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(snapshot.serviceVersion ? {serviceVersion: snapshot.serviceVersion} : {}),
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(snapshot.deploymentEnvironment ? {deploymentEnvironment: snapshot.deploymentEnvironment} : {}),
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(snapshot.runtime ? {runtimeType: snapshot.runtime} : {})
	}
}

function snapshotObservabilityResource(resource: ObservabilityResource): ObservabilityResource {
	try {
		const allowed = new Set(['serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime', 'attributes'])
		const values = snapshotDataFields(resource, allowed.size, 64, allowed)
		for (const key of ['serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime']) {
			const value = values[key]
			if ((key === 'serviceName' || value !== undefined) && !isSafeResourceText(value)) throw new TypeError()
		}
		const attributes = values.attributes === undefined
			? undefined
			: snapshotSpanAttributes(values.attributes as LogAttributes, 64, 16_000)
		if (values.attributes !== undefined && attributes === undefined) throw new TypeError()
		return Object.freeze({
			serviceName: values.serviceName as string,
			...(values.serviceVersion ? {serviceVersion: values.serviceVersion as string} : {}),
			...(values.deploymentEnvironment ? {deploymentEnvironment: values.deploymentEnvironment as string} : {}),
			...(values.hostKind ? {hostKind: values.hostKind as string} : {}),
			...(values.runtime ? {runtime: values.runtime as string} : {}),
			...(attributes ? {attributes} : {})
		})
	} catch {
		throw new TypeError('Tracing observability resource must be a closed safe data object')
	}
}

function isSafeResourceText(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code <= 31 || code === 127) return false
	}
	return true
}
