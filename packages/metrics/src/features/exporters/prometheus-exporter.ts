/**
 * @file Prometheus exporter implementation.
 * Formats metrics in Prometheus exposition format with optional exemplar support.
 */

import type {Logging} from '@ooopsstudio/core/ports/logging'

import {
	PROMETHEUS_HARD_MAX_BUFFER_LINES,
	PROMETHEUS_HARD_MAX_BUFFER_SIZE,
	PROMETHEUS_MAX_BUFFER_LINES,
	PROMETHEUS_MAX_BUFFER_SIZE
} from '../../constants'
import type {MetricExporterPort} from '../../types/exporter'
import type {MetricRecord} from '../../types/metric-record'
import {estimateMetricRecordSize} from '../../utils/helpers'
import {getLogger, isSafeLogger} from '../../utils/logger'
import {snapshotMetricBatch} from '../../utils/metric-record-snapshot'

import {assertCompleteHistogramGroup, getHistogramGroup, histogramBaseName, isHistogramPart, labelsWithoutBucket, prometheusGroupKey} from './prometheus-grouping'
import {preparePrometheusMetrics, type PreparedPrometheusMetrics} from './prometheus-preparation'
import {renderPrometheus} from './prometheus-renderer'
import {applyPrometheusRollingWindow} from './prometheus-rolling-window'
import {assertPrometheusBatchIdentities, childSeriesNames, isPrometheusExemplarSample, prometheusSampleKey, sanitizePrometheusRecord} from './prometheus-sample-utils'

/**
 * Options for Prometheus exporter
 */
export interface PrometheusExporterOptions {
	readonly maxBufferSize?: number // Maximum buffer size in bytes (default: 1MB)
	readonly maxBufferLines?: number // Maximum number of lines in buffer (default: 5000)
	readonly onError?: (error: unknown, context?: Record<string, string>) => void // Error callback
	readonly logger?: Logging
}

/**
 * Prometheus exporter
 * Formats metrics in Prometheus exposition format
 */
export class PrometheusExporter implements MetricExporterPort {
	private readonly samples = new Map<string, MetricRecord>()
	private readonly sampleRawMetricNames = new Map<string, string>()
	private readonly metricNameOrigins = new Map<string, string>()
	private readonly familyTypes = new Map<string, string>()
	private readonly reservedChildSeries = new Map<string, string>()
	private readonly maxBufferSize: number
	private readonly maxBufferLines: number
	private readonly onError: ((error: unknown, context?: Record<string, string>) => void) | undefined
	private readonly logger: Logging
	private preferOpenMetrics = false
	private closed = false

	constructor(options: PrometheusExporterOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new Error('Prometheus exporter options must be an object')
		}
		const descriptors = Object.getOwnPropertyDescriptors(options)
		if (Object.getPrototypeOf(options) !== Object.prototype
			|| Object.getOwnPropertySymbols(options).length > 0
			|| Object.entries(descriptors).some(([key, descriptor]) =>
				!['maxBufferSize', 'maxBufferLines', 'onError', 'logger'].includes(key)
				|| !descriptor.enumerable || !('value' in descriptor))) {
			throw new Error('Options must expose stable known data fields')
		}
		const stable = Object.fromEntries(
			Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
		) as PrometheusExporterOptions
		const {
			maxBufferSize = PROMETHEUS_MAX_BUFFER_SIZE,
			maxBufferLines = PROMETHEUS_MAX_BUFFER_LINES,
			onError,
			logger
		} = stable
		if (!Number.isSafeInteger(maxBufferSize) || maxBufferSize <= 0
			|| maxBufferSize > PROMETHEUS_HARD_MAX_BUFFER_SIZE) {
			throw new Error(`Prometheus exporter maxBufferSize must be a positive safe integer no greater than ${PROMETHEUS_HARD_MAX_BUFFER_SIZE}, got ${maxBufferSize}`)
		}
		if (!Number.isSafeInteger(maxBufferLines) || maxBufferLines <= 0
			|| maxBufferLines > PROMETHEUS_HARD_MAX_BUFFER_LINES) {
			throw new Error(`Prometheus exporter maxBufferLines must be a positive safe integer no greater than ${PROMETHEUS_HARD_MAX_BUFFER_LINES}, got ${maxBufferLines}`)
		}
		if (onError !== undefined && typeof onError !== 'function') {
			throw new Error('Prometheus exporter onError must be a function')
		}

