import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {attachLifecycleObservability} from '@ooopsstudio/lifecycle/observability'

import {snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type LifecycleBridgeOptions = ObservabilityDestinations

export function wireLifecycleObservability(
	runtime: LifecyclePort,
	options: LifecycleBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	return attachLifecycleObservability(
		runtime,
		Object.freeze({...configured}) as LifecycleBridgeOptions
	)
}
