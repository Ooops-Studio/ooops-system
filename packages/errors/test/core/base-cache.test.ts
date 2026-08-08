import {describe, it, expect, vi} from 'vitest'

import {BaseCache, type BaseCacheEntry} from '../../src/core/base-cache'
import type {CachePort} from '../../src/types/ports'

// Test implementation of BaseCache
class TestCache extends BaseCache<BaseCacheEntry> {
	protected serializeEntry(entry: BaseCacheEntry): string {
		return JSON.stringify(entry)
	}

	protected deserializeEntry(value: string): BaseCacheEntry | null {
		try {
			const parsed = JSON.parse(value)
			if (typeof parsed.timestamp === 'number') {
				return {
					timestamp: parsed.timestamp,
					lastAccess: parsed.lastAccess ?? parsed.timestamp
				}
			}
		} catch {
			// Invalid JSON
		}
		return null
	}

	// Expose protected methods for testing
	async testGetEntry(key: string) {
		return this.getEntry(key)
	}

	async testSetEntry(key: string, entry: BaseCacheEntry) {
		return this.setEntry(key, entry)
	}
}

describe('base-cache', () => {
	describe('BaseCache', () => {
		it('should create cache instance', () => {
			const cache = new TestCache({ttl: 1000})
			expect(cache).toBeDefined()
		})

		it('should use default maxCacheSize', () => {
			const cache = new TestCache({ttl: 1000})
			// Default is 1000
			expect(cache).toBeDefined()
		})

		it('should use custom maxCacheSize', () => {
			const cache = new TestCache({ttl: 1000, maxCacheSize: 500})
			expect(cache).toBeDefined()
		})

		it('rejects cache capacities that exceed the supported resident bound', () => {
			expect(() => new TestCache({ttl: 1000, maxCacheSize: 100_001}))
				.toThrow('between 1 and 100000')
		})

		it('captures external cache capabilities against late rewiring', async() => {
			const originalGet = vi.fn(async() => JSON.stringify({timestamp: 1, lastAccess: 1}))
			const port = {get: originalGet}
			const cache = new TestCache({ttl: 1000, cache: port})
			port.get = vi.fn(async() => { throw new Error('rewired') })

			await expect(cache.testGetEntry('stable')).resolves.toMatchObject({timestamp: 1})
			expect(originalGet).toHaveBeenCalledOnce()
		})

		it('should clear expired entries', () => {
			const cache = new TestCache({ttl: 1000})
			const now = Date.now()

			// Add expired entry
			cache['cache'].set('expired', {
				timestamp: now - 2000,
				lastAccess: now - 2000
			})

			// Add valid entry
			cache['cache'].set('valid', {
				timestamp: now - 500,
				lastAccess: now - 500
			})

			cache.clearExpired()

			expect(cache['cache'].has('expired')).toBe(false)
			expect(cache['cache'].has('valid')).toBe(true)
		})

		it('should evict LRU entries when full', () => {
			const cache = new TestCache({ttl: 1000, maxCacheSize: 10})
			const now = Date.now()

			// Fill cache to capacity
			for (let i = 0; i < 10; i++) {
				cache['cache'].set(`key${i}`, {
					timestamp: now,
					lastAccess: now + i // Different access times
				})
			}

			// Add one more to trigger eviction
			cache['cache'].set('newkey', {
				timestamp: now,
				lastAccess: now + 100
			})

			cache['evictLRU']()

			// Should have evicted 10% (1 entry) - oldest access time
			expect(cache['cache'].size).toBeLessThanOrEqual(10)
		})

		it('should not evict when under capacity', () => {
			const cache = new TestCache({ttl: 1000, maxCacheSize: 10})
			const now = Date.now()

			cache['cache'].set('key1', {
				timestamp: now,
				lastAccess: now
			})

			const sizeBefore = cache['cache'].size
			cache['evictLRU']()
			const sizeAfter = cache['cache'].size

			expect(sizeAfter).toBe(sizeBefore)
		})

		it('should clear all entries', async() => {
			const cache = new TestCache({ttl: 1000})
			const now = Date.now()

			cache['cache'].set('key1', {
				timestamp: now,
				lastAccess: now
			})
			cache['cache'].set('key2', {
				timestamp: now,
				lastAccess: now
			})

			await cache.clear()

			expect(cache['cache'].size).toBe(0)
		})

		it('should get entry from in-memory cache', async() => {
			const cache = new TestCache({ttl: 1000})
			const now = Date.now()
			const entry: BaseCacheEntry = {
				timestamp: now,
				lastAccess: now
			}

			cache['cache'].set('key1', entry)

			const result = await cache.testGetEntry('key1')

			expect(result).toEqual(entry)
		})

		it('should get entry from external cache', async() => {
			const mockCachePort: CachePort = {
				get: vi.fn().mockResolvedValue(JSON.stringify({
					timestamp: 1000,
					lastAccess: 1000
				}))
			}

			const cache = new TestCache({ttl: 1000, cache: mockCachePort})

			const result = await cache.testGetEntry('key1')

			expect(result).toEqual({
				timestamp: 1000,
				lastAccess: 1000
			})
			expect(mockCachePort.get).toHaveBeenCalledWith('key1')
		})

		it('should sync external cache entry to in-memory', async() => {
			const mockCachePort: CachePort = {
				get: vi.fn().mockResolvedValue(JSON.stringify({
					timestamp: 1000,
					lastAccess: 1000
				}))
			}

			const cache = new TestCache({ttl: 1000, cache: mockCachePort})

			await cache.testGetEntry('key1')

			// Should be in in-memory cache now
			expect(cache['cache'].has('key1')).toBe(true)
		})

		it('should handle external cache errors gracefully', async() => {
			const mockCachePort: CachePort = {
				get: vi.fn().mockRejectedValue(new Error('Cache error'))
			}

			const cache = new TestCache({ttl: 1000, cache: mockCachePort})

			const result = await cache.testGetEntry('key1')

			expect(result).toBeUndefined()
		})

		it('should set entry in both caches', async() => {
			const mockCachePort: CachePort = {
				set: vi.fn().mockResolvedValue(undefined)
			}

			const cache = new TestCache({ttl: 1000, cache: mockCachePort})
			const now = Date.now()
			const entry: BaseCacheEntry = {
				timestamp: now,
				lastAccess: now
			}

			await cache.testSetEntry('key1', entry)

			expect(cache['cache'].get('key1')).toEqual(entry)
			expect(mockCachePort.set).toHaveBeenCalledWith('key1', expect.any(String), 1000)
		})

		it('should handle external cache set errors gracefully', async() => {
			const mockCachePort: CachePort = {
				set: vi.fn().mockRejectedValue(new Error('Cache error'))
			}

			const cache = new TestCache({ttl: 1000, cache: mockCachePort})
			const now = Date.now()
			const entry: BaseCacheEntry = {
				timestamp: now,
				lastAccess: now
			}

			// Should not throw
			await expect(cache.testSetEntry('key1', entry)).resolves.toBeUndefined()
			expect(cache['cache'].has('key1')).toBe(true)
		})

		it('should destroy cache', async() => {
			const cache = new TestCache({ttl: 1000})
			const now = Date.now()

			cache['cache'].set('key1', {
				timestamp: now,
				lastAccess: now
			})

			await cache.destroy()

			expect(cache['cache'].size).toBe(0)
		})

		it('does not repopulate from an external read that settles after destroy', async() => {
			let release!: (value: string) => void
			const external = new Promise<string>((resolve) => { release = resolve })
			const cache = new TestCache({
				ttl: 1000,
				cache: {get: async() => await external}
			})
			const pending = cache.testGetEntry('late')
			await Promise.resolve()

			await cache.destroy()
			release(JSON.stringify({timestamp: 1, lastAccess: 1}))

			await expect(pending).resolves.toBeUndefined()
			expect(cache['cache'].size).toBe(0)
		})

		it('should handle invalid deserialized entry', async() => {
			const mockCachePort: CachePort = {
				get: vi.fn().mockResolvedValue('invalid json')
			}

			const cache = new TestCache({ttl: 1000, cache: mockCachePort})

			const result = await cache.testGetEntry('key1')

			expect(result).toBeUndefined()
		})

		it('should evict at least 1 entry when at capacity', () => {
			const cache = new TestCache({ttl: 1000, maxCacheSize: 5})
			const now = Date.now()

			// Fill exactly to capacity
			for (let i = 0; i < 5; i++) {
				cache['cache'].set(`key${i}`, {
					timestamp: now,
					lastAccess: now + i
				})
			}

			// Add one more
			cache['cache'].set('newkey', {
				timestamp: now,
				lastAccess: now + 100
			})

			cache['evictLRU']()

			// Should have evicted at least 1 (10% of 6 = 0.6, floored to 1)
			expect(cache['cache'].size).toBeLessThanOrEqual(5)
		})
	})
})