		this.maxBufferSize = maxBufferSize
		this.maxBufferLines = maxBufferLines
		this.onError = onError
		// Get logger with fallback (never use metrics port from within metrics service)
		this.logger = isSafeLogger(logger) ? getLogger(logger) : getLogger(undefined)
	}

	async export(batch: ReadonlyArray<MetricRecord>): Promise<void> {
		const stableBatch = snapshotMetricBatch(batch)
		// Snapshotting caller-controlled proxies can synchronously re-enter
		// shutdown. Do not let that already-closed exporter be repopulated.
		if (this.closed) {
			throw Object.assign(new Error('Prometheus exporter is shut down'), {
				code: 'prometheus_exporter_closed', retryable: false
			})
		}
		if (stableBatch.length === 0) {
			return
		}

		const previousSamples = new Map(this.samples)
		const previousSampleRawMetricNames = new Map(this.sampleRawMetricNames)
		const previousMetricNameOrigins = new Map(this.metricNameOrigins)
		const previousFamilyTypes = new Map(this.familyTypes)
		const previousReservedChildSeries = new Map(this.reservedChildSeries)
		const previousPreferOpenMetrics = this.preferOpenMetrics
		try {
			const sanitizedBatch = stableBatch.map((record) => {
				return {
					rawName: record.name,
					record: sanitizePrometheusRecord(record, this.metricNameOrigins)
				}
			})
			assertPrometheusBatchIdentities(sanitizedBatch.map((item) => item.record))
			for (const {record, rawName} of sanitizedBatch) {
				this.upsertSample(record)
				this.sampleRawMetricNames.set(prometheusSampleKey(record), rawName)
				if (isPrometheusExemplarSample(record)) {
					this.preferOpenMetrics = true
				}
			}
			this.rebuildFamilyIndexes()
			this.applyRollingWindow()
		} catch(error) {
			this.samples.clear()
			for (const [key, value] of previousSamples) {
				this.samples.set(key, value)
			}
			this.sampleRawMetricNames.clear()
			for (const [key, value] of previousSampleRawMetricNames) {
				this.sampleRawMetricNames.set(key, value)
			}
			this.metricNameOrigins.clear()
			for (const [key, value] of previousMetricNameOrigins) {
				this.metricNameOrigins.set(key, value)
			}
			this.familyTypes.clear()
			for (const [key, value] of previousFamilyTypes) {
				this.familyTypes.set(key, value)
			}
			this.reservedChildSeries.clear()
			for (const [key, value] of previousReservedChildSeries) {
				this.reservedChildSeries.set(key, value)
			}
			this.preferOpenMetrics = previousPreferOpenMetrics
			if (this.onError) {
				this.reportError(error, {operation: 'export', exporter: 'prometheus'})
			}
			this.logger.error('metrics.prometheus_exporter_error', {error: 'metrics_prometheus_export_failed', operation: 'export'})
			throw error
		}
	}

	private reportError(error: unknown, context?: Record<string, string>): void {
		try {
			this.onError?.(error, context)
		} catch {
			// Diagnostics must not alter exporter state or HTTP responses.
		}
	}

	private sampleFamilyKey(record: MetricRecord): string {
		if (isHistogramPart(record)) {
			return `histogram:${prometheusGroupKey(
				histogramBaseName(record),
				labelsWithoutBucket(record.labels)
			)}`
		}
		return `sample:${prometheusSampleKey(record)}`
	}

	private upsertSample(record: MetricRecord): void {
		const key = prometheusSampleKey(record)
		const existing = this.samples.get(key)
		const instrument = record.metadata?.instrument
		const isCompositeSum = (
			instrument === 'histogram' ||
			instrument === 'timer'
		) && record.name.endsWith('_sum')
		if (
			existing &&
			record.metadata?.temporality === 'delta' &&
			(record.type === 'counter' || isCompositeSum)
		) {
			const value = existing.value + record.value
			if (!Number.isFinite(value))
				throw new Error(`Prometheus delta aggregate overflow for metric "${record.name}"`)
			record = {...record, value}
		}
		if (this.samples.has(key)) {
			this.samples.delete(key)
		}
		this.samples.set(key, record)
	}

	private preparePrometheusMetrics(batch: ReadonlyArray<MetricRecord>): PreparedPrometheusMetrics {
		return preparePrometheusMetrics(batch, {
			isHistogramPart, histogramBaseName, getHistogramGroup,
			assertCompleteHistogramGroup,
			createFamilyIndexes: () => ({
				familyTypes: new Map(this.familyTypes),
				reservedChildSeries: new Map(this.reservedChildSeries)
			})
		})
	}

	private applyRollingWindow(): void {
		applyPrometheusRollingWindow({
			samples: this.samples, maxBytes: this.maxBufferSize, maxLines: this.maxBufferLines,
			render: (records) => this.renderRecords(
				records,
				this.preferOpenMetrics ? 'openmetrics' : 'prometheus'
			),
			familyKey: (record) => this.sampleFamilyKey(record),
			sampleBytes: estimateMetricRecordSize,
			rebuildIndexes: () => this.rebuildFamilyIndexes()
		})
	}

	private rebuildFamilyIndexes(): void {
		this.familyTypes.clear()
		this.reservedChildSeries.clear()
		this.metricNameOrigins.clear()
		for (const [key, record] of this.samples.entries()) {
			const rawName = this.sampleRawMetricNames.get(key) ?? record.name
			this.sampleRawMetricNames.set(key, rawName)
			this.metricNameOrigins.set(record.name, rawName)
		}
		for (const key of [...this.sampleRawMetricNames.keys()]) {
			if (!this.samples.has(key)) {
				this.sampleRawMetricNames.delete(key)
			}
		}
		const {families} = this.preparePrometheusMetrics([...this.samples.values()])
		for (const family of families) {
			this.familyTypes.set(family.name, family.type)
			for (const childName of childSeriesNames(family.name, family.type)) {
				this.reservedChildSeries.set(childName, family.name)
			}
		}
	}

	/**
	 * Format metrics in legacy Prometheus text format
	 */
	private renderSamples(format: 'openmetrics' | 'prometheus'): string {
		return this.renderRecords([...this.samples.values()], format)
	}

	private renderRecords(records: ReadonlyArray<MetricRecord>, format: 'openmetrics' | 'prometheus'): string {
		return format === 'openmetrics' ? this.formatOpenMetrics(records) : this.formatLegacyPrometheus(records)
	}

	private formatLegacyPrometheus(batch: ReadonlyArray<MetricRecord>): string {
		return renderPrometheus(batch, 'prometheus', (records) => this.preparePrometheusMetrics(records))
	}

	private formatOpenMetrics(batch: ReadonlyArray<MetricRecord>): string {
		return renderPrometheus(batch, 'openmetrics', (records) => this.preparePrometheusMetrics(records))
	}

	/**
	 * Get formatted metrics as string
	 * @param format - Optional format: 'openmetrics' | 'prometheus'.
	 * If undefined, selects OpenMetrics after an exemplar has been exported.
	 * @returns Formatted metrics string
	 */
	getFormatted(format?: 'openmetrics' | 'prometheus'): string {

		return this.renderSamples(format ?? (this.preferOpenMetrics ? 'openmetrics' : 'prometheus'))
	}

	render(format?: 'openmetrics' | 'prometheus'): string {
		return this.getFormatted(format)
	}

	/**
	 * Get content type for HTTP response
	 * @param format - Optional format to determine content type.
	 * If undefined, selects OpenMetrics after an exemplar has been exported.
	 */
	getContentType(format?: 'openmetrics' | 'prometheus'): string {
		// If format is explicitly requested, use it
		if (format === 'openmetrics') {
			return 'application/openmetrics-text; version=1.0.0; charset=utf-8'
		}
		if (format === 'prometheus') {
			return 'text/plain; version=0.0.4; charset=utf-8'
		}

		if (this.preferOpenMetrics) {
			return 'application/openmetrics-text; version=1.0.0; charset=utf-8'
		}
		return 'text/plain; version=0.0.4; charset=utf-8'
	}

	contentType(format?: 'openmetrics' | 'prometheus'): string {
		return this.getContentType(format)
	}

	/**
	 * Clear samples
	 */
	clear(): void {
		this.samples.clear()
		this.sampleRawMetricNames.clear()
		this.metricNameOrigins.clear()
		this.familyTypes.clear()
		this.reservedChildSeries.clear()
		this.preferOpenMetrics = false
	}

	async flush(): Promise<void> {
		// No-op (stateless, metrics are formatted on export)
	}

	async shutdown(): Promise<void> {
		this.closed = true
		this.clear()
	}
}

/**
 * Create a Prometheus exporter
 */
export function createPrometheusExporter(options?: PrometheusExporterOptions): PrometheusExporter {
	return new PrometheusExporter(options)
}
