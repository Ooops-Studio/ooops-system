import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {ContinuousProfiler, CpuProfiler, ProfileExporter} from '@ooopsstudio/core/ports/profiling'

export interface StandardProfilingOptions {
	readonly clock?: Clock
	readonly resource?: ObservabilityResource
	readonly lifecycle?: LifecyclePort
}

export interface ProductionProfilingOptions extends StandardProfilingOptions {
	readonly continuous: ContinuousProfiler
}

export interface CustomProfilingOptions extends StandardProfilingOptions {
	readonly profiler?: CpuProfiler
	readonly continuous?: ContinuousProfiler
	readonly destinations?: readonly {readonly name: string; readonly exporter: ProfileExporter}[]
	readonly manualCapture?: {
		readonly maxDurationMs?: number
		readonly cooldownMs?: number
		readonly maxPayloadBytes?: number
	}
	readonly operationTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
}
