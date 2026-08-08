import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {RateLimitPolicyDefinition} from '@ooopsstudio/core/contracts/rate-limit'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {ManagedRateLimit} from '@ooopsstudio/core/ports/ratelimit'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createMemoryFixedWindowEngine} from '../core/engines/fixed-window-memory'
import {createMemoryTokenBucket} from '../core/engines/token-bucket-memory'
import {createManagedRateLimit} from '../core/managed-handler'

import {snapshotRateLimitOptions} from './options'

const DEFAULT_DEVELOPMENT_POLICY: readonly RateLimitPolicyDefinition[] = Object.freeze([
	Object.freeze({name: 'default', partition: 'keyed', limit: 100, windowMs: 60_000})
])

export interface DevelopmentRateLimitOptions {
	readonly policies?: readonly RateLimitPolicyDefinition[]
	readonly clock?: Clock
	readonly lifecycle?: LifecyclePort
	readonly shutdownTimeoutMs?: number
}

export function createDevelopmentRateLimit(options: DevelopmentRateLimitOptions = {}): ManagedRateLimit {
	const resolved = snapshotRateLimitOptions<DevelopmentRateLimitOptions>(options, new Set([
		'policies', 'clock', 'lifecycle', 'shutdownTimeoutMs'
	]), 'Development rate limit')
	let fixed: ReturnType<typeof createMemoryFixedWindowEngine> | undefined
	return createManagedRateLimit({
		backend: 'memory',
		createEngine: (policy, clock) => policy.algorithm === 'fixed-window'
			? fixed ??= createMemoryFixedWindowEngine(clock)
			: {...createMemoryTokenBucket({clock, capacity: policy.capacity}), type: 'memory'},
		clock: resolved.clock ?? createSystemClock(),
		policies: resolved.policies ?? DEFAULT_DEVELOPMENT_POLICY,
		onBackendError: 'allow',
		...(resolved.lifecycle ? {lifecycle: resolved.lifecycle} : {}),
		...(resolved.shutdownTimeoutMs !== undefined ? {shutdownTimeoutMs: resolved.shutdownTimeoutMs} : {})
	})
}

export type {ManagedRateLimit, RateLimitPolicyDefinition}
