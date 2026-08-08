import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CacheRedisPort} from '@ooopsstudio/core/ports/cache'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createCacheHandler} from '../core/handler'
import {createRedisCacheBackend} from '../features/backends/redis'

import {snapshotCachePresetOptions} from './options'

export interface ProductionCacheOptions {
	redis: CacheRedisPort
	namespace: string
	clock?: Clock
	lifecycle?: LifecyclePort
}

export function createProductionCache(options: ProductionCacheOptions) {
	if (options === undefined) throw new Error('Production cache requires Redis')
	const resolvedOptions = snapshotCachePresetOptions<ProductionCacheOptions>(options, new Set([
		'redis', 'namespace', 'clock', 'lifecycle'
	]), 'Production cache')
	if (!resolvedOptions.redis) throw new Error('Production cache requires Redis')
	if (typeof resolvedOptions.namespace !== 'string' || !resolvedOptions.namespace) {
		throw new Error('Production cache requires an application namespace')
	}
	const clock = resolvedOptions.clock ?? createSystemClock()
	return createCacheHandler({
		clock,
		backend: createRedisCacheBackend({clock, redis: resolvedOptions.redis, keyPrefix: `cache:${resolvedOptions.namespace}`}),
		defaultNamespace: resolvedOptions.namespace,
		ttlJitterRatio: 0.1,
		...(resolvedOptions.lifecycle ? {lifecycle: resolvedOptions.lifecycle} : {})
	})
}
