import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'

import {
	DEFAULT_BUFFER_FLUSH_INTERVAL_MS,
	EXPORTER_RETRY_BASE_DELAY_MS,
	EXPORTER_RETRY_MAX_DELAY_MS,
	EXPORTER_RETRY_MAX_RETRIES,
	EXPORTER_RETRY_MULTIPLIER,
	LABEL_LIMITS_PRODUCTION
} from '../constants'
import {createLeanMetricsHandler} from '../core/lean-handler'
import {wireMetricsLifecycle} from '../core/lifecycle'
import {
	createManagedMetricsFacade,
	createPrometheusManagedMetricsFacade
} from '../core/managed-facade'
import type {MetricExporterPort} from '../types/exporter'
import {assertMetricsClock} from '../utils/clock'
import {ConfigValidationError, validateInterval, validateLabelLimits, validateRetryConfig} from '../utils/config-validation'
import type {LabelLimits} from '../utils/label-sanitizer'
import {createMetricsOnError} from '../utils/on-error'
import {capturePrometheusScrapeCapability} from '../utils/prometheus-scrape-capability'

import {snapshotInstrumentDefinitions} from './instruments'
import {observabilityResourceToMetricLabels} from './observability'
import {snapshotPresetOptions} from './preset-options'
import type {
	ManagedMetrics,
	MetricExporter,
	MetricInstrumentDefinition,
	MetricTemporality,
	PrometheusManagedMetrics
} from './types'

export interface PrometheusMetricDestination {
	readonly provider: 'prometheus'
	readonly maxBufferSize?: number
	readonly maxBufferLines?: number
}

export interface OtlpMetricDestination {
	readonly provider: 'otlp'
	readonly endpoint: string
	readonly headers?: Readonly<Record<string, string>>
	readonly timeout?: number
	readonly enableGzip?: boolean
	readonly gzipThresholdBytes?: number
}

export interface CustomMetricDestination {
	readonly provider: 'custom'
	readonly exporter: MetricExporter
}

export type MetricDestination =
	| PrometheusMetricDestination
	| OtlpMetricDestination
	| CustomMetricDestination

export interface CustomMetricsOptions {
	readonly clock: Clock
	readonly destinations: readonly MetricDestination[]
	readonly resource?: ObservabilityResource
	readonly instruments?: readonly MetricInstrumentDefinition[]
	readonly limits?: LabelLimits
	readonly exemplars?: boolean
	readonly temporality?: MetricTemporality
	readonly staleAfterMs?: number
	readonly delivery?: {
		readonly flushIntervalMs?: number
		readonly operationTimeoutMs?: number
		readonly retry?: {
			readonly maxRetries: number
			readonly baseDelayMs: number
			readonly maxDelayMs: number
			readonly multiplier: number
			readonly jitter?: boolean
		}
		readonly circuitBreaker?: false | {
			readonly failureThreshold: number
			readonly openMs: number
		}
	}
	readonly selfMetrics?: boolean
	readonly lifecycle?: LifecyclePort
	readonly errors?: Errors
	readonly logger?: Logging
}

const OPTION_FIELDS = new Set([
	'clock', 'destinations', 'resource', 'instruments', 'limits', 'exemplars',
	'temporality', 'staleAfterMs', 'delivery', 'selfMetrics', 'lifecycle', 'errors', 'logger'
])

function snapshotHeaders(value: unknown): Readonly<Record<string, string>> {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value)
			|| Object.getPrototypeOf(value) !== Object.prototype
			|| Object.getOwnPropertySymbols(value).length > 0) throw new Error()
		const result: Record<string, string> = {}
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
				throw new Error()
			}
			if (key.length > 128 || descriptor.value.length > 8_192) throw new Error()
			result[key] = descriptor.value
		}
		return Object.freeze(result)
	} catch {
		throw new ConfigValidationError('Custom metrics OTLP headers must contain stable string data fields')
	}
}

