import type {LogContext, LogLevel} from '@ooopsstudio/core/contracts/logging'
import type {Logging} from '@ooopsstudio/core/ports/logging'

export interface LoggingSamplingPolicy {
	readonly strategy: 'fixed-rate' | 'keyed'
	readonly rate: number
	readonly keepAtOrAbove?: LogLevel
}

export type LoggingRuntimeState = 'running' | 'draining' | 'closed'
export type LoggingSinkState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface LoggingStatus {
	readonly state: LoggingRuntimeState
	readonly level: LogLevel
	readonly mutableLevel: boolean
	readonly queueSize: number
	readonly droppedTotal: number
	readonly retriedTotal: number
	readonly sinkState: LoggingSinkState
	readonly lastFailureCode?: string
}

export interface ManagedLogging extends Logging {
	readonly level: LogLevel
	getStatus(): LoggingStatus
	flush(): Promise<void>
	shutdown(): Promise<void>
	context(bindings: Partial<LogContext>): ManagedLogging
}

export interface MutableLevelLogging extends ManagedLogging {
	setLevel(level: LogLevel): void
	context(bindings: Partial<LogContext>): MutableLevelLogging
}
