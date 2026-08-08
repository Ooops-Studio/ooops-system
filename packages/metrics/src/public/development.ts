/**
 * @file Development preset for metrics service.
 * Full verbosity with console and Prometheus exporters.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {
	BUFFER_FLUSH_INTERVAL_DEVELOPMENT,
	LABEL_LIMITS_DEVELOPMENT
} from '../constants'
import {createLeanMetricsHandler} from '../core/lean-handler'
import {wireMetricsLifecycle} from '../core/lifecycle'
import {
	createPrometheusManagedMetricsFacade
} from '../core/managed-facade'
import {createConsoleExporter} from '../features/exporters/console-exporter'
import {createPrometheusSink} from '../sinks/prometheus'
import {
	validateInterval,
	validateLabelLimits
} from '../utils/config-validation'
import {createMetricsOnError} from '../utils/on-error'
import {capturePrometheusScrapeCapability} from '../utils/prometheus-scrape-capability'

import {snapshotInstrumentDefinitions} from './instruments'
import {observabilityResourceToMetricLabels} from './observability'
import {snapshotPresetOptions} from './preset-options'
import type {MetricInstrumentDefinition, PrometheusManagedMetrics} from './types'

const DEVELOPMENT_OPTION_FIELDS = new Set([
	'lifecycle', 'resource', 'errors', 'logger', 'clock', 'console', 'instruments',
	'flushTimeoutMs', 'exporterOperationTimeoutMs'
])

/**
 * Options for development metrics preset
 */
export interface DevelopmentMetricsOptions {
	readonly lifecycle?: LifecyclePort
	readonly resource?: ObservabilityResource
	readonly errors?: Errors
	readonly logger?: Logging
	readonly clock?: Clock
	readonly console?: boolean
	readonly instruments?: readonly MetricInstrumentDefinition[]
	readonly flushTimeoutMs?: number
	readonly exporterOperationTimeoutMs?: number
}

export type DevelopmentMetricsHandlerPort = PrometheusManagedMetrics

/**
 * Create development metrics handler
 * Full verbosity with console and Prometheus exporters
 */
export async function createDevelopmentMetrics(
	options: DevelopmentMetricsOptions = {}
): Promise<DevelopmentMetricsHandlerPort> {
	if (!options || typeof options !== 'object') throw new Error('Development metrics options must be an object')
	const stable = snapshotPresetOptions(options, DEVELOPMENT_OPTION_FIELDS, 'Development metrics options') as unknown as DevelopmentMetricsOptions
	const {
		lifecycle,
		resource,
		errors,
		logger,
		clock = createSystemClock(),
		console: consoleEnabled = true,
		instruments,
		flushTimeoutMs,
		exporterOperationTimeoutMs
	} = stable
	if (typeof consoleEnabled !== 'boolean') throw new Error('Development metrics console must be a boolean')
	const onError = createMetricsOnError(errors, {stage: 'metrics', preset: 'development'})

	// Validate configuration before creating side-effectful runtime resources.
	validateLabelLimits(LABEL_LIMITS_DEVELOPMENT)
	validateInterval(BUFFER_FLUSH_INTERVAL_DEVELOPMENT, 'Buffer flushIntervalMs')

	// Create exporters
	const prometheusExporter = createPrometheusSink({
		provider: 'prometheus',
		...(logger ? {logger} : {})
	})
	const scrape = capturePrometheusScrapeCapability(prometheusExporter)
	if (!scrape) throw new Error('Development Prometheus sink does not expose a stable scrape capability')
	// Create handler
	const handler = createLeanMetricsHandler({
		exporters: [
			...(consoleEnabled ? [createConsoleExporter({color: true})] : []),
			prometheusExporter
		],
		labelLimits: LABEL_LIMITS_DEVELOPMENT,
		exemplars: true,
		resourceLabels: observabilityResourceToMetricLabels(resource),
		flushIntervalMs: BUFFER_FLUSH_INTERVAL_DEVELOPMENT,
		selfMetrics: true,
		clock,
		instruments: snapshotInstrumentDefinitions(instruments),
		...(errors ? {errors} : {}),
		...(logger ? {logger} : {}),
		...(flushTimeoutMs !== undefined ? {flushTimeoutMs} : {}),
		...(exporterOperationTimeoutMs !== undefined ? {exporterOperationTimeoutMs} : {})
	})

	const lifecycleHandler = await wireMetricsLifecycle(handler, lifecycle, {onError, ...(logger ? {logger} : {})})
	return createPrometheusManagedMetricsFacade(lifecycleHandler, scrape)
}