function snapshotDestinations(value: unknown): readonly MetricDestination[] {
	if (!Array.isArray(value)) throw new ConfigValidationError('Custom metrics destinations must be an array')
	let descriptors: PropertyDescriptorMap
	try {
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error()
	} catch {
		throw new ConfigValidationError('Custom metrics destinations must expose stable entries')
	}
	const lengthDescriptor = descriptors.length
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
	if (!Number.isSafeInteger(length) || length < 1 || length > 2) {
		throw new ConfigValidationError('Custom metrics requires between one and two destinations')
	}
	for (const key of Object.keys(descriptors)) {
		if (key !== 'length' && (key.length > 16
			|| !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length)) {
			throw new ConfigValidationError('Custom metrics destinations must expose only stable entries')
		}
	}
	const destinations: MetricDestination[] = []
	for (let index = 0; index < length; index += 1) {
		const itemDescriptor = descriptors[String(index)]
		if (!itemDescriptor || !itemDescriptor.enumerable || !('value' in itemDescriptor)) {
			throw new ConfigValidationError('Custom metrics destinations must be a dense stable array')
		}
		const item = itemDescriptor.value
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new ConfigValidationError('Custom metrics destinations must contain objects')
		}
		let provider: unknown
		try {
			const descriptor = Object.getOwnPropertyDescriptor(item, 'provider')
			provider = descriptor && 'value' in descriptor ? descriptor.value : undefined
		} catch {
			throw new ConfigValidationError('Custom metrics destination must expose stable data fields')
		}
		const fields = provider === 'prometheus'
			? new Set(['provider', 'maxBufferSize', 'maxBufferLines'])
			: provider === 'otlp'
				? new Set(['provider', 'endpoint', 'headers', 'timeout', 'enableGzip', 'gzipThresholdBytes'])
				: provider === 'custom' ? new Set(['provider', 'exporter']) : undefined
		if (!fields) throw new ConfigValidationError('Custom metrics destination provider is unsupported')
		const stable = snapshotPresetOptions(item, fields, 'Custom metrics destination') as unknown as MetricDestination
		if (stable.provider === 'otlp' && stable.headers !== undefined) {
			destinations.push(Object.freeze({...stable, headers: snapshotHeaders(stable.headers)}))
			continue
		}
		destinations.push(Object.freeze(stable))
	}
	if (destinations.filter((item) => item.provider === 'prometheus').length > 1) {
		throw new ConfigValidationError('Custom metrics supports at most one Prometheus destination')
	}
	return Object.freeze(destinations)
}

async function resolveDestination(
	destination: MetricDestination,
	logger: Logging | undefined,
	onError: (error: unknown, context?: Record<string, string>) => void
): Promise<MetricExporterPort> {
	switch (destination.provider) {
		case 'custom':
			return destination.exporter
		case 'prometheus': {
			const {createPrometheusSink} = await import('../sinks/prometheus')
			return createPrometheusSink({
				provider: 'prometheus',
				...(destination.maxBufferSize !== undefined ? {maxBufferSize: destination.maxBufferSize} : {}),
				...(destination.maxBufferLines !== undefined ? {maxBufferLines: destination.maxBufferLines} : {}),
				...(logger ? {logger} : {})
			})
		}
		case 'otlp': {
			const {createOtlpExporter} = await import('../features/exporters/otlp-exporter')
			return createOtlpExporter({
				endpoint: destination.endpoint,
				...(destination.headers ? {headers: {...destination.headers}} : {}),
				...(destination.timeout !== undefined ? {timeout: destination.timeout} : {}),
				...(destination.enableGzip !== undefined ? {enableGzip: destination.enableGzip} : {}),
				...(destination.gzipThresholdBytes !== undefined
					? {gzipThresholdBytes: destination.gzipThresholdBytes} : {}),
				onError,
				...(logger ? {logger} : {})
			})
		}
	}
}

