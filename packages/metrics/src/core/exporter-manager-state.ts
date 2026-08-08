/**
 * @file Exporter manager implementation.
 * Orchestrates multiple exporters with retry and health tracking.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import {
	createMonotonicClock,
	type MonotonicMillisClock
} from '@ooopsstudio/core/runtime/time/monotonic-clock'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {snapshotDenseDataArray, snapshotPlainDataRecord} from '@ooopsstudio/core/utils/validation'

import {
	DEFAULT_EXPORTER_QUEUE_MAX_BATCHES,
	DEFAULT_EXPORTER_QUEUE_MAX_BYTES,
	DEFAULT_FLUSH_TIMEOUT_MS,
	EXPORTER_HARD_MAX_CONCURRENCY,
	EXPORTER_HARD_MAX_QUEUED_BATCHES,
	EXPORTER_HARD_MAX_QUEUED_BYTES,
	EXPORTER_MAX_BATCH_BYTES,
	EXPORTER_MAX_BATCH_SIZE,
	EXPORTER_MAX_CONCURRENCY,
	MAX_METRICS_TIMER_MS,
	METRICS_MAX_EXPORT_SNAPSHOT_BYTES,
	METRICS_MAX_EXPORT_RECORDS,
	METRICS_MAX_EXPORTERS
} from '../constants'
import type {MetricExporterPort} from '../types/exporter'
import {readMetricsClock, snapshotMetricsClock, validateMetricsTimestamp} from '../utils/clock'
import {validateRetryConfig} from '../utils/config-validation'
import {getLogger, isSafeLogger} from '../utils/logger'
import {createMetricsOnError} from '../utils/on-error'

import {snapshotMetricExporter} from './exporter-manager-utils'

export interface RetryConfig {
	readonly maxRetries: number
	readonly baseDelayMs: number
	readonly maxDelayMs: number
	readonly multiplier: number
	readonly jitter?: boolean
}

export interface ExporterCircuitBreakerConfig {
	readonly failureThreshold: number
	readonly openMs: number
}

export interface ExporterManagerOptions {
	readonly exporters: ReadonlyArray<MetricExporterPort>
	readonly retryConfig?: RetryConfig
	readonly onExportFailure?: (exporter: string, error: unknown) => void
	readonly onRetry?: (exporter: string) => void
	readonly maxBatchSize?: number
	readonly maxBatchBytes?: number
	readonly maxConcurrency?: number
	readonly circuitBreaker?: ExporterCircuitBreakerConfig | false
	readonly maxQueuedBatches?: number
	readonly maxQueuedBytes?: number
	readonly clock?: Clock
	readonly monotonicClock?: MonotonicMillisClock
	readonly operationTimeoutMs?: number
	readonly errors?: Errors
	readonly logger?: Logging
}

export interface ExporterDeliveryState {
	circuitState: 'closed' | 'open' | 'half_open'
	consecutiveFailures: number
	lastFailureCode?: string | undefined
	openUntil?: number | undefined
	throttledUntil?: number | undefined
	openUntilMonotonic?: number | undefined
	throttledUntilMonotonic?: number | undefined
	halfOpenProbeInFlight?: boolean | undefined
}

export type ExportAttemptResult = {readonly status: 'delivered'}
export type ExporterRuntimeState = 'running' | 'draining' | 'closed'

export interface MetricsExportError extends Error {
	statusCode?: number
	retryable?: boolean
	code?: string
	retryAfterMs?: number
}

export interface QueuedExportOperation {
	readonly bytes: number
	readonly records: number
	readonly run: () => Promise<void>
}
export class ExporterManagerState {

	protected readonly exporters: ReadonlyArray<MetricExporterPort>
	protected readonly retryConfig: RetryConfig | undefined
	protected readonly onExportFailure: ((exporter: string, error: unknown) => void) | undefined
	protected readonly onRetry: ((exporter: string) => void) | undefined
	protected readonly maxBatchSize: number
	protected readonly maxBatchBytes: number
	protected readonly maxConcurrency: number
	protected readonly maxQueuedBatches: number
	protected readonly maxQueuedBytes: number
	protected readonly concurrencyQueues = new Map<MetricExporterPort, QueuedExportOperation[]>()
	protected readonly activeCounts = new Map<MetricExporterPort, number>()
	protected queuedOperationCount = 0
	protected queuedOperationBytes = 0
	protected queuedRecordCount = 0
	protected readonly exporterState = new Map<MetricExporterPort, ExporterDeliveryState>()
	protected readonly shutdownCompleted = new Set<MetricExporterPort>()
	protected readonly activeOperations = new Set<Promise<void>>()
	protected readonly circuitBreaker: ExporterCircuitBreakerConfig | false
	protected readonly clock: Clock
	protected readonly monotonicClock: MonotonicMillisClock
	protected readonly operationTimeoutMs: number
	protected runtimeState: ExporterRuntimeState = 'running'
	protected flushPromise: Promise<void> | undefined
	protected shutdownPromise: Promise<void> | undefined
	protected shutdownGeneration = 0
	protected readonly onError: (err: unknown, extra?: Record<string, string>) => void
	protected readonly logger: Logging

	constructor(options: ExporterManagerOptions) {
		if (!options || typeof options !== 'object') {
			throw new Error('Metrics exporter manager options must be an object')
		}
		const stableOptions = snapshotPlainDataRecord(options, new Set([
			'exporters', 'retryConfig', 'onExportFailure', 'onRetry', 'maxBatchSize', 'maxBatchBytes',
			'maxConcurrency', 'maxQueuedBatches', 'maxQueuedBytes', 'circuitBreaker', 'clock',
			'monotonicClock', 'operationTimeoutMs', 'errors', 'logger'
		]), ['exporters'])
		if (!stableOptions) throw new Error('Metrics exporter manager options must expose stable known data fields')
		const {
			exporters,
			retryConfig,
			onExportFailure,
			onRetry,
			maxBatchSize = EXPORTER_MAX_BATCH_SIZE,
			maxBatchBytes = EXPORTER_MAX_BATCH_BYTES,
			maxConcurrency = EXPORTER_MAX_CONCURRENCY,
			maxQueuedBatches = DEFAULT_EXPORTER_QUEUE_MAX_BATCHES,
			maxQueuedBytes = DEFAULT_EXPORTER_QUEUE_MAX_BYTES,
			circuitBreaker = {failureThreshold: 5, openMs: 30000},
			clock,
			monotonicClock,
			operationTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
			errors,
			logger
		} = stableOptions as unknown as ExporterManagerOptions
		if (!Array.isArray(exporters)) throw new Error('Metrics exporters must be an array')
		const exporterInputs = snapshotDenseDataArray(exporters, METRICS_MAX_EXPORTERS)
		if (!exporterInputs) throw new Error(`Metrics exporters must be a dense array with at most ${METRICS_MAX_EXPORTERS} entries`)
		const stableExporters = exporterInputs.map((exporter) => snapshotMetricExporter(exporter as MetricExporterPort))
		const stableRetryConfig = retryConfig === undefined ? undefined : snapshotPlainDataRecord(
			retryConfig, new Set(['maxRetries', 'baseDelayMs', 'maxDelayMs', 'multiplier', 'jitter']),
			['maxRetries', 'baseDelayMs', 'maxDelayMs', 'multiplier']
		) as unknown as RetryConfig | undefined
		if (retryConfig !== undefined && !stableRetryConfig) throw new Error('Metrics exporter retryConfig must expose stable known data fields')
		if (stableRetryConfig !== undefined) validateRetryConfig(stableRetryConfig)
		if (onExportFailure !== undefined && typeof onExportFailure !== 'function') {
			throw new Error('Metrics exporter onExportFailure must be a function')
		}
		if (onRetry !== undefined && typeof onRetry !== 'function') {
			throw new Error('Metrics exporter onRetry must be a function')
		}
		if (circuitBreaker !== false && (!circuitBreaker || typeof circuitBreaker !== 'object')) {
			throw new Error('Metrics exporter circuitBreaker must be an object')
		}
		const stableCircuitBreaker = circuitBreaker === false ? false : snapshotPlainDataRecord(
			circuitBreaker, new Set(['failureThreshold', 'openMs']), ['failureThreshold', 'openMs']
		) as unknown as ExporterCircuitBreakerConfig | undefined
		if (stableCircuitBreaker !== false && !stableCircuitBreaker) throw new Error('Metrics exporter circuitBreaker must expose stable data fields')
		const stableClock = snapshotMetricsClock(clock ?? createSystemClock(), 'Metrics exporter clock')
		const stableMonotonicClock = snapshotMetricsClock(
			monotonicClock ?? createMonotonicClock(), 'Metrics exporter monotonic clock'
		)
		if (new Set(exporterInputs).size !== exporterInputs.length) {
			throw new Error('Metrics exporter instances must be unique')
		}

		const assertBoundedPositiveInteger = (value: number, name: string, maximum: number): void => {
			if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
				throw new Error(`${name} must be an integer between 1 and ${maximum}`)
			}
		}
		assertBoundedPositiveInteger(maxBatchSize, 'maxBatchSize', METRICS_MAX_EXPORT_RECORDS)
		assertBoundedPositiveInteger(maxBatchBytes, 'maxBatchBytes', METRICS_MAX_EXPORT_SNAPSHOT_BYTES)
		assertBoundedPositiveInteger(maxConcurrency, 'maxConcurrency', EXPORTER_HARD_MAX_CONCURRENCY)
		assertBoundedPositiveInteger(maxQueuedBatches, 'maxQueuedBatches', EXPORTER_HARD_MAX_QUEUED_BATCHES)
		assertBoundedPositiveInteger(maxQueuedBytes, 'maxQueuedBytes', EXPORTER_HARD_MAX_QUEUED_BYTES)
		if (!Number.isSafeInteger(operationTimeoutMs)
			|| operationTimeoutMs <= 0
			|| operationTimeoutMs > MAX_METRICS_TIMER_MS) {
			throw new Error(`operationTimeoutMs must be positive and finite, got ${operationTimeoutMs}`)
		}
		if (stableCircuitBreaker !== false
			&& (!Number.isSafeInteger(stableCircuitBreaker.failureThreshold)
				|| stableCircuitBreaker.failureThreshold <= 0)) {
			throw new Error(`circuitBreaker.failureThreshold must be a positive integer, got ${stableCircuitBreaker.failureThreshold}`)
		}
		if (stableCircuitBreaker !== false && (!Number.isSafeInteger(stableCircuitBreaker.openMs)
			|| stableCircuitBreaker.openMs <= 0
			|| stableCircuitBreaker.openMs > MAX_METRICS_TIMER_MS)) {
			throw new Error(`circuitBreaker.openMs must be positive and finite, got ${stableCircuitBreaker.openMs}`)
		}
		this.exporters = stableExporters
		this.retryConfig = stableRetryConfig ? {...stableRetryConfig} : undefined
		this.onExportFailure = onExportFailure
		this.onRetry = onRetry
		this.maxBatchSize = maxBatchSize
		this.maxBatchBytes = maxBatchBytes
		this.maxConcurrency = maxConcurrency
		this.maxQueuedBatches = maxQueuedBatches
		this.maxQueuedBytes = maxQueuedBytes
		this.clock = stableClock
		this.monotonicClock = stableMonotonicClock
		this.operationTimeoutMs = operationTimeoutMs
		this.circuitBreaker = stableCircuitBreaker === false ? false : {...stableCircuitBreaker}
		this.onError = createMetricsOnError(errors, {stage: 'exporter-manager'})
		this.logger = isSafeLogger(logger) ? getLogger(logger) : getLogger(undefined)
		for (const exporter of stableExporters) {
			this.concurrencyQueues.set(exporter, [])
			this.activeCounts.set(exporter, 0)
			this.exporterState.set(exporter, {
				circuitState: 'closed',
				consecutiveFailures: 0
			})
		}
	}

	protected now(): number {
		return readMetricsClock(this.clock, 'Metrics exporter clock')
	}

	protected monotonicNow(): number {
		return validateMetricsTimestamp(this.monotonicClock.now(), 'Metrics exporter monotonic clock')
	}

	protected releaseExporterReferences(): void {
		const exporters = this.exporters as MetricExporterPort[]
		exporters.length = 0
		this.concurrencyQueues.clear()
		this.activeCounts.clear()
		this.exporterState.clear()
		this.shutdownCompleted.clear()
	}

	protected trackOperation<T>(promise: Promise<T>): Promise<T> {
		const tracked = promise.finally(() => {
			this.activeOperations.delete(tracked as Promise<void>)
		})
		this.activeOperations.add(tracked as Promise<void>)
		return tracked
	}

}
