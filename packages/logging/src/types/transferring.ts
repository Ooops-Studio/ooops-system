import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import type {Sink} from './sink'

export type LogLine = string

export interface BatchingPolicy {
	readonly maxBatch: number
	readonly maxIntervalMs: number
	readonly maxBytes: number
}

export interface RetryPolicy {
	readonly maxAttempts: number
	readonly baseDelayMs: number
	readonly multiplier: number
	readonly maxDelayMs: number
	readonly jitter: number
	readonly attemptTimeoutMs: number
}

export type DropPolicy = 'drop-oldest' | 'drop-newest' | 'error'

export interface BackpressurePolicy {
	readonly maxQueuedItems: number
	readonly maxQueuedBytes: number
	readonly onOverflow: DropPolicy
}

export interface CircuitBreakerPolicy {
	readonly failureThreshold: number
	readonly halfOpenAfterMs: number
	readonly maxHalfOpenProbes: number
}

export interface TransferringPolicies {
	readonly batching?: BatchingPolicy
	readonly retry?: RetryPolicy
	readonly backpressure?: BackpressurePolicy
	readonly circuitBreaker?: CircuitBreakerPolicy
}

export type TransferSinkState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

/** Internal delivery signal used by batching/retry telemetry; never buffered or exported publicly. */
export type TransferSignalKind =
	| 'write'
	| 'write-batch'
	| 'flush'
	| 'close'
	| 'drop'
	| 'retry'
	| 'error'

export interface TransferTelemetrySnapshot {
	readonly queueSize: number
	readonly writtenTotal: number
	readonly droppedTotal: number
	readonly retriedTotal: number
	readonly sinkState: TransferSinkState
	readonly lastFailureCode?: string
}

export type ErrorHandlerFunction = (
	error: unknown,
	context?: Record<string, unknown>
) => Promise<unknown> | unknown

export interface TransferringOptions {
	readonly sink: Sink<LogLine>
	readonly clock: Clock
	readonly policy?: TransferringPolicies
	readonly errors?: Errors
	readonly errorHandler?: ErrorHandlerFunction
}

export interface TransferringHandle {
	write(line: LogLine): void
	flush(): Promise<void>
	close(): Promise<void>
	telemetry(): TransferTelemetrySnapshot
}

export type CreateTransferring = (
	options: Readonly<TransferringOptions>
) => TransferringHandle
