import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createCacheHandler} from '../core/handler'
import {createMemoryCacheBackend} from '../features/backends/memory'

import {snapshotCachePresetOptions} from './options'

export interface DevelopmentCacheOptions {
	clock?: Clock
	namespace?: string
	lifecycle?: LifecyclePort
}

export function createDevelopmentCache(options: DevelopmentCacheOptions = {}) {
	const resolvedOptions = snapshotCachePresetOptions<DevelopmentCacheOptions>(options, new Set([
		'clock', 'namespace', 'lifecycle'
	]), 'Development cache')
	const clock = resolvedOptions.clock ?? createSystemClock()
	const backend = createMemoryCacheBackend({clock, maxEntries: 3_000, maxBytes: 16 * 1024 * 1024, sweepIntervalMs: 1_000})
	try {
		return createCacheHandler({
			clock,
			backend,
			defaultNamespace: resolvedOptions.namespace ?? 'default',
			ttlJitterRatio: 0,
			...(resolvedOptions.lifecycle ? {lifecycle: resolvedOptions.lifecycle} : {})
		})
	} catch(error) {
		// Development owns this timer-backed backend. Construction failure must not
		// retain its expiry sweep when no cache runtime is returned to the caller.
		void backend.shutdown?.()
		throw error
	}
}
