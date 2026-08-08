import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it} from 'vitest'

import {createCacheHandler} from '../../../src/cache/core/handler'
import {createMemoryCacheBackend} from '../../../src/cache/features/backends/memory'

type ReferenceEntry = {value: number; expiresAt?: number}

function createRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		return state >>> 0
	}
}

describe('cache model conformance', () => {
	it('matches a deterministic reference model across mixed CRUD, batches, TTL and invalidation', async() => {
		const clock = createFixedClock(0)
		const cache = createCacheHandler({
			clock,
			backend: createMemoryCacheBackend({clock, maxEntries: 10_000, maxBytes: 8 * 1024 * 1024})
		})
		const random = createRandom(0x5eed_cace)
		const namespaces = ['alpha', 'beta', 'gamma'] as const
		const versions = ['v1', 'v2'] as const
		const keys = Array.from({length: 12}, (_, index) => `key-${index}`)
		const reference = new Map<string, ReferenceEntry>()
		const identity = (namespace: string, version: string, key: string): string => `${namespace}:${version}:${key}`
		const readReference = (namespace: string, version: string, key: string): number | undefined => {
			const id = identity(namespace, version, key)
			const entry = reference.get(id)
			if (entry?.expiresAt !== undefined && entry.expiresAt <= clock.now()) {
				reference.delete(id)
				return undefined
			}
			return entry?.value
		}

		for (let step = 0; step < 750; step++) {
			const namespace = namespaces[random() % namespaces.length]!
			const version = versions[random() % versions.length]!
			const key = keys[random() % keys.length]!
			const operation = random() % 7
			if (operation === 0) {
				const ttl = [undefined, 1, 5, 20][random() % 4]
				const value = random()
				await cache.set(key, value, {namespace, version, ...(ttl === undefined ? {} : {ttlMs: ttl})})
				reference.set(identity(namespace, version, key), {
					value,
					...(ttl === undefined ? {} : {expiresAt: clock.now() + ttl})
				})
			} else if (operation === 1) {
				await expect(cache.get<number>(key, {namespace, version}))
					.resolves.toBe(readReference(namespace, version, key))
			} else if (operation === 2) {
				await cache.delete(key, {namespace, version})
				reference.delete(identity(namespace, version, key))
			} else if (operation === 3) {
				const includeVersion = (random() & 1) === 1
				await cache.invalidate({namespace, ...(includeVersion ? {version} : {})})
				for (const id of reference.keys()) {
					if (id.startsWith(`${namespace}:${includeVersion ? `${version}:` : ''}`)) reference.delete(id)
				}
			} else if (operation === 4) {
				clock.advanceBy(random() % 6)
			} else if (operation === 5) {
				const batchKeys = Array.from({length: 1 + (random() % 4)}, () => keys[random() % keys.length]!)
				const expected = new Map<string, number>()
				for (const itemKey of new Set(batchKeys)) {
					const value = readReference(namespace, version, itemKey)
					if (value !== undefined) expected.set(itemKey, value)
				}
				await expect(cache.getMany<number>(batchKeys, {namespace, version})).resolves.toEqual(expected)
			} else {
				const batch = Array.from({length: 1 + (random() % 4)}, () => ({
					key: keys[random() % keys.length]!,
					value: random()
				}))
				await cache.setMany(batch, {namespace, version})
				for (const item of batch) reference.set(identity(namespace, version, item.key), {value: item.value})
			}
		}

		for (const namespace of namespaces) for (const version of versions) for (const key of keys) {
			await expect(cache.get<number>(key, {namespace, version}))
				.resolves.toBe(readReference(namespace, version, key))
		}
		await cache.shutdown()
	})
})