export async function createCustomMetrics(
	options: CustomMetricsOptions
): Promise<ManagedMetrics | PrometheusManagedMetrics> {
	if (!options || typeof options !== 'object') {
		throw new ConfigValidationError('Custom metrics options must be an object')
	}
	const stable = snapshotPresetOptions(options, OPTION_FIELDS, 'Custom metrics options') as unknown as CustomMetricsOptions
	try { assertMetricsClock(stable.clock, 'Custom metrics clock') } catch {
		throw new ConfigValidationError('Custom metrics requires a clock')
	}
	const destinations = snapshotDestinations(stable.destinations)
	const limits = stable.limits === undefined
		? LABEL_LIMITS_PRODUCTION
		: snapshotPresetOptions(
			stable.limits,
			new Set(['maxLabels', 'maxCardinality', 'maxLabelValueLength']),
			'Custom metrics limits'
		) as unknown as LabelLimits
	validateLabelLimits(limits)
	if (stable.exemplars !== undefined && typeof stable.exemplars !== 'boolean') {
		throw new ConfigValidationError('Custom metrics exemplars must be a boolean')
	}
	if (stable.selfMetrics !== undefined && typeof stable.selfMetrics !== 'boolean') {
		throw new ConfigValidationError('Custom metrics selfMetrics must be a boolean')
	}
	if (stable.temporality !== undefined
		&& stable.temporality !== 'cumulative' && stable.temporality !== 'delta') {
		throw new ConfigValidationError('Custom metrics temporality must be cumulative or delta')
	}
	const delivery = stable.delivery === undefined
		? {}
		: snapshotPresetOptions(
			stable.delivery,
			new Set(['flushIntervalMs', 'operationTimeoutMs', 'retry', 'circuitBreaker']),
			'Custom metrics delivery'
		) as unknown as NonNullable<CustomMetricsOptions['delivery']>
	const flushIntervalMs = delivery.flushIntervalMs ?? DEFAULT_BUFFER_FLUSH_INTERVAL_MS
	const operationTimeoutMs = delivery.operationTimeoutMs ?? 5_000
	validateInterval(flushIntervalMs, 'Metrics flush interval')
	validateInterval(operationTimeoutMs, 'Metrics operation timeout')
	const retry = delivery.retry === undefined ? {
		maxRetries: EXPORTER_RETRY_MAX_RETRIES,
		baseDelayMs: EXPORTER_RETRY_BASE_DELAY_MS,
		maxDelayMs: EXPORTER_RETRY_MAX_DELAY_MS,
		multiplier: EXPORTER_RETRY_MULTIPLIER,
		jitter: true
	} : snapshotPresetOptions(
		delivery.retry,
		new Set(['maxRetries', 'baseDelayMs', 'maxDelayMs', 'multiplier', 'jitter']),
		'Custom metrics retry'
	) as unknown as NonNullable<NonNullable<CustomMetricsOptions['delivery']>['retry']>
	validateRetryConfig(retry)
	const circuitBreaker = delivery.circuitBreaker === false || delivery.circuitBreaker === undefined
		? delivery.circuitBreaker
		: snapshotPresetOptions(
			delivery.circuitBreaker,
			new Set(['failureThreshold', 'openMs']),
			'Custom metrics circuit breaker'
		) as unknown as Exclude<NonNullable<CustomMetricsOptions['delivery']>['circuitBreaker'], false | undefined>
	const onError = createMetricsOnError(stable.errors, {stage: 'metrics', preset: 'custom'})
	const exporters = await Promise.all(destinations.map((destination) =>
		resolveDestination(destination, stable.logger, onError)))
	const scrape = exporters
		.map((exporter) => capturePrometheusScrapeCapability(exporter))
		.find((capability) => capability !== undefined)
	const handler = createLeanMetricsHandler({
		exporters,
		labelLimits: limits,
		resourceLabels: observabilityResourceToMetricLabels(stable.resource),
		flushIntervalMs,
		selfMetrics: stable.selfMetrics ?? true,
		exemplars: stable.exemplars ?? false,
		defaultTemporality: stable.temporality ?? 'cumulative',
		clock: stable.clock,
		instruments: snapshotInstrumentDefinitions(stable.instruments),
		...(stable.staleAfterMs !== undefined ? {staleAfterMs: stable.staleAfterMs} : {}),
		exporterRetry: retry,
		exporterCircuitBreaker: circuitBreaker ?? {failureThreshold: 5, openMs: 30_000},
		exporterOperationTimeoutMs: operationTimeoutMs,
		flushTimeoutMs: operationTimeoutMs,
		...(stable.errors ? {errors: stable.errors} : {}),
		...(stable.logger ? {logger: stable.logger} : {})
	})
	const lifecycleHandler = await wireMetricsLifecycle(handler, stable.lifecycle, {
		onError,
		...(stable.logger ? {logger: stable.logger} : {})
	})
	return scrape
		? createPrometheusManagedMetricsFacade(lifecycleHandler, scrape)
		: createManagedMetricsFacade(lifecycleHandler)
}
