import type {CacheEntryMetadata, CacheInvalidateRequest} from '@ooopsstudio/core/contracts/cache'
import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CacheBackendPort} from '@ooopsstudio/core/ports/cache'

import {bindCacheClock} from '../../core/runtime-backend-binding'
import {projectCacheEntryMetadata} from '../../core/runtime-metadata'
import {
	addCacheBatchBytes,
	assertCacheBatchBytes,
	assertCacheBatchSize,
	MAX_CACHE_ENTRY_BYTES,
	readCacheTimestamp
} from '../../core/runtime-safety'
import {isEncodedNegativeCacheValue} from '../../core/runtime-serialization'

export interface MemoryCacheBackendOptions {
	clock: Clock
	maxEntries?: number
	maxBytes?: number
	sweepIntervalMs?: number
}

type Entry = {value: Uint8Array; metadata: CacheEntryMetadata}

export function createMemoryCacheBackend(options: MemoryCacheBackendOptions): CacheBackendPort {
	if (!options) throw new Error('Memory cache backend requires a clock')
	const clock = bindCacheClock(options.clock, 'Memory cache backend')
	const maxEntries = options.maxEntries ?? 3_000
	const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
	if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('Memory cache maxEntries must be positive')
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Memory cache maxBytes must be positive')
	if (options.sweepIntervalMs !== undefined && (
		!Number.isSafeInteger(options.sweepIntervalMs)
		|| options.sweepIntervalMs <= 0
		|| options.sweepIntervalMs > 2_147_483_647
	)) {
		throw new Error('Memory cache sweepIntervalMs must be a safe timer duration')
	}
	const entries = new Map<string, Entry>()
	let bytes = 0
	let closed = false
	let sweepTimer: ReturnType<typeof setInterval> | undefined
	const cloneMetadata = (metadata: CacheEntryMetadata): CacheEntryMetadata => {
		const snapshot = projectCacheEntryMetadata(metadata)
		if (!snapshot) throw new Error('Memory cache metadata is invalid')
		return snapshot
	}
	const ensureOpen = (): void => { if (closed) throw new Error('Memory cache backend has been shut down') }
	const remove = (key: string): boolean => {
		const entry = entries.get(key)
		if (!entry) return false
		entries.delete(key); bytes -= entry.value.byteLength; return true
	}
	const expired = (entry: Entry, now: number): boolean => entry.metadata.expiresAt !== undefined
		&& entry.metadata.expiresAt <= now
	const trim = (): void => {
		if (entries.size <= maxEntries && bytes <= maxBytes) return
		for (const key of entries.keys()) {
			if (entries.size <= maxEntries && bytes <= maxBytes) break
			remove(key)
		}
	}
	const sweep = (): void => {
		const now = readCacheTimestamp(clock)
		for (const [key, entry] of entries) if (expired(entry, now)) remove(key)
	}
	const scheduledSweep = (): void => {
		try { sweep() } catch { /* the next foreground operation remains authoritative */ }
	}
	const setEntry = (key: string, value: Uint8Array, metadata: CacheEntryMetadata): void => {
		ensureOpen()
		if (value.byteLength > MAX_CACHE_ENTRY_BYTES) throw new RangeError('Cache entry exceeds the serialized entry size limit')
		if (value.byteLength > maxBytes) throw new RangeError('Memory cache entry exceeds the backend byte limit')
		const metadataSnapshot = projectCacheEntryMetadata(metadata, value.byteLength)
		if (!metadataSnapshot) throw new Error('Memory cache metadata is invalid')
		if (metadataSnapshot.negative && !isEncodedNegativeCacheValue(value)) throw new Error('Memory cache negative value is invalid')
		const valueSnapshot = new Uint8Array(value)
		readCacheTimestamp(clock)
		remove(key)
		entries.set(key, {value: valueSnapshot, metadata: metadataSnapshot})
		bytes += value.byteLength; trim()
	}
	if (options.sweepIntervalMs && options.sweepIntervalMs > 0) {
		sweepTimer = setInterval(scheduledSweep, options.sweepIntervalMs); sweepTimer.unref?.()
	}
	const backend: CacheBackendPort = {
		async get(key, getOptions) {
			ensureOpen()
			const entry = entries.get(key)
			const now = readCacheTimestamp(clock)
			if (!entry || expired(entry, now)) {
				if (entry) remove(key)
				return undefined
			}
			const stale = entry.metadata.staleAt !== undefined && entry.metadata.staleAt <= now
			if (stale && !getOptions?.allowStale) return undefined
			// Reinsertion moves the entry to the end of Map iteration order, giving
			// deterministic LRU behavior even when wall-clock timestamps are equal.
			entries.delete(key)
			entries.set(key, entry)
			return {value: new Uint8Array(entry.value), metadata: cloneMetadata(entry.metadata)}
		},
		async getMany(keys, getOptions) {
			ensureOpen()
			assertCacheBatchSize(keys.length, 'Memory cache getMany')
			const result = new Map<string, {value: Uint8Array; metadata: CacheEntryMetadata}>()
			let responseBytes = 0
			for (const key of keys) {
				const entry = await backend.get(key, getOptions)
				if (entry) {
					responseBytes = addCacheBatchBytes(
						responseBytes,
						entry.value.byteLength,
						'Memory cache getMany'
					)
					result.set(key, entry)
				}
			}
			return result
		},
		async set(key, value, metadata) { setEntry(key, value, metadata) },
		async setMany(items) {
			ensureOpen()
			assertCacheBatchSize(items.length, 'Memory cache setMany')
			assertCacheBatchBytes(items.map((item) => item.value.byteLength), 'Memory cache setMany')
			if (items.some((item) => item.value.byteLength > MAX_CACHE_ENTRY_BYTES)) {
				throw new RangeError('Cache entry exceeds the serialized entry size limit')
			}
			if (items.some((item) => item.value.byteLength > maxBytes)) {
				throw new RangeError('Memory cache entry exceeds the backend byte limit')
			}
			const prepared = items.map((item) => {
				const metadata = projectCacheEntryMetadata(item.metadata, item.value.byteLength)
				if (!metadata) throw new Error('Memory cache metadata is invalid')
				if (metadata.negative && !isEncodedNegativeCacheValue(item.value)) {
					throw new Error('Memory cache negative value is invalid')
				}
				readCacheTimestamp(clock)
				return {key: item.key, value: new Uint8Array(item.value), metadata}
			})
			for (const item of prepared) {
				remove(item.key)
				entries.set(item.key, item)
				bytes += item.value.byteLength
				trim()
			}
		},
		async delete(keys) {
			ensureOpen()
			assertCacheBatchSize(keys.length, 'Memory cache delete')
			let count = 0
			for (const key of keys) if (remove(key)) count++
			return count
		},
		async invalidate(request: CacheInvalidateRequest) {
			ensureOpen()
			assertCacheBatchSize(request.keys?.length ?? 0, 'Memory cache invalidate')
			const selected = request.keys === undefined ? new Set(entries.keys()) : new Set(request.keys)
			const keys = [...selected].filter((key) => {
				const entry = entries.get(key)
				return entry
					&& (!request.namespace || entry.metadata.namespace === request.namespace)
					&& (!request.version || entry.metadata.version === request.version)
			})
			let count = 0
			for (const key of keys) if (remove(key)) count++
			return count
		},
		async flush() {
			ensureOpen()
			sweep()
		},
		async shutdown() {
			if (closed) return
			closed = true
			if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined }
			entries.clear()
			bytes = 0
		}
	}
	return backend
}
