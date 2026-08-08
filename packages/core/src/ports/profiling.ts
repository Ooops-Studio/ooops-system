/** Generic profiling capability contracts shared across runtime implementations. */

import type {ProfileCaptureOptions, ProfileCaptureSummary} from '../contracts/profiling'

export interface ProfilingPort {
	capture(options: ProfileCaptureOptions): Promise<ProfileCaptureSummary>
}

export interface CpuProfileArtifact extends ProfileCaptureSummary {
	readonly format: 'cpuprofile'
	readonly payload: string
	readonly labels?: Readonly<Record<string, string>>
	readonly resource: Readonly<Record<string, string>>
}

export interface ContinuousProfilerStatus {
	readonly state: 'idle' | 'starting' | 'running' | 'draining' | 'closed'
	readonly healthy: boolean
	readonly lastFailureCode?: string
}

export interface ContinuousProfiler {
	start(): Promise<void>
	shutdown(): Promise<void>
	getStatus(): ContinuousProfilerStatus
}

export interface ProfileExporter {
	export(profile: Readonly<CpuProfileArtifact>): Promise<void>
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}

export interface CpuProfiler {
	capture(options: ProfileCaptureOptions & {readonly signal: AbortSignal}): Promise<CpuProfileArtifact>
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}
