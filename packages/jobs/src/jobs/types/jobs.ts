import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {
	LeasePolicy,
	MisfirePolicy,
	OverlapPolicy,
	RetryPolicy,
	TaskDefinition
} from '@ooopsstudio/core/contracts/jobs'
import type {RegisteredTaskHandler} from '@ooopsstudio/core/ports/jobs'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import type {
	JobsBackendRuntime,
	JobsMemoryBackendOptions,
	JobsRedisBackendOptions,
	JobsSqlBackendOptions,
	StoredJobRun,
	StoredSchedule
} from './backend'

export interface JobsHandlerOptions {
	clock: Clock
	backend: JobsBackendRuntime
	retry: RetryPolicy
	lifecycle?: LifecyclePort
	namespace?: string
	pollIntervalMs?: number
	defaultQueue?: string
	maxConcurrentRuns?: number
	lease?: LeasePolicy
	maintenanceIntervalMs: number
	terminalRetentionMs?: number
	maxCatchUp: number
	schedulePolicy: {
		misfire: readonly MisfirePolicy[]
		overlap: readonly OverlapPolicy[]
		defaults: {misfire: MisfirePolicy; overlap: OverlapPolicy}
	}
}

export type {JobsMemoryBackendOptions, JobsRedisBackendOptions, JobsSqlBackendOptions}

export interface InternalTaskRegistration {
	definition: TaskDefinition
	handler: RegisteredTaskHandler
}

export type InternalRun = StoredJobRun
export type {StoredSchedule}

export interface JobsRuntimeState {
	activeControllers: Map<string, AbortController>
	activeRunSchedules: Map<string, string | undefined>
	locallyCancelledActiveRunIds: Set<string>
	recentlyCancelledRunIds: Set<string>
	cancellationFenceOverflow: boolean
	cancellationFenceGeneration: bigint
	timedOutRunIds: Set<string>
	timedOutTaskOperations: Map<string, Promise<void>>
	executionFailures: Error[]
	backgroundFailures: Error[]
	retriedTotal: number
	deadLetteredTotal: number
	lastFailureCode?: string
	backendState: 'healthy' | 'degraded' | 'unhealthy'
}
