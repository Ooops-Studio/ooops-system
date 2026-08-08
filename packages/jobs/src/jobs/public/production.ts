import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {JobsRuntime} from '@ooopsstudio/core/ports/jobs'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {createBasicJobsHandler} from '../core/handler-basic'
import type {JobsBackend} from '../types/backend'
import {snapshotJobsOptions} from '../utils/options'
import {assertDurableJobsBackend} from '../utils/preset-helpers'

const PRODUCTION_OPTION_FIELDS = new Set([
	'clock', 'backend', 'lifecycle', 'namespace',
	'defaultQueue', 'maxConcurrentRuns', 'lease'
])

export interface ProductionJobsOptions {
	clock: Clock
	backend: JobsBackend
	lifecycle?: LifecyclePort
	namespace?: string
	defaultQueue?: string
	maxConcurrentRuns?: number
	lease?: {leaseMs: number; recoveryAfterMs?: number}
}

export async function createProductionJobs(options: ProductionJobsOptions): Promise<JobsRuntime> {
	const input = snapshotJobsOptions<ProductionJobsOptions>(
		options, PRODUCTION_OPTION_FIELDS, 'Production jobs options'
	)
	const backend = assertDurableJobsBackend(input.backend)
	const lease = input.lease === undefined
		? undefined
		: snapshotJobsOptions<NonNullable<ProductionJobsOptions['lease']>>(
			input.lease, new Set(['leaseMs', 'recoveryAfterMs']), 'Production jobs lease options'
		)
	return createBasicJobsHandler({
		...input,
		backend,
		pollIntervalMs: 250,
		maintenanceIntervalMs: 30_000,
		terminalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
		maxCatchUp: 1,
		maxConcurrentRuns: input.maxConcurrentRuns ?? 8,
		retry: {attempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, backoff: {kind: 'exponential', factor: 2}, jitter: 'bounded'},
		lease: {leaseMs: lease?.leaseMs ?? 60_000, recoveryAfterMs: lease?.recoveryAfterMs ?? 90_000},
		schedulePolicy: {misfire: ['fire-once'], overlap: ['queue', 'skip'], defaults: {misfire: 'fire-once', overlap: 'queue'}}
	})
}
