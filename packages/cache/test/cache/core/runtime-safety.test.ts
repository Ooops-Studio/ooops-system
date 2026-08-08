import {afterEach, describe, expect, it, vi} from 'vitest'

import {
	advanceCacheTimestamp,
	isCacheEntryMetadata,
	projectCacheEntryMetadata,
	projectCacheStoredEntry
} from '../../../src/cache/core/runtime-metadata'
import {
	addCacheBatchBytes,
	assertCacheBatchSize,
	assertCacheBatchBytes,
	createBatchFlightKey,
	readCacheTimestamp,
	resolveCacheStorageKey,
	snapshotCacheMap,
	validateCacheComponent,
	validateCacheDuration,
	withCacheTimeout
} from '../../../src/cache/core/runtime-safety'
import {decodeCacheValue, encodeCacheValue} from '../../../src/cache/core/runtime-serialization'

afterEach(() => vi.useRealTimers())

describe('cache runtime safety', () => {
	it('builds collision-safe storage and bounded batch-flight keys', () => {
		expect(resolveCacheStorageKey('a', 'b', 'c:d')).not.toBe(resolveCacheStorageKey('a:b', 'c', 'd'))
		const first = createBatchFlightKey('namespace', 'v1', ['a', 'b'])
		const second = createBatchFlightKey('namespace', 'v1', ['b', 'a'])
		expect(first).toBe(second)
		expect(first).toMatch(/^cache:batch:[a-f0-9]{32}$/u)
		expect(first.length).toBe(44)
		expect(createBatchFlightKey('other-namespace', 'v1', ['a', 'b'])).not.toBe(first)
		expect(createBatchFlightKey('namespace', 'v2', ['a', 'b'])).not.toBe(first)
		expect(createBatchFlightKey('x'.repeat(256), 'y'.repeat(256), ['z'.repeat(256)])).toHaveLength(44)
	})

	it('rejects invalid components, durations, and oversized batches', () => {
		expect(() => validateCacheComponent(1 as never, 'key')).toThrow('must be a string')
		expect(() => validateCacheComponent('\ud800', 'key')).toThrow('invalid Unicode')
		expect(() => validateCacheComponent('\udc00', 'key')).toThrow('invalid Unicode')
		expect(() => validateCacheComponent('bad\nkey', 'key')).toThrow('safe characters')
		expect(() => validateCacheDuration(1.5, 'ttl')).toThrow('milliseconds')
		expect(() => assertCacheBatchSize(1_001, 'batch')).toThrow('at most 1000')
		expect(() => assertCacheBatchSize(-1, 'batch')).toThrow('non-negative safe integer')
		expect(() => assertCacheBatchBytes([8 * 1024 * 1024, (8 * 1024 * 1024) + 1], 'batch'))
			.toThrow('16777216-byte batch limit')
		expect(() => assertCacheBatchBytes([Number.NaN], 'batch')).toThrow('invalid serialized entry size')
		expect(addCacheBatchBytes(0, 10, 'batch')).toBe(10)
		expect(() => addCacheBatchBytes(Number.NaN, 1, 'batch')).toThrow('invalid serialized entry size')
		expect(() => createBatchFlightKey('namespace', 'v1', Array.from({length: 1_001}, (_, index) => String(index))))
			.toThrow('at most 1000')
		expect(() => advanceCacheTimestamp(Number.MAX_SAFE_INTEGER, 1)).toThrow('safe integer range')
		expect(() => readCacheTimestamp({now: () => Number.NaN})).toThrow('safe integer timestamp')
		expect(() => readCacheTimestamp({now: () => -1})).toThrow('safe integer timestamp')
	})

	it('bounds finalization waits and clears timeout timers', async() => {
		vi.useFakeTimers()
		const pending = withCacheTimeout(new Promise<void>(() => undefined), 100, 'timed out')
		const rejection = expect(pending).rejects.toThrow('timed out')
		await vi.advanceTimersByTimeAsync(100)
		await rejection
		expect(vi.getTimerCount()).toBe(0)
	})

	it('round-trips JSON and rejects unsupported or oversized values', () => {
		expect(decodeCacheValue<{value: number}>(encodeCacheValue({value: 1}))).toEqual({value: 1})
		expect(() => encodeCacheValue(undefined)).toThrow('must not contain undefined')
		expect(() => encodeCacheValue({value: Number.NaN})).toThrow('finite numbers')
		expect(() => encodeCacheValue({value: undefined})).toThrow('must not contain undefined')
		expect(() => encodeCacheValue({value: 1n})).toThrow('bigint')
		expect(() => encodeCacheValue(new Map([['key', 'value']]))).toThrow('JSON objects and arrays')
		expect(() => encodeCacheValue(new Date())).toThrow('Date objects')
		expect(() => encodeCacheValue(new Array(1))).toThrow('sparse arrays')
		const withSymbol = {[Symbol('secret')]: 'value'}
		expect(() => encodeCacheValue(withSymbol)).toThrow('symbol keys')
		const customArray = [1] as number[] & {extra?: number}
		customArray.extra = 2
		expect(() => encodeCacheValue(customArray)).toThrow('custom properties')
		const hidden = {}
		Object.defineProperty(hidden, 'secret', {value: 1})
		expect(() => encodeCacheValue(hidden)).toThrow('non-enumerable')
		let getterCalls = 0
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() { getterCalls++; return 'secret' }
		})
		expect(() => encodeCacheValue(accessor)).toThrow('accessor properties')
		expect(getterCalls).toBe(0)
		let deep: Record<string, unknown> = {}
		for (let index = 0; index < 66; index++) deep = {child: deep}
		expect(() => encodeCacheValue(deep)).toThrow('depth limit')
		const deepJson = `${'{"child":'.repeat(66)}null${'}'.repeat(66)}`
		expect(() => decodeCacheValue(new TextEncoder().encode(deepJson))).toThrow('depth limit')
		expect(() => decodeCacheValue(new Uint8Array((2 * 1024 * 1024) + 1))).toThrow('byte limit')
		expect(() => decodeCacheValue(new Uint8Array([34, 0xff, 34]))).toThrow()
		expect(() => encodeCacheValue('x'.repeat(2 * 1024 * 1024))).toThrow('byte limit')
		expect(() => encodeCacheValue(Array.from({length: 90_000}, () => 'x'.repeat(24))))
			.toThrow('byte limit')
		expect(() => encodeCacheValue('\u0000'.repeat(400_000))).toThrow('byte limit')
		const circular: {self?: unknown} = {}
		circular.self = circular
		expect(() => encodeCacheValue(circular)).toThrow()
	})

	it('serializes the validated data-property snapshot instead of re-reading hostile proxies', () => {
		let valueReads = 0
		const source = new Proxy({value: 1}, {
			get(target, property, receiver) {
				if (property === 'value') {
					valueReads++
					return new Date('2024-01-01T00:00:00.000Z')
				}
				return Reflect.get(target, property, receiver)
			}
		})
		expect(decodeCacheValue(encodeCacheValue(source))).toEqual({value: 1})
		expect(valueReads).toBe(0)

		let lengthReads = 0
		const array = new Proxy([1, 2], {
			get(target, property, receiver) {
				if (property === 'length') lengthReads++
				return Reflect.get(target, property, receiver)
			}
		})
		expect(decodeCacheValue(encodeCacheValue(array))).toEqual([1, 2])
		expect(lengthReads).toBe(0)
	})

	it('snapshots mutable backend entries at the runtime boundary', () => {
		const value = Buffer.from([1])
		const metadata = {
			key: 'key', namespace: 'default', version: 'v1',
			createdAt: 0, negative: false, sizeBytes: 1
		}
		const projected = projectCacheStoredEntry({value, metadata})!
		value[0] = 2
		metadata.key = 'mutated'
		expect(projected).toEqual({value: new Uint8Array([1]), metadata: expect.objectContaining({key: 'key'})})
	})

	it('uses one authoritative descriptor snapshot for hostile backend metadata and entries', () => {
		const target = {
			key: 'key', namespace: 'default', version: 'v1',
			createdAt: 0, negative: false, sizeBytes: 1
		}
		let metadataGets = 0
		let metadataOwnKeys = 0
		const metadata = new Proxy(target, {
			get(object, property, receiver) {
				metadataGets++
				if (property === 'key') return 'mutated'
				return Reflect.get(object, property, receiver)
			},
			ownKeys(object) { metadataOwnKeys++; return Reflect.ownKeys(object) }
		})
		expect(projectCacheEntryMetadata(metadata)).toEqual(target)
		expect(metadataGets).toBe(0)
		expect(metadataOwnKeys).toBe(1)

		let entryOwnKeys = 0
		const entry = new Proxy({value: new Uint8Array([1]), metadata}, {
			ownKeys(object) { entryOwnKeys++; return Reflect.ownKeys(object) }
		})
		expect(projectCacheStoredEntry(entry)).toEqual({value: new Uint8Array([1]), metadata: target})
		expect(entryOwnKeys).toBe(1)
		expect(metadataGets).toBe(0)
	})

	it('rejects oversized Maps before cloning their entries', () => {
		const oversized = new Map(Array.from({length: 1_001}, (_, index) => [String(index), index]))
		const entries = vi.spyOn(Map.prototype, 'entries')
		expect(snapshotCacheMap(oversized)).toBeUndefined()
		expect(entries).not.toHaveBeenCalled()
		entries.mockRestore()
		expect(snapshotCacheMap(new Map([['key', 1]]))).toEqual(new Map([['key', 1]]))
		expect(snapshotCacheMap(new Map(), -1)).toBeUndefined()
	})

	it('rejects permanent or stale-window negative-cache metadata', () => {
		const base = {
			key: 'key', namespace: 'default', version: 'v1',
			createdAt: 0, negative: true, sizeBytes: 1
		}
		expect(isCacheEntryMetadata(base)).toBe(false)
		expect(isCacheEntryMetadata({
			...base, staleAt: 10, expiresAt: 20
		})).toBe(false)
		expect(isCacheEntryMetadata({
			...base, staleAt: 10, expiresAt: 10
		})).toBe(true)
		expect(isCacheEntryMetadata({...base, createdAt: Number.MAX_SAFE_INTEGER + 1})).toBe(false)
	})

	it('rejects unsafe or malformed Unicode metadata components', () => {
		const metadata = {
			key: 'key', namespace: 'default', version: 'v1',
			createdAt: 0, negative: false, sizeBytes: 1
		}
		expect(isCacheEntryMetadata({...metadata, key: 'bad\nkey'})).toBe(false)
		expect(isCacheEntryMetadata({...metadata, namespace: '\ud800'})).toBe(false)
		expect(isCacheEntryMetadata({...metadata, version: 'bad\u007fversion'})).toBe(false)
	})
})
