import {snapshotTraceRedactionRules} from '../features/redaction/rules'
import {snapshotDataFields} from '../utils/capabilities'

const RESOURCE_KEYS = new Set(['serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime', 'attributes'])
const LIMIT_KEYS = new Set(['maxAttributesPerSpan', 'maxEventsPerSpan', 'maxAttributeBytes'])
const SAMPLING_KEYS = new Set(['strategy', 'rate', 'sampler'])
const DESTINATION_KEYS = new Set(['provider', 'exporter', 'endpoint', 'headers'])
const DELIVERY_KEYS = new Set(['mode', 'batching', 'retry', 'backpressure', 'circuitBreaker'])
const BATCHING_KEYS = new Set(['maxBatch', 'maxIntervalMs', 'maxBytes'])
const RETRY_KEYS = new Set(['maxAttempts', 'baseDelayMs', 'multiplier', 'maxDelayMs', 'jitter', 'attemptTimeoutMs'])
const BACKPRESSURE_KEYS = new Set(['tokenBucketRate', 'tokenBucketBurst'])
const CIRCUIT_KEYS = new Set(['failureThreshold', 'halfOpenAfterMs'])

export function snapshotDevelopmentOptions(value: unknown): Readonly<Record<string, unknown>> {
	return snapshotPresetOptions(value, new Set(['clock', 'errors', 'metrics', 'logger', 'lifecycle', 'resource']), 'Development tracing options')
}

export function snapshotProductionOptions(value: unknown): Readonly<Record<string, unknown>> {
	return snapshotPresetOptions(value, new Set(['remote', 'sampling', 'clock', 'errors', 'metrics', 'logger', 'lifecycle', 'resource']), 'Production tracing options')
}

export function snapshotCustomOptions(value: unknown): Readonly<Record<string, unknown>> {
	const top = snapshotPresetOptions(value, new Set([
		'clock', 'sampling', 'destination', 'delivery', 'resource', 'redaction', 'limits',
		'errors', 'metrics', 'logger', 'lifecycle'
	]), 'Custom tracing options')
	const result: Record<string, unknown> = {...top}
	if (top.sampling !== undefined) result.sampling = snapshotPlainData(top.sampling, SAMPLING_KEYS, 'Tracing sampling policy')
	if (top.destination !== undefined) {
		const destination = snapshotPlainData(top.destination, DESTINATION_KEYS, 'Tracing destination')
		result.destination = destination.headers === undefined ? destination : Object.freeze({
			...destination,
			headers: snapshotHeaders(destination.headers)
		})
	}
	if (top.delivery !== undefined) {
		const delivery = snapshotPlainData(top.delivery, DELIVERY_KEYS, 'Tracing delivery policy')
		result.delivery = Object.freeze({
			...delivery,
			...(delivery.batching !== undefined ? {batching: snapshotPlainData(delivery.batching, BATCHING_KEYS, 'Tracing batching policy')} : {}),
			...(delivery.retry !== undefined ? {retry: snapshotPlainData(delivery.retry, RETRY_KEYS, 'Tracing retry policy')} : {}),
			...(delivery.backpressure !== undefined ? {backpressure: snapshotPlainData(delivery.backpressure, BACKPRESSURE_KEYS, 'Tracing backpressure policy')} : {}),
			...(delivery.circuitBreaker && typeof delivery.circuitBreaker === 'object'
				? {circuitBreaker: snapshotPlainData(delivery.circuitBreaker, CIRCUIT_KEYS, 'Tracing circuit-breaker policy')} : {})
		})
	}
	if (top.redaction !== undefined) {
		const redaction = snapshotPlainData(top.redaction, new Set(['additionalRules']), 'Tracing redaction options')
		result.redaction = Object.freeze({
			...(redaction.additionalRules !== undefined ? {additionalRules: snapshotTraceRedactionRules(redaction.additionalRules)} : {})
		})
	}
	if (top.limits !== undefined) result.limits = snapshotPlainData(top.limits, LIMIT_KEYS, 'Tracing limits')
	return Object.freeze(result)
}

function snapshotPresetOptions(value: unknown, allowed: ReadonlySet<string>, label: string): Readonly<Record<string, unknown>> {
	const top = snapshotPlainData(value, allowed, label)
	const result: Record<string, unknown> = {...top}
	if (top.resource !== undefined) {
		const resource = snapshotPlainData(top.resource, RESOURCE_KEYS, 'Tracing resource')
		result.resource = resource.attributes === undefined ? resource : Object.freeze({
			...resource,
			attributes: snapshotPlainData(resource.attributes, undefined, 'Tracing resource attributes')
		})
	}
	if (top.remote !== undefined) {
		const remote = snapshotPlainData(top.remote, new Set(['endpoint', 'headers']), 'Tracing OTLP remote')
		result.remote = remote.headers === undefined ? remote : Object.freeze({
			...remote,
			headers: snapshotHeaders(remote.headers)
		})
	}
	if (top.sampling !== undefined) result.sampling = snapshotPlainData(top.sampling, SAMPLING_KEYS, 'Tracing sampling policy')
	return Object.freeze(result)
}

/** Snapshot only the enumerable data fields that can become HTTP headers.
 * Inspect one descriptor at a time so the 100-header limit is an admission
 * bound rather than a check performed after materializing hostile input. */
function snapshotHeaders(value: unknown): Readonly<Record<string, unknown>> {
	try {
		return snapshotDataFields(value, 100, 256)
	} catch {
		throw new TypeError('Tracing OTLP headers must be a closed plain data object with at most 100 fields')
	}
}

function snapshotPlainData(value: unknown, allowed: ReadonlySet<string> | undefined, label: string): Readonly<Record<string, unknown>> {
	try {
		return snapshotDataFields(value, allowed?.size ?? 256, allowed ? 64 : 256, allowed)
	} catch {
		throw new TypeError(`${label} must be a closed plain data object`)
	}
}
