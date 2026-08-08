import type {ManagedRateLimit} from '@ooopsstudio/core/ports/ratelimit'

import {
	attachRateLimitTelemetry,
	type RateLimitTelemetryEvent
} from '../runtime-capabilities'

export type RateLimitObservabilityEvent = RateLimitTelemetryEvent
export type RateLimitObservabilityListener = (event: RateLimitObservabilityEvent) => void
export type RateLimitObservabilityAttachment = () => void

/**
 * Attaches one fail-open observer to a managed rate-limit runtime.
 * Cross-domain mappings belong in a separate bridge package.
 */
export function attachRateLimitObservability(
	runtime: ManagedRateLimit,
	listener: RateLimitObservabilityListener
): RateLimitObservabilityAttachment {
	if (typeof listener !== 'function') throw new TypeError('Rate-limit observability listener must be a function')
	return attachRateLimitTelemetry(runtime, listener)
}
