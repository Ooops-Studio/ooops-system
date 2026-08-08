import type {Exemplar, MetricMetadata} from '../types/metric-record'

export interface MetricStateBase {
	name: string
	labels: Record<string, string>
	metadata?: MetricMetadata
	lastSeenAt: number
	windowStartedAt: number
	staleAfterMs?: number
}

export interface CounterState extends MetricStateBase {
	type: 'counter'
	value: number
	exemplar?: Exemplar
}

export interface GaugeState extends MetricStateBase {
	type: 'gauge'
	value: number
	exemplar?: Exemplar
}

export interface HistogramState extends MetricStateBase {
	type: 'histogram'
	buckets: ReadonlyArray<number>
	counts: number[]
	sum: number
	count: number
	bucketExemplars: Map<number, Exemplar>
}

export type MetricState = CounterState | GaugeState | HistogramState
