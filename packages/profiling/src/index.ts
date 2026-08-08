import type {Container} from '@ooopsstudio/core/runtime'

import type {ProfilingRegistrationOptions} from './registration'

export async function registerProfiling(container: Container, configuration: ProfilingRegistrationOptions): Promise<void> {
	const {registerProfilingImplementation} = await import('./registration')
	await registerProfilingImplementation(container, configuration)
}

export type {ProfileCaptureOptions, ProfileCaptureSummary} from '@ooopsstudio/core/contracts/profiling'
export type {ContinuousProfiler, ContinuousProfilerStatus, CpuProfileArtifact, CpuProfiler, ProfileExporter, ProfilingPort} from '@ooopsstudio/core/ports/profiling'
export type {CustomProfilingOptions, ProductionProfilingOptions, StandardProfilingOptions} from './public/types'
export type {ProfilingRegistrationOptions} from './registration'
export type {ManagedProfiling, ProfilingRuntimeState, ProfilingSinkState, ProfilingStatus} from './types'
