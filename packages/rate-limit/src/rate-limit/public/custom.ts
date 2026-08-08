import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {BackendErrorPolicy, RateLimitPolicyDefinition} from '@ooopsstudio/core/contracts/rate-limit'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {ManagedRateLimit} from '@ooopsstudio/core/ports/ratelimit'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createFixedWindowEngine} from '../core/engines/fixed-window'
import type {RedisScriptPort} from '../core/engines/redis-scripts'
import {createMemoryTokenBucket} from '../core/engines/token-bucket-memory'
import {createRedisTokenBucket} from '../core/engines/token-bucket-redis'
import {createManagedRateLimit} from '../core/managed-handler'
import {bindRateLimitRedis} from '../core/redis-capability'

import {snapshotRateLimitOptions} from './options'

interface CustomRateLimitCommon {
	readonly policies: readonly RateLimitPolicyDefinition[]
	readonly operationTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
	readonly clock?: Clock
	readonly lifecycle?: LifecyclePort
}

export type CustomRateLimitOptions =
	| (CustomRateLimitCommon & {
		readonly backend?: 'memory'
		readonly redis?: never
		readonly namespace?: string
		readonly onBackendError?: never
	})
	| (CustomRateLimitCommon & {
		readonly backend: 'redis'
		readonly redis: RedisScriptPort
		readonly namespace: string
		readonly onBackendError: BackendErrorPolicy
	})

export function createCustomRateLimit(options: CustomRateLimitOptions): ManagedRateLimit {
	const resolved = snapshotRateLimitOptions<CustomRateLimitOptions>(options, new Set([
		'backend', 'redis', 'namespace', 'policies', 'onBackendError', 'operationTimeoutMs', 'shutdownTimeoutMs', 'clock', 'lifecycle'
	]), 'Custom rate limit')
	const backend = resolved.backend ?? 'memory'
	if (backend === 'memory' && ('redis' in resolved && resolved.redis !== undefined || 'onBackendError' in resolved && resolved.onBackendError !== undefined)) {
		throw new TypeError('Custom memory rate limit does not accept Redis options')
	}
	if (backend === 'redis' && (!resolved.redis || !resolved.onBackendError)) {
		throw new TypeError('Custom Redis rate limit requires redis and onBackendError')
	}
	const onBackendError: BackendErrorPolicy = backend === 'redis'
		? resolved.onBackendError as BackendErrorPolicy
		: 'allow'
	const redis = backend === 'redis' ? bindRateLimitRedis(resolved.redis!) : undefined
	let fixed: ReturnType<typeof createFixedWindowEngine> | undefined
	return createManagedRateLimit({
		backend,
		createEngine: (policy, clock) => policy.algorithm === 'fixed-window'
			? fixed ??= createFixedWindowEngine({clock, ...(redis ? {redis} : {})})
			: redis
				? {...createRedisTokenBucket({clock, redis, capacity: policy.capacity}), type: 'redis'}
				: {...createMemoryTokenBucket({clock, capacity: policy.capacity}), type: 'memory'},
		clock: resolved.clock ?? createSystemClock(),
		policies: resolved.policies,
		onBackendError,
		...(resolved.namespace ? {namespace: resolved.namespace} : {}),
		...(resolved.operationTimeoutMs !== undefined ? {operationTimeoutMs: resolved.operationTimeoutMs} : {}),
		...(resolved.shutdownTimeoutMs !== undefined ? {shutdownTimeoutMs: resolved.shutdownTimeoutMs} : {}),
		...(resolved.lifecycle ? {lifecycle: resolved.lifecycle} : {})
	})
}

export type {BackendErrorPolicy, ManagedRateLimit, RateLimitPolicyDefinition}
