/**
 * @file Public types for tracing service.
 */
export type {
	Tracing,
	TracingSpan,
	SpanOptions,
	InjectOptions,
	ExtractResult
} from '@ooopsstudio/core/ports/tracing'
export type {
	SpanRecord,
	SpanContext,
	SpanKind,
	SpanStatus,
	SpanEvent,
	SpanLink,
	TracingContext
} from '@ooopsstudio/core/contracts/tracing'
export type {
	ObservabilityResource,
	TraceCorrelationFields
} from '@ooopsstudio/core/contracts/observability-shared'
export type {OtlpRemoteConfig} from '../sinks'
export type {TraceRedactionRule} from '../features/redaction/types'

import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'

export type TracingRuntimeState = 'running' | 'draining' | 'closed'
export type TracingSinkState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface TracingStatus {
	state: TracingRuntimeState
	activeSpans: number
	queueSize: number
	droppedTotal: number
	retriedTotal: number
	sinkState: TracingSinkState
	lastFailureCode?: string
}

export interface ManagedTracing extends Tracing {
	withExtractedHeaders<T>(carrier: Record<string, string>, fn: () => T | Promise<T>): Promise<T>
	getBaggage(): Readonly<LogAttributes>
	setBaggage(attrs: LogAttributes, mode?: 'merge' | 'replace'): void
	clearBaggage(keys?: readonly string[]): void
	getStatus(): TracingStatus
	forceFlush(): Promise<void>
	shutdown(): Promise<void>
}

export interface TracingSamplingPolicy {
	strategy: 'fixed-rate'
	rate: number
}

export interface TraceExportResult {
	status: 'success' | 'partial' | 'retryable' | 'throttled' | 'permanent-failure'
	acceptedCount: number
	retryAfterMs?: number
}

export interface TraceExporter {
	export(batch: readonly SpanRecord[]): Promise<void | TraceExportResult>
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}
