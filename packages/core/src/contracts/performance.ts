import type {LogAttributes} from './logging'
import type {ObservabilityResource} from './observability-shared'
import type {SpanKind} from './tracing'

export interface PerformanceMeasurement {
	name: string
	duration: number
	unit?: 'ms' | 's' | 'ns'
	tags?: Record<string, string>
}

export interface HttpPerfMetadata {
	method: string
	route: string
	statusCode?: number
	hostKind?: string
	runtime?: string
	outcome?: 'ok' | 'client_error' | 'server_error' | 'timeout' | 'aborted'
	requestSize?: number
	responseSize?: number
	aborted?: boolean
	timedOut?: boolean
}

export interface DBQueryMetadata {
	operation?: string
	table?: string
	collection?: string
	rows?: number
	method?: 'get' | 'list' | 'create' | 'update' | 'delete'
	limit?: number
	offset?: number
	orderBy?: string[]
	permissionExpansion?: boolean
	projection?: string[]
	documentCount?: number
	payloadSize?: number
	statusCode?: number
	retryCount?: number
	timeout?: boolean
	success?: boolean
	failureCode?: 'query_failed'
	queryHash?: string
}

export interface PerfEvent {
	name: string
	duration: number
	start: number
	end: number
	labels?: Record<string, string>
	source: 'runtime' | 'mark' | 'feature'
	traceId?: string
	spanId?: string
	outcome?: 'ok' | 'client_error' | 'server_error' | 'timeout' | 'aborted'
	http?: HttpPerfMetadata
	dbMetadata?: DBQueryMetadata
}

export interface DBQueryEvent extends PerfEvent {
	dbMetadata?: DBQueryMetadata
}

export interface BudgetViolation {
	name: string
	target: number
	actual: number
	window: number
	diff: number
}

export interface SaturationAlert {
	reason: string
	severity: 'info' | 'warn' | 'critical'
	value: number
	threshold: number
	/** Current bounded saturation state when the producer reports transitions. */
	state?: 'healthy' | 'info' | 'warn' | 'critical'
	/** Previous state for transition-aware observability bridges. */
	previousState?: 'healthy' | 'info' | 'warn' | 'critical'
	/** True when this is a bounded reminder rather than a state transition. */
	reminder?: boolean
	/** Aggregation used to evaluate the threshold. */
	aggregation?: 'instant' | 'p95'
	/** Number of samples included in the aggregation window. */
	sampleCount?: number
}

export interface BudgetStatus {
	name: string
	target: number
	current: number
	violated: boolean
	violationCount: number
	window: number
}

export interface PerformanceEventRecord {
	recordedAt: number
	event: PerfEvent
	traceId?: string
	spanId?: string
	source: PerfEvent['source']
	http?: HttpPerfMetadata
	dbMetadata?: DBQueryMetadata
	resource?: ObservabilityResource
}

export interface PerformanceSpanOptions {
	labels?: Readonly<Record<string, string>>
	kind?: SpanKind
	attributes?: LogAttributes
	http?: HttpPerfMetadata
	dbMetadata?: DBQueryMetadata
	createSpan?: boolean
}

export interface N1Pattern {
	type: 'identical-queries' | 'repeated-queries' | 'query-waterfall' | 'over-fetching'
	duplicateCount: number
	querySignature: string
	collection?: string
	method?: string
	timeWindow: number
	suggestion?: string
}
