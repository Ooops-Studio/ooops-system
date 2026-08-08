/**
 * @file Rich instrument and status types for the metrics service.
 */

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
	readonly labels?: Readonly<Record<string, string>>
	readonly histogramBuckets?: ReadonlyArray<number>
	readonly staleAfterMs?: number
}

export interface MetricsStatusSnapshot {
	readonly state: 'running' | 'draining' | 'closed'
	readonly queueSize: number
	readonly activeSeries: number
	readonly droppedTotal: number
	readonly retriedTotal: number
	readonly sinkState: 'healthy' | 'degraded' | 'unhealthy' | 'closed'
	readonly lastFailureCode?: string
}
