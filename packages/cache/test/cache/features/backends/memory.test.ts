import type {CacheEntryMetadata} from '@ooopsstudio/core/contracts/cache'
import {describe, expect, it, vi} from 'vitest'

import {createMemoryCacheBackend} from '../../../../src/cache/features/backends/memory'

const metadata = (overrides: Partial<CacheEntryMetadata> = {}): CacheEntryMetadata => ({
	key: 'key', namespace: 'app', version: 'v1', createdAt: 0,
	negative: false, sizeBytes: 1, ...overrides
})

describe('memory cache backend', () => {
	it('supports fixed-TTL CRUD, batches and filtered invalidation', async() => {
		let now = 0
		const backend = createMemoryCacheBackend({clock: {now: () => now}})
		await backend.set('a', new Uint8Array([1]), metadata({key: 'a', staleAt: 10, expiresAt: 20}))
		await backend.setMany([
			{key: 'b', value: new Uint8Array([2]), metadata: metadata({key: 'b'})},
			{key: 'other', value: new Uint8Array([3]), metadata: metadata({key: 'other', namespace: 'other'})}
		])
		expect((await backend.getMany(['a', 'b'])).size).toBe(2)
		now = 11
		expect(await backend.get('a')).toBeUndefined()
		expect(await backend.get('a', {allowStale: true})).toBeDefined()
		expect(await backend.invalidate({namespace: 'app'})).toBe(2)
		expect(await backend.get('other')).toBeDefined()
	})

	it('enforces entry count and byte bounds with deterministic LRU eviction', async() => {
		const backend = createMemoryCacheBackend({clock: {now: () => 0}, maxEntries: 2, maxBytes: 3})
		await backend.set('a', new Uint8Array([1]), metadata({key: 'a'}))
		await backend.set('b', new Uint8Array([2]), metadata({key: 'b'}))
		await backend.get('a')
		await backend.set('c', new Uint8Array([3]), metadata({key: 'c'}))
		expect(await backend.get('b')).toBeUndefined()
		expect(await backend.get('a')).toBeDefined()
		expect(() => createMemoryCacheBackend({clock: {now: () => 0}, maxEntries: 0})).toThrow('positive')
	})

	it('snapshots values and metadata and validates negative entries', async() => {
		const backend = createMemoryCacheBackend({clock: {now: () => 0}})
		const value = new Uint8Array([1])
		const meta = metadata()
		await backend.set('key', value, meta)
		value[0] = 9
		expect((await backend.get('key'))?.value).toEqual(new Uint8Array([1]))
		await expect(backend.set('negative', new Uint8Array([1]), metadata({
			key: 'negative', negative: true, sizeBytes: 1, staleAt: 10, expiresAt: 10
		}))).rejects.toThrow('negative value')
	})

	it('uses unref only for the autonomous sweep and closes idempotently', async() => {
		vi.useFakeTimers()
		const backend = createMemoryCacheBackend({clock: {now: () => 0}, sweepIntervalMs: 10})
		expect(vi.getTimerCount()).toBe(1)
		await backend.shutdown?.()
		await backend.shutdown?.()
		expect(vi.getTimerCount()).toBe(0)
		await expect(backend.get('key')).rejects.toThrow('shut down')
		vi.useRealTimers()
	})

	it('rejects hostile metadata accessors without invoking them', async() => {
		const backend = createMemoryCacheBackend({clock: {now: () => 0}})
		const getter = vi.fn(() => 'secret')
		const hostile = Object.defineProperty({}, 'key', {enumerable: true, get: getter})
		await expect(backend.set('key', new Uint8Array([1]), hostile as never)).rejects.toThrow('metadata')
		expect(getter).not.toHaveBeenCalled()
	})
})
