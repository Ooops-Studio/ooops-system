/**
 * @file Base cache factory with shared serialization, eviction, and LRU logic.
 * All specialized caches extend this base to avoid code duplication.
 */

import type {CachePort} from '../types/ports'

/**
 * Base cache entry interface
 */
export interface BaseCacheEntry {
	timestamp: number
	lastAccess: number
}

/**
 * Options for base cache
 */
export interface BaseCacheOptions {
	readonly ttl: number
	readonly cache?: CachePort
	readonly maxCacheSize?: number
}

type CacheMethod = (...args: unknown[]) => unknown

function captureCacheMethod(value: unknown, key: PropertyKey): CacheMethod | undefined {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	let current: object | null = value as object
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function'
				? descriptor.value as CacheMethod : undefined
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

/**
 * Base cache class with shared serialization, eviction, and LRU logic
 */
export abstract class BaseCache<TEntry extends BaseCacheEntry> {
	protected readonly cache = new Map<string, TEntry>()
	protected readonly ttl: number
	protected readonly cachePort: CachePort | undefined
	private readonly cacheGet: CacheMethod | undefined
	private readonly cacheSet: CacheMethod | undefined
	protected readonly maxCacheSize: number
	private destroyed = false

	constructor(options: BaseCacheOptions) {
		if (!options || typeof options !== 'object') throw new TypeError('Cache options are invalid')
		if (!Number.isSafeInteger(options.ttl) || options.ttl <= 0 || options.ttl > 2_147_483_647) {
			throw new RangeError('Cache ttl must be an integer between 1 and 2147483647')
		}
		if (options.maxCacheSize !== undefined
			&& (!Number.isSafeInteger(options.maxCacheSize) || options.maxCacheSize <= 0
				|| options.maxCacheSize > 100_000)) {
			throw new RangeError('Cache maxCacheSize must be an integer between 1 and 100000')
		}
		this.ttl = options.ttl
		this.cachePort = options.cache
		this.cacheGet = captureCacheMethod(options.cache, 'get')
		this.cacheSet = captureCacheMethod(options.cache, 'set')
		this.maxCacheSize = options.maxCacheSize ?? 1000
	}

	/**
	 * Serialize entry to JSON for external cache storage
	 */
	protected abstract serializeEntry(entry: TEntry): string

	/**
	 * Deserialize entry from JSON stored in external cache
	 */
	protected abstract deserializeEntry(value: string): TEntry | null

	/** Allow specialized caches to discard auxiliary state with an entry. */
	protected onEntryRemoved(_key: string): void {
		// Most caches have no auxiliary per-key state.
	}

	/**
	 * Evict least recently used entries when cache is full
	 */
	protected evictLRU(): void {
		if (this.cache.size < this.maxCacheSize) return

		// Sort by lastAccess (oldest first) and remove 10% of entries
		const entries = Array.from(this.cache.entries())
			.sort(([, a], [, b]) => a.lastAccess - b.lastAccess)

		const toRemove = Math.max(1, Math.floor(entries.length * 0.1))
		for (let i = 0; i < toRemove; i++) {
			const key = entries[i]![0]!
			this.cache.delete(key)
			this.onEntryRemoved(key)
		}
	}

	/**
	 * Clear expired entries
	 */
	clearExpired(): void {
		const now = Date.now()
		for (const [key, entry] of this.cache.entries()) {
			if (now - entry.timestamp > this.ttl) {
				this.cache.delete(key)
				this.onEntryRemoved(key)
			}
		}
	}

	/**
	 * Clear all entries
	 */
	async clear(): Promise<void> {
		for (const key of this.cache.keys()) this.onEntryRemoved(key)
		this.cache.clear()
		if (this.cachePort?.delete) {
			// Clear external cache entries (would need to track keys for full cleanup)
			// For now, just clear in-memory cache
		}
	}

	/**
	 * Get entry from cache (checks external cache first if available)
	 */
	protected async getEntry(key: string): Promise<TEntry | undefined> {
		if (this.destroyed) return undefined
		// Check in-memory cache first
		const entry = this.cache.get(key)
		if (entry) {
			return entry
		}

		// Check external cache if available
		if (this.cachePort && this.cacheGet) {
			try {
				const cached = await Promise.resolve(this.cacheGet.call(this.cachePort, key))
				// An external read can settle after destroy() has cleared resident
				// state. Never let that late completion resurrect the cache.
				if (this.destroyed) return undefined
				if (typeof cached === 'string' && cached) {
					const externalEntry = this.deserializeEntry(cached)
					if (externalEntry) {
						// Every hydration path must obey the same resident bound. Relying on
						// callers to reserve capacity allowed read-only external lookups to
						// grow the process cache without limit.
						if (!this.cache.has(key)) this.evictLRU()
						this.cache.set(key, externalEntry)
						return externalEntry
					}
				}
			} catch {
				// Ignore external cache errors
			}
		}

		return undefined
	}

	/**
	 * Set entry in cache (updates both in-memory and external cache if available)
	 */
	protected async setEntry(key: string, entry: TEntry): Promise<void> {
		if (this.destroyed) return
		// Centralize the capacity invariant so auxiliary writers cannot bypass
		// eviction by calling setEntry outside a specialized cache's main path.
		if (!this.cache.has(key)) this.evictLRU()
		this.cache.set(key, entry)

		// Update external cache if available
		if (this.cachePort && this.cacheSet) {
			try {
				await Promise.resolve(this.cacheSet.call(this.cachePort, key, this.serializeEntry(entry), this.ttl))
			} catch {
				// Ignore external cache errors
			}
		}
	}

	/**
	 * Destroy cache and cleanup resources
	 */
	async destroy(): Promise<void> {
		this.destroyed = true
		await this.clear()
	}
}
