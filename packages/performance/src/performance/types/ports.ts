import type {BudgetStatus, PerformanceSpanOptions} from '@ooopsstudio/core/contracts/performance'
import type {PerformancePort} from '@ooopsstudio/core/ports/performance'
import type {TracingSpan} from '@ooopsstudio/core/ports/tracing'

export type PerformanceRuntimeState = 'running' | 'draining' | 'closed'
export type PerformanceSinkState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface PerformanceStatus {
	readonly state: PerformanceRuntimeState
	readonly activeMeasurements: number
	readonly queueSize: number
	readonly droppedTotal: number
	readonly retriedTotal: number
	readonly sinkState: PerformanceSinkState
	readonly lastFailureCode?: string
}

export interface ManagedPerformance extends Required<PerformancePort> {
	getBudgetStatus(name: string): Readonly<BudgetStatus> | undefined
	getStatus(): PerformanceStatus
	flush(): Promise<void>
	shutdown(): Promise<void>
}

export type PerformanceHandlerPort = ManagedPerformance

export interface PerformanceTracingBridge {
	getCorrelation(): {traceId?: string; spanId?: string}
	withSpan<T>(name: string, options: PerformanceSpanOptions | undefined, fn: (span?: TracingSpan) => Promise<T>): Promise<T>
	annotate(span: TracingSpan | undefined, options: PerformanceSpanOptions | undefined, duration: number, outcome: 'ok' | 'error'): void
	recordError(span: TracingSpan | undefined, error: unknown): void
}
