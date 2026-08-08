import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CacheBackendPort} from '@ooopsstudio/core/ports/cache'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createCacheHandler} from '../core/handler'

import {snapshotCachePresetOptions} from './options'

export interface CustomCacheOptions {
	backend: CacheBackendPort
	clock?: Clock
	defaultNamespace?: string
	lifecycle?: LifecyclePort
}

export function createCustomCache(options: CustomCacheOptions) {
	if (options === undefined) throw new Error('Custom cache requires an external backend')
	const resolvedOptions = snapshotCachePresetOptions<CustomCacheOptions>(options, new Set([
		'backend', 'clock', 'defaultNamespace', 'lifecycle'
	]), 'Custom cache')
	if (!resolvedOptions.backend) throw new Error('Custom cache requires an external backend')
	return createCacheHandler({...resolvedOptions, clock: resolvedOptions.clock ?? createSystemClock()})
}
