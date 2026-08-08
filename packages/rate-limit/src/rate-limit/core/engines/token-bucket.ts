import type {Clock} from '@ooopsstudio/core/contracts/clock'

import type {RateLimitEngine} from '../../types/engine'
import {snapshotRateLimitClock} from '../time'

import {
	assertFiniteRefillDuration,
	assertNonNegativeFiniteCost,
	assertPositiveFiniteRefillRate,
	assertPositiveFiniteCost,
	assertPositiveFiniteRateLimitParameters,
	assertRepresentableMicrotokenAmount
} from './constants'
import {snapshotRedisScriptPort, type RedisScriptPort} from './redis-scripts'
import {createMemoryTokenBucket} from './token-bucket-memory'
import {createRedisTokenBucket} from './token-bucket-redis'

export interface TokenBucketEngineOptions {
	redis?: RedisScriptPort | undefined
	clock: Clock
	capacity?: number | undefined
	refillRate?: number | undefined
}

/** Selects a parity-tested memory or Redis token-bucket implementation. */
export function createTokenBucketEngine(options: TokenBucketEngineOptions): RateLimitEngine {
	const {redis: configuredRedis, capacity, refillRate} = options
	const clock = snapshotRateLimitClock(options.clock, 'token-bucket')
	const redis = configuredRedis ? snapshotRedisScriptPort(configuredRedis, 'Token-bucket') : undefined
	if (capacity !== undefined) assertRepresentableMicrotokenAmount(capacity, 'Token-bucket capacity')
	if (refillRate !== undefined) assertPositiveFiniteRefillRate(refillRate, 'Token-bucket refillRate')
	if (capacity !== undefined && refillRate !== undefined) {
		assertFiniteRefillDuration(capacity, refillRate, 'Token-bucket capacity and refillRate')
	}
	const implementation = redis
		? createRedisTokenBucket({
			redis,
			clock,
			...(capacity !== undefined ? {capacity} : {}),
			...(refillRate !== undefined ? {refillRate} : {})
		})
		: createMemoryTokenBucket({clock, ...(capacity !== undefined ? {capacity} : {}), ...(refillRate !== undefined ? {refillRate} : {})})
	const validate = (limit: number, windowMs: number, cost: number, allowZero = false): void => {
		assertPositiveFiniteRateLimitParameters(limit, windowMs)
		if (allowZero) assertNonNegativeFiniteCost(cost)
		else assertPositiveFiniteCost(cost)
		assertRepresentableMicrotokenAmount(limit, 'Token-bucket limit')
		assertRepresentableMicrotokenAmount(capacity ?? limit, 'Token-bucket capacity')
		assertRepresentableMicrotokenAmount(cost, 'Token-bucket cost', allowZero)
		const effectiveRate = refillRate ?? (limit / windowMs)
		assertPositiveFiniteRefillRate(effectiveRate, 'Token-bucket refillRate')
		assertFiniteRefillDuration(capacity ?? limit, effectiveRate, 'Token-bucket capacity and refillRate')
	}
	return {
		type: redis ? 'redis' : 'memory',
		async checkAndConsume(key, limit, windowMs, cost = 1) {
			validate(limit, windowMs, cost)
			return await implementation.checkAndConsume(key, limit, windowMs, cost)
		},
		async peek(key, limit, windowMs, cost = 1) {
			validate(limit, windowMs, cost, true)
			return await implementation.peek(key, limit, windowMs, cost)
		}
	}
}
