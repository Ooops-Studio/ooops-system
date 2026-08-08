import {createProfilingManager} from '../manager'
import type {ManagedProfiling} from '../types'

import {readProfilingData, snapshotStandardOptions} from './boundary'
import type {CustomProfilingOptions} from './types'

export type {CustomProfilingOptions} from './types'

const INVALID_OPTIONS = 'custom_profiling_invalid_options'
const INVALID_CAPTURE = 'profiling_invalid_manual_capture'

export async function createCustomProfiling(options: CustomProfilingOptions): Promise<ManagedProfiling> {
	if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error(INVALID_OPTIONS)
	const profiler = readProfilingData<CustomProfilingOptions['profiler']>(options, 'profiler', INVALID_OPTIONS)
	const continuous = readProfilingData<CustomProfilingOptions['continuous']>(options, 'continuous', INVALID_OPTIONS)
	const destinations = readProfilingData<CustomProfilingOptions['destinations']>(options, 'destinations', INVALID_OPTIONS)
	const manualCapture = readProfilingData<CustomProfilingOptions['manualCapture']>(options, 'manualCapture', INVALID_OPTIONS)
	const operationTimeoutMs = readProfilingData<number>(options, 'operationTimeoutMs', INVALID_OPTIONS)
	const shutdownTimeoutMs = readProfilingData<number>(options, 'shutdownTimeoutMs', INVALID_OPTIONS)
	const {clock, resource, lifecycle} = snapshotStandardOptions(options, INVALID_OPTIONS)
	if (!(profiler || continuous)) throw Error('custom_profiling_requires_capability')
	const destinationCount = Array.isArray(destinations)
		? readProfilingData<number>(destinations, 'length', 'profiling_invalid_destinations')
		: 0
	if (profiler && !destinationCount) throw Error('custom_profiling_manual_requires_destination')
	let maxDurationMs; let cooldownMs; let maxPayloadBytes
	if (manualCapture !== undefined) {
		if (!manualCapture || typeof manualCapture !== 'object' || Array.isArray(manualCapture)) throw Error(INVALID_CAPTURE)
		maxDurationMs = readProfilingData<number>(manualCapture, 'maxDurationMs', INVALID_CAPTURE)
		cooldownMs = readProfilingData<number>(manualCapture, 'cooldownMs', INVALID_CAPTURE)
		maxPayloadBytes = readProfilingData<number>(manualCapture, 'maxPayloadBytes', INVALID_CAPTURE)
	}
	return createProfilingManager({
		clock, resource, lifecycle, profiler, continuous, destinations,
		maxDurationMs, cooldownMs, maxPayloadBytes, operationTimeoutMs, shutdownTimeoutMs
	})
}
