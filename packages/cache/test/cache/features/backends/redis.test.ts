import type {CacheEntryMetadata} from '@ooopsstudio/core/contracts/cache'
import {describe, expect, it, vi} from 'vitest'

import {createRedisCacheBackend} from '../../../../src/cache/features/backends/redis'
import {
	redisCacheDeleteManyScript,
	redisCacheGetManyBoundedScript,
	redisCacheListKeysScript,
	redisCacheSetManyScript
} from '../../../../src/cache/features/backends/redis-scripts'

const metadata: CacheEntryMetadata = {
	key: 'key', namespace: 'app', version: 'v1', createdAt: 0,
	negative: false, sizeBytes: 1
}

describe('Redis cache backend', () => {
	it('captures the eval capability once and validates credential-free construction inputs', async() => {
		const evaluate = vi.fn(async() => [])
		const redis = {eval: evaluate}
		const backend = createRedisCacheBackend({clock: {now: () => 0}, redis, keyPrefix: 'app'})
		redis.eval = vi.fn(async() => { throw new Error('replacement') })
		await expect(backend.getMany([])).resolves.toEqual(new Map())
		expect(redis.eval).not.toHaveBeenCalled()
		expect(() => createRedisCacheBackend({clock: {now: () => 0}, redis: {} as never})).toThrow('eval() primitive')
		expect(() => createRedisCacheBackend({
			clock: {now: () => 0}, redis: {eval: vi.fn()}, unexpected: true
		} as never)).toThrow('unexpected fields')
	})

	it('uses bounded atomic Lua paths and contains no renewal script', () => {
		expect(redisCacheSetManyScript).toContain('redis.call')
		expect(redisCacheDeleteManyScript).toContain('redis.call')
		expect(redisCacheGetManyBoundedScript).toContain('remainingBytes')
		expect(redisCacheListKeysScript).toContain('ZSCAN')
		expect(redisCacheListKeysScript).not.toContain('ZRANGE')
		expect(JSON.stringify([
			redisCacheSetManyScript, redisCacheDeleteManyScript, redisCacheGetManyBoundedScript
		])).not.toMatch(/renew|revision|sliding/u)
	})

	it('short-circuits empty batch and invalidation operations without transport calls', async() => {
		const evaluate = vi.fn(async() => { throw new Error('must not run') })
		const backend = createRedisCacheBackend({clock: {now: () => 0}, redis: {eval: evaluate}})
		expect(await backend.getMany([])).toEqual(new Map())
		await expect(backend.setMany([])).resolves.toBeUndefined()
		expect(await backend.delete([])).toBe(0)
		expect(await backend.invalidate({keys: []})).toBe(0)
		expect(evaluate).not.toHaveBeenCalled()
	})

	it('rejects malformed transport results and invalid metadata', async() => {
		const evaluate = vi.fn(async(script: string) => {
			if (script === redisCacheSetManyScript) return 'invalid'
			return []
		})
		const backend = createRedisCacheBackend({clock: {now: () => 0}, redis: {eval: evaluate}})
		await expect(backend.set('key', new Uint8Array([1]), metadata)).rejects.toThrow('CACHE_REDIS_RESULT_INVALID')
		await expect(backend.set('key', new Uint8Array([1]), {...metadata, sizeBytes: 2})).rejects.toThrow()
	})

	it('has idempotent transport finalization without claiming Redis ownership', async() => {
		const backend = createRedisCacheBackend({clock: {now: () => 0}, redis: {eval: vi.fn(async() => [])}})
		await backend.shutdown?.()
		await backend.shutdown?.()
	})
})
