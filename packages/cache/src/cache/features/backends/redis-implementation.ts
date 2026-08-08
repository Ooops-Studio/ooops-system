import {isUtf8} from 'node:buffer'

import type {CacheEntryMetadata, CacheGetOptions, CacheInvalidateRequest} from '@ooopsstudio/core/contracts/cache'
import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CacheBackendPort, CacheRedisPort} from '@ooopsstudio/core/ports/cache'
import {snapshotDenseDataArray} from '@ooopsstudio/core/utils/validation'

import {bindCacheClock, bindCacheRedisPort} from '../../core/runtime-backend-binding'
import {projectCacheEntryMetadata} from '../../core/runtime-metadata'
import {createCacheMutationCoordinator} from '../../core/runtime-mutations'
import {
	addCacheBatchBytes,
	assertCacheBatchSize,
	MAX_CACHE_BATCH_BYTES,
	MAX_CACHE_ENTRY_BYTES,
	MAX_CACHE_STORAGE_KEY_CHARS,
	readCacheTimestamp,
	resolveCacheStorageKey,
	validateCacheComponent
} from '../../core/runtime-safety'

import {decodeRedisRecord, encodeRedisRecord, MAX_REDIS_RECORD_BYTES} from './redis-record'
import {
	redisCacheDeleteIfValuesScript,
	redisCacheDeleteManyScript,
	redisCacheGetManyBoundedScript,
	redisCacheListKeysScript,
	redisCacheSetManyScript
} from './redis-scripts'

export interface RedisCacheBackendOptions {
	clock: Clock
	redis: CacheRedisPort
	keyPrefix?: string
}

function snapshotRedisCacheBackendOptions(value: unknown): RedisCacheBackendOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Production cache Redis requires a clock')
	}
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const allowed = new Set(['clock', 'redis', 'keyPrefix'])
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
			throw new TypeError()
		}
		return Object.freeze({
			clock: descriptors.clock?.value as Clock,
			redis: descriptors.redis?.value as CacheRedisPort,
			...(descriptors.keyPrefix?.value !== undefined
				? {keyPrefix: descriptors.keyPrefix.value as string}
				: {})
		})
	} catch {
		throw new TypeError('Redis cache backend options contain invalid or unexpected fields')
	}
}

function projectGuardedDeleteResult(value: unknown, maximum: number): {
	removed: number
	deletedTotal: number
	retained: number
	missing: number
} | undefined {
	const result = snapshotDenseDataArray(value, 4)
	if (!result || result.length !== 4) return undefined
	const [removed, deletedTotal, retained, missing] = result
	if (![removed, deletedTotal, retained, missing].every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
		|| Number(removed) > Number(deletedTotal)
		|| Number(deletedTotal) + Number(retained) + Number(missing) !== maximum) return undefined
	return {
		removed: Number(removed),
		deletedTotal: Number(deletedTotal),
		retained: Number(retained),
		missing: Number(missing)
	}
}

