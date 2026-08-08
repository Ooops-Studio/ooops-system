import {
	attachResilienceTelemetry,
	type ResilienceTelemetryEvent
} from '../runtime-capabilities'

import type {ManagedResilience} from './types'

export type ResilienceObservabilityEvent = ResilienceTelemetryEvent
export type ResilienceObservabilityListener = (event: ResilienceObservabilityEvent) => void
export type ResilienceObservabilityAttachment = () => void

/**
 * Attaches one fail-open observer to a managed resilience runtime.
 * Cross-domain mappings belong in a separate bridge package.
 */
export function attachResilienceObservability(
	runtime: ManagedResilience,
	listener: ResilienceObservabilityListener
): ResilienceObservabilityAttachment {
	if (typeof listener !== 'function') throw new TypeError('Resilience observability listener must be a function')
	return attachResilienceTelemetry(runtime, listener)
}
