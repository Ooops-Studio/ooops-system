/**
 * @file Lean metrics handler for fixed presets.
 * Keeps preset bundles free of policy and custom aggregation infrastructure.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MonotonicMillisClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'

import {
	DEFAULT_BUFFER_FLUSH_INTERVAL_MS,
	DEFAULT_FLUSH_TIMEOUT_MS,
	HISTOGRAM_BUCKETS_DEFAULT,
	METRIC_SELF_DROPPED_TOTAL,
	METRIC_SELF_EXPORT_FAILURES_TOTAL,
	METRIC_SELF_EXPORT_RETRIES_TOTAL,
	METRIC_SELF_QUEUE_SIZE,
	METRIC_SELF_FINALIZATION_FAILURES_TOTAL,
	METRIC_SELF_ACTIVE_SERIES
} from '../constants'
import type {MetricInstrumentDefinition as PublicMetricInstrumentDefinition} from '../public/types'
import type {MetricExporterPort} from '../types/exporter'
import type {MetricsStatusSnapshot} from '../types/instruments'
import type {MetricRecord} from '../types/metric-record'
import type {MetricsHandlerPort} from '../types/ports'
import {
	validateHistogramBuckets,
	validateInterval,
	validateLabelLimits,
	validateRetryConfig
} from '../utils/config-validation'
import {createCardinalityTracker, type LabelLimits} from '../utils/label-sanitizer'
import {getLogger, isSafeLogger} from '../utils/logger'
import {createMetricsOnError} from '../utils/on-error'

import {MetricAggregator} from './aggregator'
import {ExporterManager, type ExporterCircuitBreakerConfig} from './exporter-manager'
import {createManagedWriteOperations} from './managed-write-operations'
import {MetricRecorder} from './recorder'

export interface LeanMetricsHandlerOptions {
	readonly exporters: ReadonlyArray<MetricExporterPort>
	readonly labelLimits: LabelLimits
	readonly resourceLabels?: Record<string, string>
	readonly flushIntervalMs?: number
	readonly selfMetrics?: boolean
	readonly exemplars?: boolean
	readonly defaultTemporality?: 'cumulative' | 'delta'
	readonly clock: Clock
	readonly monotonicClock?: MonotonicMillisClock
	readonly staleAfterMs?: number
	readonly instruments?: readonly PublicMetricInstrumentDefinition[]
	readonly exporterCircuitBreaker?: ExporterCircuitBreakerConfig | false
	readonly exporterRetry?: {
		readonly maxRetries: number
		readonly baseDelayMs: number
		readonly maxDelayMs: number
		readonly multiplier: number
		readonly jitter?: boolean
	}
	readonly exporterOperationTimeoutMs?: number
	readonly flushTimeoutMs?: number
	readonly errors?: Errors
	readonly logger?: Logging
}

export function createLeanMetricsHandler(options: LeanMetricsHandlerOptions): MetricsHandlerPort {
	if (!options || typeof options !== 'object') throw new Error('Lean options must be an object')
	const {
		exporters,
		labelLimits,
		resourceLabels = {},
		flushIntervalMs = DEFAULT_BUFFER_FLUSH_INTERVAL_MS,
		selfMetrics = true,
		exemplars = false,
		defaultTemporality = 'cumulative',
		clock,
		monotonicClock,
		staleAfterMs,
		instruments = [],
		exporterCircuitBreaker,
		exporterRetry,
		exporterOperationTimeoutMs,
		flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
		errors,
		logger
	} = options
	if (typeof selfMetrics !== 'boolean') throw new Error('selfMetrics must be a boolean')
	if (typeof exemplars !== 'boolean') throw new Error('exemplars must be a boolean')
	if (defaultTemporality !== 'cumulative' && defaultTemporality !== 'delta') {
		throw new Error('defaultTemporality must be cumulative or delta')
	}
	validateLabelLimits(labelLimits)
	validateInterval(flushIntervalMs, 'Metrics flushIntervalMs')
	validateInterval(flushTimeoutMs, 'Flush timeout')
	if (exporterOperationTimeoutMs !== undefined)
		validateInterval(exporterOperationTimeoutMs, 'Exporter operation timeout')
	validateHistogramBuckets(HISTOGRAM_BUCKETS_DEFAULT)
	if (staleAfterMs !== undefined) validateInterval(staleAfterMs, 'staleAfterMs')
	if (exporterRetry) validateRetryConfig(exporterRetry)

	const onError = createMetricsOnError(errors, {stage: 'metrics', preset: 'lean'})
	const safeLogger = isSafeLogger(logger) ? getLogger(logger) : getLogger(undefined)
	const cardinalityTracker = createCardinalityTracker({clock})
	const aggregator = new MetricAggregator({
		clock,
		histogramBuckets: HISTOGRAM_BUCKETS_DEFAULT,
		defaultTemporality,
		...(staleAfterMs !== undefined ? {staleAfterMs} : {}),
		onStaleEvict: (name, labels) => { cardinalityTracker.release(name, labels) },
		...(errors ? {errors} : {})
	})
	let droppedTotal = 0
	let retriedTotal = 0
	let retryInProgress = false
	let lastFailureCode: string | undefined
	let writeVersion = 0
	let pendingSnapshot: ReadonlyArray<MetricRecord> | undefined
	let pendingSnapshotWriteVersion = 0
	let selfRecorder: MetricRecorder | undefined
	const recorder = new MetricRecorder({
		aggregator,
		clock,
		labelLimits,
		exemplars,
		resourceLabels,
		defaultTemporality,
		cardinalityTracker,
		...(selfMetrics ? {
			onLabelDrop: (reason: string) => {
				droppedTotal += 1
				selfRecorder?.counter?.(METRIC_SELF_DROPPED_TOTAL, 1, {reason})
			},
			onCardinalityDrop: (_metricName: string, reason: string) => {
				droppedTotal += 1
				selfRecorder?.counter?.(METRIC_SELF_DROPPED_TOTAL, 1, {reason})
			}
		} : {}),
		...(errors ? {errors} : {})
	})
	selfRecorder = selfMetrics
		? new MetricRecorder({
			aggregator,
			clock,
			labelLimits,
			exemplars: false,
			resourceLabels,
			defaultTemporality,
			cardinalityTracker,
			...(errors ? {errors} : {})
		})
		: undefined
	const recordSelfMetric = (record: (target: MetricRecorder) => void): void => {
		if (!selfRecorder) return
		try {
			record(selfRecorder)
		} catch(error) {
			onError(error, {stage: 'self-metrics'})
		}
	}
	if (!Array.isArray(instruments)) throw new Error('Instruments must be an array')
	if (instruments.length > 1_000) throw new Error('At most 1000 instrument definitions are allowed')
	for (const definition of instruments) {
		if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
			throw new Error('Instrument definition must be an object')
		}
		if (definition.instrument === 'timer') {
			recorder.register({
				name: definition.name,
				instrument: 'timer',
				unit: 'ms',
				...(definition.description ? {description: definition.description} : {}),
				...(definition.temporality ? {temporality: definition.temporality} : {}),
				...(definition.histogramBuckets ? {histogramBuckets: definition.histogramBuckets} : {})
			}, definition.labels)
			continue
		}
		recorder.register({
			name: definition.name,
			instrument: definition.instrument,
			...(definition.description ? {description: definition.description} : {}),
			...(definition.unit ? {unit: definition.unit} : {}),
			...(definition.temporality ? {temporality: definition.temporality} : {}),
			...(definition.histogramBuckets ? {histogramBuckets: definition.histogramBuckets} : {})
		}, definition.labels)
	}
	const exporterManager = new ExporterManager({
		exporters,
		clock,
		operationTimeoutMs: exporterOperationTimeoutMs ?? flushTimeoutMs,
		...(monotonicClock ? {monotonicClock} : {}),
		...(exporterCircuitBreaker !== undefined ? {circuitBreaker: exporterCircuitBreaker} : {}),
		...(exporterRetry ? {retryConfig: exporterRetry} : {}),
		...(errors ? {errors} : {}),
		logger: safeLogger,
		onExportFailure: (provider: string, error: unknown) => {
			lastFailureCode = 'METRICS_EXPORT_FAILURE'
			recordSelfMetric((target) => target.counter(METRIC_SELF_EXPORT_FAILURES_TOTAL, 1, {provider}))
			const code = error && typeof error === 'object'
				? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
			if (code === 'export_queue_overflow') {
				droppedTotal += 1
				recordSelfMetric((target) => target.counter(METRIC_SELF_DROPPED_TOTAL, 1, {reason: 'backpressure'}))
			}
		},
		onRetry: () => {
			retriedTotal += 1
			retryInProgress = true
			recordSelfMetric((target) => target.counter(METRIC_SELF_EXPORT_RETRIES_TOTAL, 1))
		}
	})
	let state: 'running' | 'draining' | 'closed' = 'running'
	let writesLocked = false
	let terminalSnapshotDelivered = false
	let flushTimer: ReturnType<typeof setInterval> | undefined
	let flushPromise: Promise<void> | undefined
	let shutdownPromise: Promise<void> | undefined
	const awaitWithTimeout = async(work: Promise<void>, operation: 'flush' | 'shutdown'): Promise<void> => {
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(
				() => {
					lastFailureCode = 'METRICS_FINALIZATION_FAILURE'
					reject(new Error(`Metrics ${operation} timed out after ${flushTimeoutMs}ms`))
				},
				flushTimeoutMs
			)
			// This timeout is part of an awaited operation and must keep Node alive.
		})
		try {
			return await Promise.race([work, timeout])
		} finally {
			if (timeoutId) clearTimeout(timeoutId)
		}
	}

	const acceptsWrites = (): boolean =>
		!writesLocked && state === 'running'
	const exportSnapshot = async(): Promise<void> => {
		if (pendingSnapshot) {
			const retrySnapshot = pendingSnapshot
			const retryVersion = pendingSnapshotWriteVersion
			await exporterManager.export(retrySnapshot)
			aggregator.commitDeltaSnapshot(retrySnapshot)
			pendingSnapshot = undefined
			retryInProgress = false
			lastFailureCode = undefined
			if (retryVersion === writeVersion) return
		}
		const evicted = aggregator.evictStale()
		if (evicted > 0) {
			droppedTotal += evicted
			recordSelfMetric((target) => target.counter(METRIC_SELF_DROPPED_TOTAL, evicted, {reason: 'stale_eviction'}))
		}
		recordSelfMetric((target) => target.gauge(METRIC_SELF_QUEUE_SIZE, exporterManager.getTelemetry().queueSize))
		recordSelfMetric((target) => target.gauge(METRIC_SELF_ACTIVE_SERIES, aggregator.getDiagnostics().activeSeries))
		const records = aggregator.snapshot({resetDelta: false, evictStale: false})
		if (records.length === 0) return
		pendingSnapshot = records
		pendingSnapshotWriteVersion = writeVersion
		await exporterManager.export(records)
		aggregator.commitDeltaSnapshot(records)
		pendingSnapshot = undefined
		retryInProgress = false
		lastFailureCode = undefined
	}
	const getStatus = (): MetricsStatusSnapshot => {
		const diagnostics = aggregator.getDiagnostics()
		const delivery = exporterManager.getTelemetry()
		const sinkState = state === 'closed'
			? 'closed'
			: retryInProgress && delivery.sinkState !== 'unhealthy'
				? 'degraded'
				: delivery.sinkState
		return Object.freeze({
			state,
			queueSize: delivery.queueSize,
			activeSeries: diagnostics.activeSeries,
			droppedTotal,
			retriedTotal,
			sinkState,
			...(lastFailureCode || delivery.lastFailureCode
				? {lastFailureCode: lastFailureCode ?? delivery.lastFailureCode} : {})
		})
	}
	const clearTimer = (): void => {
		if (flushTimer) clearInterval(flushTimer)
		flushTimer = undefined
	}
	const flush = async(): Promise<void> => {
		if (shutdownPromise) return awaitWithTimeout(shutdownPromise, 'shutdown')
		if (flushPromise) return awaitWithTimeout(flushPromise, 'flush')
		if (state === 'closed') return
		flushPromise = (async() => {
			// Let flush() publish ownership before caller-controlled clocks run.
			await 0
			try {
				await exportSnapshot()
				await exporterManager.flush()
				lastFailureCode = undefined
			} catch(error) {
				recordSelfMetric((target) => target.counter(METRIC_SELF_FINALIZATION_FAILURES_TOTAL, 1, {operation: 'flush'}))
				lastFailureCode = 'METRICS_FINALIZATION_FAILURE'
				onError(error, {stage: 'flush'})
				throw error
			} finally {
				flushPromise = undefined
			}
		})()
		return awaitWithTimeout(flushPromise, 'flush')
	}
	const shutdown = async(): Promise<void> => {
		if (shutdownPromise) return awaitWithTimeout(shutdownPromise, 'shutdown')
		if (state === 'closed') return
		writesLocked = true
		clearTimer()
		state = 'draining'
		shutdownPromise = (async() => {
			try {
				if (flushPromise) await flushPromise
				// A caller-controlled clock or observer can synchronously re-enter
				// shutdown from inside a synchronous admitted write. Yield once so that
				// write reaches the aggregator before the terminal snapshot.
				await 0
				// A normal flush keeps admission open. Capture writes accepted after
				// that flush took its snapshot before terminal exporter shutdown.
				if (!terminalSnapshotDelivered) {
					await exportSnapshot()
					// Once admission is locked, a successful terminal snapshot covers all
					// accepted writes. Preserve that checkpoint if later exporter shutdown
					// fails so a retry can reach finalization through a failed manager.
					terminalSnapshotDelivered = true
				}
				await exporterManager.shutdown()
				pendingSnapshot = undefined
				aggregator.clear()
				cardinalityTracker.reset()
				recorder.clear()
				selfRecorder?.clear()
				selfRecorder = undefined
				state = 'closed'
			} catch(error) {
				state = 'draining'
				lastFailureCode = 'METRICS_FINALIZATION_FAILURE'
				recordSelfMetric((target) => target.counter(METRIC_SELF_FINALIZATION_FAILURES_TOTAL, 1, {operation: 'shutdown'}))
				onError(error, {stage: 'shutdown'})
				throw error
			} finally {
				shutdownPromise = undefined
			}
		})()
		return awaitWithTimeout(shutdownPromise, 'shutdown')
	}
	const handler: MetricsHandlerPort = {
		...createManagedWriteOperations({
			recorder,
			selfRecorder,
			acceptsWrites,
			onAccepted: () => { writeVersion += 1 }
		}),
		flush,
		shutdown,
		getStatus
	}
	flushTimer = setInterval(() => {
		void flush().catch((error) => onError(error, {stage: 'flush-interval'}))
	}, flushIntervalMs)
	flushTimer.unref?.()
	return handler
}
