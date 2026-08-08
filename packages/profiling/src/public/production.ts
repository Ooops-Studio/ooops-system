import {createProfilingManager} from '../manager'
import type {ManagedProfiling} from '../types'

import {readProfilingData, snapshotStandardOptions} from './boundary'
import type {ProductionProfilingOptions} from './types'

export type {ProductionProfilingOptions} from './types'

export async function createProductionProfiling(options: ProductionProfilingOptions): Promise<ManagedProfiling> {
	if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('production_profiling_requires_continuous_provider')
	const continuous = readProfilingData<ProductionProfilingOptions['continuous']>(options, 'continuous', 'production_profiling_requires_continuous_provider')
	if (!continuous) throw new Error('production_profiling_requires_continuous_provider')
	return await createProfilingManager({...snapshotStandardOptions(options, 'production_profiling_invalid_options'), continuous, operationTimeoutMs: 10_000, shutdownTimeoutMs: 15_000})
}
