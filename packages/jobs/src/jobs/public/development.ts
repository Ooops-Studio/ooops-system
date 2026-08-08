import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {JobsRuntime} from '@ooopsstudio/core/ports/jobs'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {createBasicJobsHandler} from '../core/handler-basic'
import {createMemoryJobsBackend} from '../features/backends/memory'
import {snapshotJobsOptions} from '../utils/options'
import {assertCompleteJobsBackend} from '../utils/preset-helpers'

const DEVELOPMENT_OPTION_FIELDS = new Set([
	'clock', 'lifecycle', 'namespace', 'defaultQueue'
])

export interface DevelopmentJobsOptions {
	clock: Clock
	lifecycle?: LifecyclePort
	namespace?: string
	defaultQueue?: string
}

export async function createDevelopmentJobs(options: DevelopmentJobsOptions): Promise<JobsRuntime> {
	const input = snapshotJobsOptions<DevelopmentJobsOptions>(
		options, DEVELOPMENT_OPTION_FIELDS, 'Development jobs options'
	)
	return createBasicJobsHandler({
		...input,
		backend: assertCompleteJobsBackend(createMemoryJobsBackend({namespace: input.namespace})),
		pollIntervalMs: 100,
		maintenanceIntervalMs: 5_000,
		maxCatchUp: 1,
		maxConcurrentRuns: 2,
		retry: {attempts: 3, baseDelayMs: 100, backoff: {kind: 'fixed'}, jitter: 'none'},
		schedulePolicy: {misfire: ['fire-once'], overlap: ['queue', 'skip'], defaults: {misfire: 'fire-once', overlap: 'queue'}}
	})
}
