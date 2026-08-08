import {describe, it, expect, vi} from 'vitest'

import {createErrorDeduplicationCache} from '../../src/core/deduplication-cache'
import type {CachePort} from '../../src/types/ports'

describe('error-deduplication-cache', () => {
	describe('createErrorDeduplicationCache', () => {
		it('should create cache instance', () => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			expect(cache).toBeDefined()
		})

		it('should use default frequencyThreshold', () => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			expect(cache).toBeDefined()
		})

		it('should use custom frequencyThreshold', () => {
			const cache = createErrorDeduplicationCache({ttl: 1000, frequencyThreshold: 5})
			expect(cache).toBeDefined()
		})

		it('rejects invalid capacity, TTL, clock, observer, and frequency configuration', () => {
			expect(() => createErrorDeduplicationCache({ttl: 0})).toThrow('ttl')
			expect(() => createErrorDeduplicationCache({ttl: 1, maxCacheSize: 0})).toThrow('maxCacheSize')
			expect(() => createErrorDeduplicationCache({ttl: 1, frequencyThreshold: 0})).toThrow('frequencyThreshold')
			expect(() => createErrorDeduplicationCache({ttl: 1, now: true as never})).toThrow('now')
			expect(() => createErrorDeduplicationCache({ttl: 1, observe: true as never})).toThrow('observe')
		})
	})

	describe('ErrorDeduplicationCache', () => {
		it('should report new error', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			const result = await cache.shouldReport('key1', 'error', 'validation')

			expect(result).toBe(true)
		})

		it('should not report duplicate error', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			await cache.shouldReport('key1', 'error', 'validation')
			const result = await cache.shouldReport('key1', 'error', 'validation')

			expect(result).toBe(false)
		})

		it('does not evict an existing deduplication key when at capacity', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000, maxCacheSize: 1})
			expect(await cache.shouldReport('only-key', 'error', 'validation')).toBe(true)
			expect(await cache.shouldReport('only-key', 'error', 'validation')).toBe(false)
			expect(cache['cache'].has('only-key')).toBe(true)
		})

		it('enforces maxCacheSize for escalation-only insertions', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000, maxCacheSize: 5})
			for (let index = 0; index < 100; index++) {
				await cache.setEscalationMetadata(`escalation-${index}`, {
					timestamp: index, severity: 'error'
				})
			}

			expect(cache['cache'].size).toBeLessThanOrEqual(5)
			expect(cache['cache'].has('escalation-99')).toBe(true)
		})

		it('enforces maxCacheSize while hydrating external entries', async() => {
			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				maxCacheSize: 5,
				cache: {
					get: async() => JSON.stringify({
						timestamp: 1, count: 1, lastAccess: 1, weightedScore: 1
					})
				}
			})
			for (let index = 0; index < 100; index++) {
				await cache.getFrequency(`external-${index}`)
			}

			expect(cache['cache'].size).toBeLessThanOrEqual(5)
			expect(cache['cache'].has('external-99')).toBe(true)
		})

		it('atomically suppresses concurrent duplicates of the same key', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})

			const results = await Promise.all(Array.from({length: 20}, async() =>
				await cache.shouldReport('same', 'error', 'validation')
			))

			expect(results.filter(Boolean)).toHaveLength(1)
			expect((await cache.getFrequency('same'))?.count).toBe(20)
			expect(cache['keyOperations'].size).toBe(0)
		})

		it('bounds never-settling operations globally and fails open above capacity', async() => {
			let release!: () => void
			const gate = new Promise<void>((resolve) => { release = resolve })
			const get = vi.fn(async() => { await gate; return undefined })
			const cache = createErrorDeduplicationCache({ttl: 1000, cache: {get}})
			const accepted = Array.from({length: 1_000}, (_, index) =>
				cache.shouldReport(`key-${index}`, 'error', 'validation'))
			const overflow = cache.shouldReport('overflow', 'error', 'validation')

			await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1_000))
			await expect(overflow).resolves.toBe(true)
			release()
			await Promise.all(accepted)
			expect(cache['pendingOperations']).toBe(0)
		})

		it('bounds queued operations for one blocked key', async() => {
			let release!: () => void
			const gate = new Promise<void>((resolve) => { release = resolve })
			const get = vi.fn(async() => { await gate; return undefined })
			const cache = createErrorDeduplicationCache({ttl: 1000, cache: {get}})
			const accepted = Array.from({length: 64}, () =>
				cache.shouldReport('same-blocked-key', 'error', 'validation'))

			await expect(cache.shouldReport('same-blocked-key', 'error', 'validation'))
				.resolves.toBe(true)
			expect(cache['pendingByKey'].get('same-blocked-key')).toBe(64)
			release()
			await Promise.all(accepted)
			expect(cache['pendingByKey'].size).toBe(0)
		})

		it('retains at most one never-settling observer invocation', async() => {
			const observe = vi.fn(() => new Promise<void>(() => undefined))
			const cache = createErrorDeduplicationCache({ttl: 1000, frequencyThreshold: 1, observe})

			for (let index = 0; index < 100; index += 1) {
				await cache.shouldReport(`observed-${index}`, 'error', 'validation')
				await cache.shouldReport(`observed-${index}`, 'error', 'validation')
			}

			expect(observe).toHaveBeenCalledOnce()
		})

		it('should throttle after frequencyThreshold', async() => {
			const observe = vi.fn()
			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				frequencyThreshold: 3,
				observe
			})

			// Report 3 times (threshold)
			await cache.shouldReport('key1', 'error', 'validation')
			await cache.shouldReport('key1', 'error', 'validation')
			await cache.shouldReport('key1', 'error', 'validation') // Should trigger throttle

			expect(observe).toHaveBeenCalledWith('error:throttled', expect.objectContaining({
				kind: 'error',
				category: 'validation',
				key: 'key1',
				count: 3,
				threshold: 3
			}))
		})

		it('consumes asynchronous throttling observer failures', async() => {
			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				frequencyThreshold: 2,
				observe: async() => { throw new Error('observer unavailable') }
			})

			await cache.shouldReport('key1', 'error', 'validation')
			await cache.shouldReport('key1', 'error', 'validation')
			await new Promise((resolve) => setImmediate(resolve))
		})

		it('should not report when throttled', async() => {
			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				frequencyThreshold: 2
			})

			await cache.shouldReport('key1', 'error', 'validation')
			await cache.shouldReport('key1', 'error', 'validation') // Throttle
			const result = await cache.shouldReport('key1', 'error', 'validation')

			expect(result).toBe(false)
		})

		it('should reset throttling when entry expires', async() => {
			const cache = createErrorDeduplicationCache({
				ttl: 100,
				frequencyThreshold: 2
			})

			await cache.shouldReport('key1', 'error', 'validation')
			await cache.shouldReport('key1', 'error', 'validation') // Throttle

			// Manually expire the entry while it remains in the throttled set.
			const entry = cache['cache'].get('key1')
			if (entry) entry.timestamp = Date.now() - 200 // Expired

			// Should report again after expiration (entry is reset)
			const result = await cache.shouldReport('key1', 'error', 'validation')

			expect(result).toBe(true) // Should report again after expiration
		})

		it('should get frequency information', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			await cache.shouldReport('key1', 'error', 'validation')
			await cache.shouldReport('key1', 'error', 'validation')

			const frequency = await cache.getFrequency('key1')

			expect(frequency).toBeDefined()
			expect(frequency?.count).toBe(2)
			expect(typeof frequency?.timestamp).toBe('number')
		})

		it('should return undefined for non-existent key', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			const frequency = await cache.getFrequency('nonexistent')

			expect(frequency).toBeUndefined()
		})

		it('should get escalation metadata', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			await cache.setEscalationMetadata('key1', {
				timestamp: 1000,
				severity: 'error'
			})

			const escalation = await cache.getEscalationMetadata('key1')

			expect(escalation).toEqual({
				timestamp: 1000,
				severity: 'error'
			})
		})

		it('should set escalation metadata for existing entry', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			await cache.shouldReport('key1', 'error', 'validation')
			await cache.setEscalationMetadata('key1', {
				timestamp: 1000,
				severity: 'fatal'
			})

			const escalation = await cache.getEscalationMetadata('key1')

			expect(escalation?.severity).toBe('fatal')
		})

		it('should create new entry when setting escalation for non-existent key', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			await cache.setEscalationMetadata('key1', {
				timestamp: 1000,
				severity: 'warn'
			})

			const escalation = await cache.getEscalationMetadata('key1')
			expect(escalation).toBeDefined()

			const frequency = await cache.getFrequency('key1')
			expect(frequency?.count).toBe(1)
		})

		it('should handle observe callback errors gracefully', async() => {
			const observe = vi.fn().mockRejectedValue(new Error('Observe error'))
			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				frequencyThreshold: 2,
				observe
			})

			await cache.shouldReport('key1', 'error', 'validation')
			await cache.shouldReport('key1', 'error', 'validation') // Should trigger throttle

			// Should not throw
			expect(observe).toHaveBeenCalled()
		})

		it('should reset cache', () => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			cache['cache'].set('key1', {
				timestamp: 1000,
				count: 5,
				lastAccess: 1000,
				weightedScore: 5
			})
			cache['throttledKeys'].add('key1')

			cache.reset()

			expect(cache['cache'].size).toBe(0)
			expect(cache['throttledKeys'].size).toBe(0)
		})

		it('evicts auxiliary throttling state together with LRU entries', async() => {
			let now = 1
			const cache = createErrorDeduplicationCache({
				ttl: 1000, frequencyThreshold: 2, maxCacheSize: 2, now: () => now
			})
			await cache.shouldReport('old', 'error', 'validation')
			await cache.shouldReport('old', 'error', 'validation')
			now++
			await cache.shouldReport('newer', 'error', 'validation')

			await cache.shouldReport('trigger-eviction', 'error', 'validation')

			expect(cache['cache'].has('old')).toBe(false)
			expect(cache['throttledKeys'].has('old')).toBe(false)
			expect(cache['throttledKeys'].size).toBeLessThanOrEqual(cache['cache'].size)
		})

		it('clears expired entries and throttles with the configured clock', async() => {
			let now = 1
			const cache = createErrorDeduplicationCache({ttl: 10, frequencyThreshold: 2, now: () => now})
			await cache.shouldReport('key', 'error', 'validation')
			await cache.shouldReport('key', 'error', 'validation')
			now = 12

			cache.clearExpired()

			expect(cache['cache'].has('key')).toBe(false)
			expect(cache['throttledKeys'].has('key')).toBe(false)
		})

		it('expires entries at the exact TTL boundary and after clock rollback', async() => {
			let now = 100
			const cache = createErrorDeduplicationCache({ttl: 10, frequencyThreshold: 2, now: () => now})
			expect(await cache.shouldReport('exact', 'error', 'validation')).toBe(true)
			now = 110
			expect(await cache.shouldReport('exact', 'error', 'validation')).toBe(true)

			now = 200
			expect(await cache.shouldReport('rollback', 'error', 'validation')).toBe(true)
			now = 150
			expect(await cache.shouldReport('rollback', 'error', 'validation')).toBe(true)
		})

		it('falls back safely when the configured clock becomes invalid', async() => {
			const cache = createErrorDeduplicationCache({ttl: 10, now: () => Number.NaN})
			await expect(cache.shouldReport('invalid-clock', 'error', 'validation')).resolves.toBe(true)
			const frequency = await cache.getFrequency('invalid-clock')
			expect(frequency?.timestamp).toEqual(expect.any(Number))
			expect(Number.isSafeInteger(frequency?.timestamp)).toBe(true)
		})

		it('should increment count for throttled key', async() => {
			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				frequencyThreshold: 2
			})

			await cache.shouldReport('key1', 'error', 'validation')
			await cache.shouldReport('key1', 'error', 'validation') // Throttle

			// Should still increment count
			await cache.shouldReport('key1', 'error', 'validation')

			const frequency = await cache.getFrequency('key1')
			expect(frequency?.count).toBe(3)
		})

		it('saturates externally restored counts at the safe-integer boundary', async() => {
			const set = vi.fn()
			const cache = createErrorDeduplicationCache({
				ttl: 1_000,
				now: () => 100,
				cache: {
					get: vi.fn(async() => JSON.stringify({
						timestamp: 100, count: Number.MAX_SAFE_INTEGER,
						lastAccess: 100, weightedScore: Number.MAX_SAFE_INTEGER
					})),
					set
				} as never
			})

			await expect(cache.shouldReport('saturated', 'Error', 'UNKNOWN')).resolves.toBe(false)
			expect((await cache.getFrequency('saturated'))?.count).toBe(Number.MAX_SAFE_INTEGER)
			expect(JSON.parse(String(set.mock.calls[0]?.[1])).count).toBe(Number.MAX_SAFE_INTEGER)
		})

		it('should handle correlationId in observe callback', async() => {
			const observe = vi.fn()
			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				frequencyThreshold: 2,
				observe
			})

			await cache.shouldReport('key1', 'error', 'validation', 'corr-123')
			await cache.shouldReport('key1', 'error', 'validation', 'corr-123')

			expect(observe).toHaveBeenCalledWith('error:throttled', expect.objectContaining({
				correlationId: 'corr-123'
			}))
		})

		it('should handle external cache integration', async() => {
			const mockCachePort = {
				get: vi.fn().mockResolvedValue(JSON.stringify({
					timestamp: Date.now() - 500,
					count: 5,
					lastAccess: Date.now() - 500,
					weightedScore: 5
				})),
				set: vi.fn().mockResolvedValue(undefined)
			}

			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				cache: mockCachePort as CachePort
			})

			const result = await cache.shouldReport('key1', 'error', 'validation')

			expect(result).toBe(false) // Should be duplicate
			expect(mockCachePort.get).toHaveBeenCalledWith('key1')
		})

		it('should handle invalid external cache entry', async() => {
			const mockCachePort = {
				get: vi.fn().mockResolvedValue('invalid json'),
				set: vi.fn().mockResolvedValue(undefined)
			}

			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				cache: mockCachePort as CachePort
			})

			const result = await cache.shouldReport('key1', 'error', 'validation')

			expect(result).toBe(true) // Should treat as new entry
		})

		it('should handle external cache get error', async() => {
			const mockCachePort = {
				get: vi.fn().mockRejectedValue(new Error('Cache error')),
				set: vi.fn().mockResolvedValue(undefined)
			}

			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				cache: mockCachePort as CachePort
			})

			const result = await cache.shouldReport('key1', 'error', 'validation')

			expect(result).toBe(true) // Should fallback to new entry
		})

		it('should handle external cache set error', async() => {
			const mockCachePort = {
				get: vi.fn().mockResolvedValue(null),
				set: vi.fn().mockRejectedValue(new Error('Cache error'))
			}

			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				cache: mockCachePort as CachePort
			})

			// Should not throw
			await expect(cache.shouldReport('key1', 'error', 'validation')).resolves.toBe(true)
		})

		it('should calculate weighted score correctly', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			const now = Date.now()

			// Create entry with old timestamp
			cache['cache'].set('key1', {
				timestamp: now - 500,
				count: 10,
				lastAccess: now - 500,
				weightedScore: 10
			})

			await cache.shouldReport('key1', 'error', 'validation')

			const entry = cache['cache'].get('key1')
			expect(entry?.weightedScore).toBeLessThan(10) // Should decay
		})

		it('should handle entry without escalation metadata', async() => {
			const cache = createErrorDeduplicationCache({ttl: 1000})
			await cache.shouldReport('key1', 'error', 'validation')

			const escalation = await cache.getEscalationMetadata('key1')
			expect(escalation).toBeUndefined()
		})

		it('should handle setting escalation metadata when entry does not exist in cache but exists externally', async() => {
			const mockCachePort = {
				get: vi.fn().mockResolvedValue(JSON.stringify({
					timestamp: Date.now(),
					count: 5,
					lastAccess: Date.now(),
					weightedScore: 5
				})),
				set: vi.fn().mockResolvedValue(undefined)
			}

			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				cache: mockCachePort as CachePort
			})

			await cache.setEscalationMetadata('key1', {
				timestamp: 1000,
				severity: 'error'
			})

			const escalation = await cache.getEscalationMetadata('key1')
			expect(escalation).toBeDefined()
		})

		it('should handle entry with missing weightedScore in deserialized entry', async() => {
			const mockCachePort = {
				get: vi.fn().mockResolvedValue(JSON.stringify({
					timestamp: Date.now(),
					count: 5,
					lastAccess: Date.now()
					// Missing weightedScore
				})),
				set: vi.fn().mockResolvedValue(undefined)
			}

			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				cache: mockCachePort as CachePort
			})

			const result = await cache.shouldReport('key1', 'error', 'validation')

			// Should use count as weightedScore fallback
			expect(result).toBe(false)
		})

		it('should handle entry with missing lastAccess in deserialized entry', async() => {
			const mockCachePort = {
				get: vi.fn().mockResolvedValue(JSON.stringify({
					timestamp: Date.now(),
					count: 5,
					weightedScore: 5
					// Missing lastAccess
				})),
				set: vi.fn().mockResolvedValue(undefined)
			}

			const cache = createErrorDeduplicationCache({
				ttl: 1000,
				cache: mockCachePort as CachePort
			})

			const result = await cache.shouldReport('key1', 'error', 'validation')

			expect(result).toBe(false)
		})
	})
})
