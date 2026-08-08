import {isIP} from 'node:net'

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import {createMonotonicClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {validateHeaders, validateUrl} from '@ooopsstudio/core/utils/validation'

import {
	BUFFER_FLUSH_INTERVAL_PRODUCTION,
	EXPORTER_RETRY_BASE_DELAY_MS,
	EXPORTER_RETRY_MAX_DELAY_MS,
	EXPORTER_RETRY_MAX_RETRIES,
	EXPORTER_RETRY_MULTIPLIER,
	LABEL_LIMITS_PRODUCTION,
	OTLP_MAX_ENDPOINT_LENGTH,
	PRODUCTION_STALE_SERIES_AFTER_MS
} from '../constants'
import {createLeanMetricsHandler} from '../core/lean-handler'
import {wireMetricsLifecycle} from '../core/lifecycle'
import type {MetricExporterPort} from '../types/exporter'
import type {MetricsHandlerPort} from '../types/ports'
import {
	ConfigValidationError,
	validateInterval,
	validateLabelLimits,
	validateRetryConfig
} from '../utils/config-validation'
import {createMetricsOnError} from '../utils/on-error'
import {isPublicNetworkAddress} from '../utils/public-network-address'

import {snapshotInstrumentDefinitions} from './instruments'
import {observabilityResourceToMetricLabels} from './observability'
import type {MetricInstrumentDefinition} from './types'

export interface ProductionMetricsBaseOptions {
	readonly lifecycle?: LifecyclePort
	readonly resource?: ObservabilityResource
	readonly errors?: Errors
	readonly logger?: Logging
	readonly clock?: Clock
	readonly instruments?: readonly MetricInstrumentDefinition[]
}

const PRODUCTION_BASE_FIELDS = new Set(['lifecycle', 'resource', 'errors', 'logger', 'clock', 'instruments'])

export function snapshotProductionOptions(
	value: unknown,
	extraFields: ReadonlySet<string> = new Set(),
	label = 'Production metrics options'
): Record<string, unknown> {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null
			|| Object.getOwnPropertySymbols(value).length > 0) throw new Error()
		const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (key.length > 128 || (!PRODUCTION_BASE_FIELDS.has(key) && !extraFields.has(key))
				|| !descriptor.enumerable || !('value' in descriptor)) throw new Error()
			snapshot[key] = descriptor.value
		}
		return snapshot
	} catch {
		throw new ConfigValidationError(`${label} must contain only stable known data fields`)
	}
}

export function validateProductionOtlpEndpoint(endpoint: string): void {
	if (typeof endpoint !== 'string' || endpoint.length > OTLP_MAX_ENDPOINT_LENGTH) {
		throw new ConfigValidationError(
			`Production OTLP endpoint must be a string no longer than ${OTLP_MAX_ENDPOINT_LENGTH} characters`
		)
	}
	validateUrl(endpoint, 'OTLP endpoint')
	const url = new URL(endpoint)
	if (url.protocol !== 'https:')
		throw new ConfigValidationError('Production OTLP endpoint must use HTTPS')
	if (url.username || url.password) {
		throw new ConfigValidationError('Production OTLP endpoint must not contain embedded credentials')
	}
	if (url.search || url.hash) {
		throw new ConfigValidationError('Production OTLP endpoint must not contain query parameters or fragments')
	}
	const hostname = url.hostname.replaceAll('[', '').replaceAll(']', '').replace(/\.+$/u, '').toLowerCase()
	if (hostname === 'localhost' || (isIP(hostname) !== 0 && !isPublicNetworkAddress(hostname))) {
		throw new ConfigValidationError('Production OTLP endpoint must use a public network address')
	}
}

export function validateProductionOtlpHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	if (headers === undefined) return {}
	if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
		throw new ConfigValidationError('Production OTLP headers must expose stable string data fields')
	}
	let descriptors: PropertyDescriptorMap
	try {
		if (Object.getPrototypeOf(headers) !== Object.prototype
			|| Object.getOwnPropertySymbols(headers).length > 0) throw new Error('invalid')
		descriptors = Object.getOwnPropertyDescriptors(headers)
	} catch {
		throw new ConfigValidationError('Production OTLP headers must expose stable string data fields')
	}
	const stable: Record<string, string> = {}
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
			throw new ConfigValidationError('Production OTLP headers must expose stable string data fields')
		}
		if (key.length > 128 || descriptor.value.length > 8_192) {
			throw new ConfigValidationError('Production OTLP headers must contain bounded string data fields')
		}
		stable[key] = descriptor.value
	}
	validateHeaders(stable)
	return stable
}

export async function createProductionMetricsHandler(
	exporter: MetricExporterPort,
	options: ProductionMetricsBaseOptions
): Promise<MetricsHandlerPort> {
	if (!options || typeof options !== 'object') throw new ConfigValidationError('Production metrics options must be an object')
	const {lifecycle, resource, errors, logger, instruments, clock = createSystemClock()} = options
	const onError = createMetricsOnError(errors, {stage: 'metrics', preset: 'production'})
	validateLabelLimits(LABEL_LIMITS_PRODUCTION)
	validateInterval(BUFFER_FLUSH_INTERVAL_PRODUCTION, 'Buffer flushIntervalMs')
	validateRetryConfig({
		maxRetries: EXPORTER_RETRY_MAX_RETRIES,
		baseDelayMs: EXPORTER_RETRY_BASE_DELAY_MS,
		maxDelayMs: EXPORTER_RETRY_MAX_DELAY_MS,
		multiplier: EXPORTER_RETRY_MULTIPLIER,
		jitter: true
	})
	const handler = createLeanMetricsHandler({
		exporters: [exporter],
		labelLimits: LABEL_LIMITS_PRODUCTION,
		exemplars: true,
		resourceLabels: observabilityResourceToMetricLabels(resource),
		flushIntervalMs: BUFFER_FLUSH_INTERVAL_PRODUCTION,
		selfMetrics: true,
		clock,
		monotonicClock: createMonotonicClock(),
		staleAfterMs: PRODUCTION_STALE_SERIES_AFTER_MS,
		instruments: snapshotInstrumentDefinitions(instruments),
		...(errors ? {errors} : {}),
		...(logger ? {logger} : {}),
		exporterCircuitBreaker: {failureThreshold: 5, openMs: 30_000},
		exporterRetry: {
			maxRetries: EXPORTER_RETRY_MAX_RETRIES,
			baseDelayMs: EXPORTER_RETRY_BASE_DELAY_MS,
			maxDelayMs: EXPORTER_RETRY_MAX_DELAY_MS,
			multiplier: EXPORTER_RETRY_MULTIPLIER,
			jitter: true
		}
	})
	return await wireMetricsLifecycle(handler, lifecycle, {onError, ...(logger ? {logger} : {})})
}