export function createRedisCacheBackend(options: RedisCacheBackendOptions): CacheBackendPort {
	const snapshot = snapshotRedisCacheBackendOptions(options)
	const clock = bindCacheClock(snapshot.clock, 'Production cache Redis')
	const redis = bindCacheRedisPort(snapshot.redis)
	const prefix = snapshot.keyPrefix ?? 'cache:prod'
	// Production prefixes add a fixed "cache:" discriminator to a valid
	// 256-character application namespace, so the transport-level bound must
	// not reject a namespace already accepted by the service key model.
	validateCacheComponent(prefix, 'Redis cache keyPrefix', 512)
	// Preserve distinct application prefixes while retaining one Redis Cluster hash slot.
	const storagePrefix = `{${encodeURIComponent(prefix)}}`
	const registryKey = `${storagePrefix}:keys`
	const dataKey = (key: string): string => `${storagePrefix}:data:${key}`
	const projectRegistryKey = (value: unknown): string | undefined => {
		try {
			const key = typeof value === 'string' ? value
				: value instanceof Uint8Array && isUtf8(value) ? Buffer.from(value).toString() : undefined
			if (key && key.length <= MAX_CACHE_STORAGE_KEY_CHARS) return key
		} catch { /* invalid binary adapter value */ }
	}
	const registryCoordinator = createCacheMutationCoordinator()
	const invalidReadResult = (): never => {
		throw new Error('CACHE_REDIS_RESULT_INVALID')
	}
	const ttlFor = (metadata: CacheEntryMetadata): number => metadata.expiresAt === undefined
		? 0
		: Math.max(1, metadata.expiresAt - readCacheTimestamp(clock))
	const registryExpiry = (metadata: CacheEntryMetadata): number => metadata.expiresAt ?? Number.MAX_SAFE_INTEGER
	const recordMatchesStorageKey = (
		key: string,
		metadata: CacheEntryMetadata,
		expected?: CacheGetOptions
	): boolean => !expected?.namespace || !expected.version
		|| resolveCacheStorageKey(metadata.namespace, metadata.version, metadata.key) === key
	type BoundedRead =
		| {kind: 'missing' | 'oversized' | 'overflow'}
		| {kind: 'value'; raw: string | Uint8Array}
	const readManyBounded = async(keys: readonly string[], operation: string): Promise<BoundedRead[]> => {
		if (keys.length === 0) return []
		const wire = await redis.eval<unknown>(
			redisCacheGetManyBoundedScript,
			[registryKey, ...keys.map(dataKey)],
			[MAX_REDIS_RECORD_BYTES, MAX_CACHE_BATCH_BYTES, ...keys]
		)
		const result = snapshotDenseDataArray(wire, keys.length * 2)
		if (!result || result.length !== keys.length * 2) return invalidReadResult()
		const reads: BoundedRead[] = []
		let responseBytes = 0
		for (let index = 0; index < keys.length; index++) {
			const status = result[index * 2]
			const payload = result[(index * 2) + 1]
			if (!Number.isSafeInteger(status) || Number(status) < 0 || Number(status) > 3
				|| (typeof payload !== 'string' && !(payload instanceof Uint8Array))) {
				return invalidReadResult()
			}
			if (status === 1) {
				responseBytes = addCacheBatchBytes(
					responseBytes,
					typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength,
					`Redis cache ${operation}`
				)
				reads.push({kind: 'value', raw: payload})
				continue
			}
			if ((typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength) !== 0) {
				return invalidReadResult()
			}
			const kind = status === 0 ? 'missing' : status === 2 ? 'oversized' : 'overflow'
			reads.push({kind})
		}
		if (reads.some((read) => read.kind === 'overflow')) {
			throw new RangeError(`CACHE_REDIS_BATCH_LIMIT:${operation}:${MAX_CACHE_BATCH_BYTES}`)
		}
		return reads
	}
	const removeManyIfUnchanged = async(entries: ReadonlyArray<{key: string; raw: string | Uint8Array}>): Promise<void> => {
		if (entries.length === 0) return
		assertCacheBatchSize(entries.length, 'Redis cache corrupt-record cleanup')
		const args: Array<string | number | Uint8Array> = []
		for (const entry of entries) args.push(entry.key, entry.raw, 0)
		let result: unknown
		try {
			result = await redis.eval(
				redisCacheDeleteIfValuesScript,
				[registryKey, ...entries.map((entry) => dataKey(entry.key))],
				args
			)
		} catch { return }
		const projected = projectGuardedDeleteResult(result, entries.length)
		if (!projected || projected.removed !== 0) return
	}
	const removeIfUnchanged = async(key: string, raw: string | Uint8Array): Promise<void> =>
		await removeManyIfUnchanged([{key, raw}])
	const deleteMany = async(keys: readonly string[]): Promise<number> => {
		if (keys.length === 0) return 0
		const removed = await redis.eval<unknown>(
			redisCacheDeleteManyScript, [registryKey, ...keys.map(dataKey)], keys
		)
		if (typeof removed !== 'number' || !Number.isSafeInteger(removed) || removed < 0 || removed > keys.length) {
			throw new Error('CACHE_REDIS_RESULT_INVALID')
		}
		return removed
	}
	const read = async(
		key: string,
		getOptions?: CacheGetOptions & {allowStale?: boolean}
	): Promise<{value: Uint8Array; metadata: CacheEntryMetadata} | undefined> => {
		const bounded = (await readManyBounded([key], 'get'))[0]!
		if (bounded.kind === 'missing' || bounded.kind === 'oversized') return undefined
		if (bounded.kind !== 'value') return invalidReadResult()
		const raw = bounded.raw
		let record: {value: Uint8Array; metadata: CacheEntryMetadata}
		try {
			record = decodeRedisRecord(raw)
			if (!recordMatchesStorageKey(key, record.metadata, getOptions)) throw new Error()
		} catch {
			await removeIfUnchanged(key, raw); return undefined
		}
		const now = readCacheTimestamp(clock)
		if (record.metadata.expiresAt !== undefined && record.metadata.expiresAt <= now) {
			await removeIfUnchanged(key, raw); return undefined
		}
		const stale = record.metadata.staleAt !== undefined && record.metadata.staleAt <= now
		if (stale && !getOptions?.allowStale) return undefined
		return {value: record.value, metadata: record.metadata}
	}
	const backend: CacheBackendPort = {
		async get(key, getOptions) {
			return await registryCoordinator.run([key], () => read(key, getOptions))
		},
		async getMany(keys, getOptions) {
			return await registryCoordinator.run(keys, async() => {
				assertCacheBatchSize(keys.length, 'Redis cache getMany')
				const result = new Map<string, {value: Uint8Array; metadata: CacheEntryMetadata}>()
				if (keys.length === 0) return result
				const raw = await readManyBounded(keys, 'getMany')
				const corruptEntries: Array<{key: string; raw: string | Uint8Array}> = []
				for (let index = 0; index < keys.length; index++) {
					const key = keys[index]; const item = raw[index]
					if (!key || !item || item.kind === 'missing' || item.kind === 'oversized') continue
					if (item.kind !== 'value') return invalidReadResult()
					let record: {value: Uint8Array; metadata: CacheEntryMetadata}
					try {
						record = decodeRedisRecord(item.raw)
						if (!recordMatchesStorageKey(key, record.metadata, getOptions)) throw new Error()
					} catch {
						corruptEntries.push({key, raw: item.raw}); continue
					}
					const now = readCacheTimestamp(clock)
					if (record.metadata.expiresAt !== undefined && record.metadata.expiresAt <= now) {
						corruptEntries.push({key, raw: item.raw}); continue
					}
					const stale = record.metadata.staleAt !== undefined && record.metadata.staleAt <= now
					if (stale && !getOptions?.allowStale) continue
					result.set(key, {value: record.value, metadata: record.metadata})
				}
				await removeManyIfUnchanged(corruptEntries)
				return result
			})
		},
		async set(key, value, metadata) {
			await backend.setMany([{key, value, metadata}])
		},
		async setMany(entries) {
			return await registryCoordinator.run(entries.map((entry) => entry.key), async() => {
				assertCacheBatchSize(entries.length, 'Redis cache setMany')
				if (entries.length === 0) return
				if (entries.some((entry) => entry.value.byteLength > MAX_CACHE_ENTRY_BYTES)) {
					throw new RangeError('CACHE_REDIS_ENTRY_LIMIT')
				}
				const prepared = entries.map((entry) => {
					const metadata = projectCacheEntryMetadata(entry.metadata, entry.value.byteLength)
					if (!metadata) throw new Error('CACHE_REDIS_METADATA_INVALID')
					return {key: entry.key, value: new Uint8Array(entry.value), metadata}
				})
				// Validate complete wire records before invoking the atomic batch script.
				const records: string[] = []
				let recordBytes = 0
				for (const entry of prepared) {
					const record = encodeRedisRecord(entry.value, entry.metadata)
					recordBytes = addCacheBatchBytes(recordBytes, Buffer.byteLength(record), 'Redis cache setMany')
					records.push(record)
				}
				const args: Array<string | number> = [readCacheTimestamp(clock)]
				for (let index = 0; index < prepared.length; index++) {
					const entry = prepared[index]!
					args.push(records[index]!, ttlFor(entry.metadata), entry.key, registryExpiry(entry.metadata))
				}
				const written = await redis.eval<unknown>(
					redisCacheSetManyScript, [registryKey, ...prepared.map((entry) => dataKey(entry.key))], args
				)
				if (typeof written !== 'number' || written !== prepared.length) {
					throw new Error('CACHE_REDIS_RESULT_INVALID')
				}
			})
		},
		async delete(keys) {
			assertCacheBatchSize(keys.length, 'Redis cache delete')
			if (keys.length === 0) return 0
			return await registryCoordinator.run(keys, () => deleteMany(keys))
		},
		async invalidate(request: CacheInvalidateRequest) {
			return await registryCoordinator.run(request.keys, async() => {
				assertCacheBatchSize(request.keys?.length ?? 0, 'Redis cache invalidate')
				let removed = 0
				let registryCursor = '0'
				const registryCutoff = readCacheTimestamp(clock)
				const explicitKeys = request.keys === undefined ? undefined : [...new Set(request.keys)]
				while (true) {
					let candidateResult: unknown = explicitKeys
					if (!explicitKeys) {
						candidateResult = await redis.eval<unknown>(
							redisCacheListKeysScript, [registryKey], [registryCutoff, registryCursor, 500, 1_000]
						)
						const page = snapshotDenseDataArray(candidateResult, 1_001)
						const cursor = page && projectRegistryKey(page[0])
						if (!page || !cursor || !/^\d{1,20}$/u.test(cursor)) {
							throw new Error('CACHE_REDIS_RESULT_INVALID')
						}
						registryCursor = cursor
						candidateResult = page.slice(1)
					}
					const candidates = snapshotDenseDataArray(candidateResult, 1_000)
					const candidateKeys = candidates?.map(projectRegistryKey)
					if (!candidateKeys || candidateKeys.some((key) => key === undefined)) {
						throw new Error('CACHE_REDIS_RESULT_INVALID')
					}
					// ZSCAN may return duplicates during a full iteration. Every cleanup is
					// idempotent, but deduplicating each page keeps Lua KEYS/counts canonical.
					const projectedKeys = [...new Set(candidateKeys as string[])]
					if (projectedKeys.length === 0) {
						if (explicitKeys || registryCursor === '0') break
						continue
					}
					const selected: string[] = []
					if (!request.namespace && !request.version) selected.push(...projectedKeys)
					else {
						const chunkSize = Math.max(1, Math.floor(MAX_CACHE_BATCH_BYTES / MAX_REDIS_RECORD_BYTES))
						for (let start = 0; start < projectedKeys.length; start += chunkSize) {
							const chunkKeys = projectedKeys.slice(start, start + chunkSize)
							const records = await readManyBounded(chunkKeys, 'invalidate')
							const guarded: Array<{key: string; expected: string | Uint8Array; count: number}> = []
							for (let index = 0; index < chunkKeys.length; index++) {
								const key = chunkKeys[index]!
								const item = records[index]!
								if (item.kind === 'missing') continue
								if (item.kind === 'oversized') continue
								if (item.kind !== 'value') return invalidReadResult()
								const raw = item.raw
								try {
									const metadata = decodeRedisRecord(raw).metadata
									if (resolveCacheStorageKey(metadata.namespace, metadata.version, metadata.key) !== key) throw new Error()
									if ((!request.namespace || metadata.namespace === request.namespace)
									&& (!request.version || metadata.version === request.version)) {
										guarded.push({key, expected: raw, count: 1})
									}
								} catch { guarded.push({key, expected: raw, count: 0}) }
							}
							if (guarded.length > 0) {
								const args: Array<string | number | Uint8Array> = []
								for (const entry of guarded) args.push(entry.key, entry.expected, entry.count)
								const guardedResult = await redis.eval<unknown>(
									redisCacheDeleteIfValuesScript,
									[registryKey, ...guarded.map((entry) => dataKey(entry.key))],
									args
								)
								const projected = projectGuardedDeleteResult(guardedResult, guarded.length)
								const countedCandidates = guarded.filter((entry) => entry.count === 1).length
								const cleanupCandidates = guarded.length - countedCandidates
								if (!projected
								|| projected.removed > countedCandidates
								|| projected.deletedTotal - projected.removed > cleanupCandidates) {
									throw new Error('CACHE_REDIS_RESULT_INVALID')
								}
								removed += projected.removed
							}
						}
					}
					removed += await deleteMany(selected)
					if (explicitKeys || registryCursor === '0') break
				}
				return removed
			})
		},
		async flush() {},
		async shutdown() {}
	}
	return backend
}
