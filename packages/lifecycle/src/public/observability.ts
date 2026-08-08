import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'

import {snapshotRecord} from '../core/lifecycle-handler-validation'
import {attachLifecycleTelemetry} from '../core/telemetry-controller'

export interface LifecycleObservabilityAttachment {
	readonly errors?: Errors
	readonly logger?: Logging
	readonly metrics?: MetricsPort
	readonly tracer?: Tracing
}

/** Attach ports omitted during lifecycle creation without exposing runtime internals. */
export function attachLifecycleObservability(
	runtime: object,
	ports: LifecycleObservabilityAttachment
): () => void {
	if (!runtime || typeof runtime !== 'object') {
		throw new TypeError('Lifecycle observability requires a managed lifecycle runtime')
	}
	const snapshot = snapshotRecord(
		ports,
		'Lifecycle observability attachment',
		new Set(['errors', 'logger', 'metrics', 'tracer'])
	) as LifecycleObservabilityAttachment
	return attachLifecycleTelemetry(runtime, Object.freeze({...snapshot}))
}
