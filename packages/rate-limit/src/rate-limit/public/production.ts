import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {BackendErrorPolicy, RateLimitPolicyDefinition} from '@ooopsstudio/core/contracts/rate-limit'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {ManagedRateLimit} from '@ooopsstudio/core/ports/ratelimit'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createFixedWindowEngine} from '../core/engines/fixed-window'
import type {RedisScriptPort} from '../core/engines/redis-scripts'
import {createRedisTokenBucket} from '../core/engines/token-bucket-redis'
import {createManagedRateLimit} from '../core/managed-handler'
import {bindRateLimitRedis} from '../core/redis-capability'

import {snapshotRateLimitOptions} from './options'

export interface ProductionRateLimitOptions {
	readonly redis: RedisScriptPort
	readonly namespace: string
	readonly policies: readonly RateLimitPolicyDefinition[]
	readonly onBackendError: BackendErrorPolicy
	readonly operationTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
	readonly clock?: Clock
	readonly lifecycle?: LifecyclePort
}

export function createProductionRateLimit(options: ProductionRateLimitOptions): ManagedRateLimit {
	const resolved = snapshotRateLimitOptions<ProductionRateLimitOptions>(options, new Set([
		'redis', 'namespace', 'policies', 'onBackendError', 'operationTimeoutMs', 'shutdownTimeoutMs', 'clock', 'lifecycle'
	]), 'Production rate limit')
	const redis = bindRateLimitRedis(resolved.redis)
	let fixed: ReturnType<typeof createFixedWindowEngine> | undefined
	return createManagedRateLimit({
		backend: 'redis',
		createEngine: (policy, clock) => policy.algorithm === 'fixed-window'
			? fixed ??= createFixedWindowEngine({clock, redis})
			: {...createRedisTokenBucket({clock, redis, capacity: policy.capacity}), type: 'redis'},
		namespace: resolved.namespace,
		policies: resolved.policies,
		onBackendError: resolved.onBackendError,
		clock: resolved.clock ?? createSystemClock(),
		...(resolved.operationTimeoutMs !== undefined ? {operationTimeoutMs: resolved.operationTimeoutMs} : {}),
		...(resolved.shutdownTimeoutMs !== undefined ? {shutdownTimeoutMs: resolved.shutdownTimeoutMs} : {}),
		...(resolved.lifecycle ? {lifecycle: resolved.lifecycle} : {})
	})
}

export type {BackendErrorPolicy, ManagedRateLimit, RateLimitPolicyDefinition}
