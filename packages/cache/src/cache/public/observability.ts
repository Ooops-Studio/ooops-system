import type {ManagedCache} from '@ooopsstudio/core/ports/cache'

import {
	attachCacheTelemetry,
	type CacheTelemetryEvent
} from '../runtime-capabilities'

export type CacheObservabilityEvent = CacheTelemetryEvent
export type CacheObservabilityListener = (event: CacheObservabilityEvent) => void
export type CacheObservabilityAttachment = () => void

/**
 * Attaches one fail-open observer to a managed cache runtime.
 * Cross-domain mapping belongs in a separate bridge package.
 */
export function attachCacheObservability(
	cache: ManagedCache,
	listener: CacheObservabilityListener
): CacheObservabilityAttachment {
	if (typeof listener !== 'function') throw new TypeError('Cache observability listener must be a function')
	return attachCacheTelemetry(cache, listener)
}
