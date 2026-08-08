import type {ProfilingPort} from '@ooopsstudio/core/ports/profiling'

export type ProfilingRuntimeState = 'running' | 'draining' | 'closed'
export type ProfilingSinkState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface ProfilingStatus {
	readonly state: ProfilingRuntimeState
	readonly activeCapture: boolean
	readonly capturesTotal: number
	readonly droppedTotal: number
	readonly exportFailuresTotal: number
	readonly sinkState: ProfilingSinkState
	readonly lastFailureCode?: string
}

export interface ManagedProfiling extends ProfilingPort {
	getStatus(): ProfilingStatus
	flush(): Promise<void>
	shutdown(): Promise<void>
}
