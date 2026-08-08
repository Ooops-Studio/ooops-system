import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import type {MonotonicMillisClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'

export interface LifecycleObservabilityOptions {
	readonly errors?: Errors
	readonly logger?: Logging
	readonly metrics?: MetricsPort
	readonly tracer?: Tracing
	readonly selfMetrics?: boolean
}

export interface StandardLifecycleOptions {
	readonly resource?: ObservabilityResource
	readonly observability?: LifecycleObservabilityOptions
}

export interface CustomLifecycleOptions extends StandardLifecycleOptions {
	readonly clock: Clock
	readonly monotonicClock?: MonotonicMillisClock
	readonly startup?: {
		readonly initTimeoutMs?: number
		readonly warmTimeoutMs?: number
	}
	readonly shutdown?: {
		readonly timeoutMs?: number
		readonly hookTimeoutMs?: number
		readonly flushTimeoutMs?: number
		readonly drainGracePeriodMs?: number
		readonly groups?: readonly string[]
	}
	readonly health?: {
		readonly intervalMs?: number
		readonly checkTimeoutMs?: number
		readonly runTimeoutMs?: number
		readonly concurrency?: number
	}
}

export interface ResolvedLifecycleOptions {
	readonly clock: Clock
	readonly monotonicClock: MonotonicMillisClock
	readonly resource?: ObservabilityResource
	readonly observability?: LifecycleObservabilityOptions
	readonly initTimeoutMs: number
	readonly warmTimeoutMs: number
	readonly shutdownTimeoutMs: number
	readonly hookTimeoutMs: number
	readonly flushTimeoutMs: number
	readonly drainGracePeriodMs: number
	readonly shutdownGroups: readonly string[]
	readonly healthIntervalMs: number
	readonly healthCheckTimeoutMs: number
	readonly healthRunTimeoutMs: number
	readonly healthConcurrency: number
}
