import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LeasePolicy, RetryPolicy} from '@ooopsstudio/core/contracts/jobs'
import type {JobsRuntime} from '@ooopsstudio/core/ports/jobs'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {createCustomJobsHandler} from '../core/handler-custom'
import type {JobsBackend} from '../types/backend'
import {snapshotJobsOptions} from '../utils/options'
import {assertCompleteJobsBackend} from '../utils/preset-helpers'

export type {JobsAdminStore, JobsBackend, JobsMaintenanceStore, JobsRunStore, JobsScheduleStore} from '../types/backend'

const CUSTOM_OPTION_FIELDS = new Set([
	'clock', 'backend', 'retry', 'lease', 'lifecycle', 'namespace', 'pollIntervalMs',
	'defaultQueue', 'maxConcurrentRuns', 'terminalRetentionMs', 'maxCatchUp'
])

export interface CustomJobsOptions {
	clock: Clock
	backend: JobsBackend
	retry?: RetryPolicy
	lease?: LeasePolicy
	lifecycle?: LifecyclePort
	namespace?: string
	pollIntervalMs?: number
	defaultQueue?: string
	maxConcurrentRuns?: number
	terminalRetentionMs?: number
	maxCatchUp?: number
}

export async function createCustomJobs(options: CustomJobsOptions): Promise<JobsRuntime> {
	const input = snapshotJobsOptions<CustomJobsOptions>(options, CUSTOM_OPTION_FIELDS, 'Custom jobs options')
	if (!input.backend) throw new Error('Custom jobs scheduler requires an explicit backend')
	const backend = assertCompleteJobsBackend(input.backend)
	const invalidRetention = input.terminalRetentionMs !== undefined &&
		(!Number.isSafeInteger(input.terminalRetentionMs) ||
			input.terminalRetentionMs <= 0 || input.terminalRetentionMs > 2_147_483_647)
	if (invalidRetention) {
		throw new Error('Custom jobs terminalRetentionMs must be between 1 and 2147483647')
	}
	if (input.maxCatchUp !== undefined && (!Number.isSafeInteger(input.maxCatchUp)
		|| input.maxCatchUp < 1 || input.maxCatchUp > 100)) {
		throw new Error('Custom jobs maxCatchUp must be between 1 and 100')
	}
	return createCustomJobsHandler({
		...input,
		backend,
		maintenanceIntervalMs: 30_000,
		terminalRetentionMs: input.terminalRetentionMs ?? 7 * 24 * 60 * 60 * 1_000,
		maxCatchUp: input.maxCatchUp ?? 10,
		retry: input.retry ?? {attempts: 3, baseDelayMs: 500, backoff: {kind: 'fixed'}, jitter: 'none'},
		schedulePolicy: {
			misfire: ['skip', 'fire-once', 'catch-up'],
			overlap: ['queue', 'skip', 'allow'],
			defaults: {misfire: 'fire-once', overlap: 'queue'}
		}
	})
}
