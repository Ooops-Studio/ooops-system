import {createConsoleProfileExporter} from '../console-exporter'
import {createLazyInspectorProfiler} from '../lazy-inspector-profiler'
import {createProfilingManager} from '../manager'
import type {ManagedProfiling} from '../types'

import {snapshotStandardOptions} from './boundary'
import type {StandardProfilingOptions} from './types'

export type {StandardProfilingOptions} from './types'

export async function createDevelopmentProfiling(options: StandardProfilingOptions = {}): Promise<ManagedProfiling> {
	const snapshot = snapshotStandardOptions(options, 'development_profiling_invalid_options')
	return createProfilingManager({
		...snapshot,
		profiler: createLazyInspectorProfiler(snapshot.clock ?? (await import('@ooopsstudio/core/runtime/time/system-clock')).createSystemClock()),
		destinations: [{name: 'console', exporter: createConsoleProfileExporter()}],
		maxDurationMs: 30_000,
		maxPayloadBytes: 16 * 1024 * 1024
	})
}
