import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import type {PrometheusScrapeSource} from '../sinks/prometheus'
import type {MetricExportResult, MetricExporterPort} from '../types/exporter'
import type {MetricRecord} from '../types/metric-record'

export type MetricLabels = Readonly<Record<string, string>>
export type MetricTemporality = 'cumulative' | 'delta'
export type MetricInstrumentKind =
	| 'counter'
	| 'up_down_counter'
	| 'gauge'
	| 'histogram'
	| 'timer'

export interface MetricInstrumentDefinition {
	readonly name: string
	readonly instrument: MetricInstrumentKind
	readonly description?: string
	readonly unit?: string
	readonly temporality?: MetricTemporality
	readonly labels?: readonly string[]
	readonly histogramBuckets?: readonly number[]
}

export type MetricsRuntimeState = 'running' | 'draining' | 'closed'
export type MetricsSinkState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface MetricsStatus {
	readonly state: MetricsRuntimeState
	readonly queueSize: number
	readonly activeSeries: number
	readonly droppedTotal: number
	readonly retriedTotal: number
	readonly sinkState: MetricsSinkState
	readonly lastFailureCode?: string
}

export interface ManagedMetrics extends Required<MetricsPort> {
	increment(name: string, labels?: MetricLabels, count?: number): void
	record(name: string, value: number, labels?: MetricLabels): void
	counter(name: string, count?: number, labels?: MetricLabels): void
	upDownCounter(name: string, delta: number, labels?: MetricLabels): void
	gauge(name: string, value: number, labels?: MetricLabels): void
	histogram(name: string, value: number, labels?: MetricLabels): void
	timer(name: string, durationMs: number, labels?: MetricLabels): void
	getStatus(): MetricsStatus
	flush(): Promise<void>
	shutdown(): Promise<void>
}

export interface PrometheusManagedMetrics extends ManagedMetrics, PrometheusScrapeSource {}

export type MetricBatch = readonly MetricRecord[]

/** Public custom exporter contract. Provider health is tracked by delivery outcomes. */
export interface MetricExporter extends Pick<MetricExporterPort, 'export' | 'flush' | 'shutdown'> {
	export(batch: MetricBatch): Promise<void | MetricExportResult>
}

export type {MetricExportResult, MetricRecord, PrometheusScrapeSource}
