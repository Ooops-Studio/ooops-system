
import type {ErrorSink} from '../sinks'
import type {EnrichedError} from '../types/normalized-error'
import type {ObservabilityTap} from '../types/observability'
import type {LoggerPort, MetricsPort, TracerPort} from '../types/ports'

export type Report = (error: EnrichedError) => Promise<void>

export interface ReportIntegrationReentryState {
	active: boolean
}

export interface ReportOptions {
	readonly baseReport?: Report
	readonly logger?: LoggerPort
	readonly tracer?: TracerPort
	readonly metrics?: MetricsPort
	readonly observe?: ObservabilityTap
	readonly sink?: ErrorSink
	readonly flushTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
	readonly reportTimeoutMs?: number
}

export interface ReportRuntime {
	report(error: EnrichedError): Promise<void>
	flush(): Promise<void>
	shutdown(): Promise<void>
	state(): 'running' | 'draining' | 'closed'
}
