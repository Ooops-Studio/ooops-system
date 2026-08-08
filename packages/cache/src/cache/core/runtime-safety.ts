import {createHash} from 'node:crypto'

import type {CacheGetOptions, CacheLoadOptions, CacheSetOptions} from '@ooopsstudio/core/contracts/cache'
import type {Clock} from '@ooopsstudio/core/contracts/clock'

export const MAX_CACHE_BATCH_ITEMS = 1_000
export const MAX_CACHE_BATCH_BYTES = 16 * 1024 * 1024
export const MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024
export const MAX_TRACKED_FLIGHTS = 1_000
export const MAX_ACTIVE_CACHE_OPERATIONS = 2_000
export const MAX_UNRESOLVED_CACHE_BACKEND_OPERATIONS = 64
export const MAX_PENDING_CACHE_FLUSH_REQUESTS = 64
// encodeURIComponent can expand one UTF-16 code unit to at most nine ASCII characters.
// A resolved key contains three independently encoded 256-code-unit components and two separators.
export const MAX_CACHE_STORAGE_KEY_CHARS = (3 * 256 * 9) + 2
export const MAX_CACHE_DURATION_MS = 2_147_483_647
export const CACHE_BACKEND_OPERATION_TIMEOUT_MS = 2_000
export const CACHE_FLUSH_TIMEOUT_MS = 5_000
export const CACHE_HEALTH_TIMEOUT_MS = 2_000
export const CACHE_SHUTDOWN_TIMEOUT_MS = 10_000

export class CacheTimeoutError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CacheTimeoutError'
	}
}

export function isCacheTimeoutError(value: unknown): value is CacheTimeoutError {
	return value instanceof CacheTimeoutError
}

const CACHE_OPTION_FIELDS = new Set([
	'namespace', 'version', 'ttlMs', 'staleTtlMs', 'negativeTtlMs', 'staleIfError'
])
const CACHE_GET_OPTION_FIELDS = new Set(['namespace', 'version'])
const CACHE_SET_OPTION_FIELDS = new Set(['namespace', 'version', 'ttlMs', 'staleTtlMs'])

function snapshotOptions<T extends object>(
	value: unknown,
	label: string,
	allowedFields: ReadonlySet<string>
): Partial<T> {
	if (value === undefined) return {}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.some((key) => typeof key !== 'string' || !allowedFields.has(key))) throw new TypeError()
		const snapshot = Object.create(null) as Record<string, unknown>
		for (const key of keys as string[]) {
			const descriptor = descriptors[key]
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError()
			if (descriptor.value !== undefined) snapshot[key] = descriptor.value
		}
		return snapshot as Partial<T>
	} catch {
		throw new TypeError(`${label} contains invalid or unexpected fields`)
	}
}

export function snapshotCacheOptions(value: unknown, label = 'Cache options'): Partial<CacheLoadOptions> {
	return snapshotOptions<CacheLoadOptions>(value, label, CACHE_OPTION_FIELDS)
}

export function snapshotCacheGetOptions(value: unknown, label = 'Cache get options'): Partial<CacheGetOptions> {
	return snapshotOptions<CacheGetOptions>(value, label, CACHE_GET_OPTION_FIELDS)
}

export function snapshotCacheSetOptions(value: unknown, label = 'Cache set options'): Partial<CacheSetOptions> {
	return snapshotOptions<CacheSetOptions>(value, label, CACHE_SET_OPTION_FIELDS)
}

export function assertCacheBatchSize(size: number, operation: string): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new RangeError(`${operation} batch size must be a non-negative safe integer`)
	}
	if (size > MAX_CACHE_BATCH_ITEMS) {
		throw new RangeError(`${operation} accepts at most ${MAX_CACHE_BATCH_ITEMS} items`)
	}
}

export function assertCacheBatchBytes(sizes: Iterable<number>, operation: string): void {
	let total = 0
	for (const size of sizes) {
		total = addCacheBatchBytes(total, size, operation)
	}
}

/** Adds one serialized entry to a bounded batch without requiring callers to retain the full batch first. */
export function addCacheBatchBytes(total: number, size: number, operation: string): number {
	if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(size) || size < 0) {
		throw new RangeError(`${operation} contains an invalid serialized entry size`)
	}
	const next = total + size
	if (!Number.isSafeInteger(next) || next > MAX_CACHE_BATCH_BYTES) {
		throw new RangeError(`${operation} exceeds the ${MAX_CACHE_BATCH_BYTES}-byte batch limit`)
	}
	return next
}

export function validateCacheDuration(value: number | undefined, label: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CACHE_DURATION_MS)) {
		throw new Error(`${label} must be between 1 and ${MAX_CACHE_DURATION_MS} milliseconds`)
	}
}

export function validateCacheComponent(value: string, label: string, maxLength = 256): void {
	if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
	let hasControlCharacter = false
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code < 32 || code === 127) { hasControlCharacter = true; break }
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++index)
			if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
				throw new Error(`${label} contains invalid Unicode`)
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new Error(`${label} contains invalid Unicode`)
		}
	}
	if (!value || value.length > maxLength || hasControlCharacter) {
		throw new Error(`${label} must be 1-${maxLength} safe characters`)
	}
}

export function resolveCacheStorageKey(namespace: string, version: string, key: string): string {
	return `${encodeURIComponent(namespace)}:${encodeURIComponent(version)}:${encodeURIComponent(key)}`
}

export function createBatchFlightKey(namespace: string, version: string, keys: readonly string[]): string {
	assertCacheBatchSize(keys.length, 'Cache batch single-flight')
	const digest = createHash('sha256')
	const update = (value: string): void => {
		digest.update(String(Buffer.byteLength(value))).update(':').update(value).update(';')
	}
	update(namespace)
	update(version)
	for (const key of [...keys].sort()) update(key)
	return `cache:batch:${digest.digest('hex').slice(0, 32)}`
}

/**
 * Keep item flights in a separate, fixed-length identity domain. Using the raw
 * resolved storage key can collide with the textual batch-flight prefix for
 * valid user-controlled namespace/version/key combinations.
 */
export function createItemFlightKey(resolvedKey: string): string {
	return `cache:item:${createHash('sha256').update(resolvedKey).digest('hex').slice(0, 32)}`
}

export function snapshotCacheMap<K, V>(
	value: unknown,
	maximumEntries = MAX_CACHE_BATCH_ITEMS
): Map<K, V> | undefined {
	if (!value || typeof value !== 'object') return undefined
	try {
		if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) return undefined
		const sizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get
		const size = sizeGetter?.call(value) as unknown
		if (!Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > maximumEntries) return undefined
		return new Map(Map.prototype.entries.call(value) as MapIterator<[K, V]>)
	} catch { return undefined }
}

export function readCacheTimestamp(clock: Clock): number {
	const timestamp = clock.now()
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new Error('Cache clock must return a non-negative safe integer timestamp')
	}
	return timestamp
}

export async function withCacheTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new CacheTimeoutError(message)), timeoutMs)
	})
	try { return await Promise.race([operation, timeout]) } finally { if (timer) clearTimeout(timer) }
}
