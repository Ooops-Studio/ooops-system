import type {
	CacheEntryMetadata,
	CacheGetOptions,
	CacheInvalidateRequest,
	CacheLoadOptions,
	CacheSetOptions,
	CacheStatus
} from '../contracts/cache'

/** Small compatibility port retained for unrelated core/error memory utilities. */
export interface CachePort {
	get?(key: string): Promise<string | undefined> | string | undefined
	set?(key: string, value: string, ttl?: number): Promise<void> | void
	delete?(key: string): Promise<void> | void
}

export interface CacheRedisPort {
	eval<T = unknown>(
		script: string,
		keys: readonly string[],
		args: readonly (string | number | Uint8Array)[]
	): Promise<T>
}

export interface CacheBackendPort {
	get(
		key: string,
		options?: CacheGetOptions & {allowStale?: boolean}
	): Promise<{value: Uint8Array; metadata: CacheEntryMetadata} | undefined>
	getMany(
		keys: readonly string[],
		options?: CacheGetOptions & {allowStale?: boolean}
	): Promise<ReadonlyMap<string, {value: Uint8Array; metadata: CacheEntryMetadata}>>
	set(key: string, value: Uint8Array, metadata: CacheEntryMetadata): Promise<void>
	setMany(entries: ReadonlyArray<{key: string; value: Uint8Array; metadata: CacheEntryMetadata}>): Promise<void>
	delete(keys: readonly string[]): Promise<number>
	invalidate(request: CacheInvalidateRequest): Promise<number>
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}

export interface CacheServicePort {
	get<T>(key: string, options?: CacheGetOptions): Promise<T | undefined>
	getMany<T>(keys: readonly string[], options?: CacheGetOptions): Promise<ReadonlyMap<string, T>>
	set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>
	setMany<T>(entries: ReadonlyArray<{key: string; value: T}>, options?: CacheSetOptions): Promise<void>
	delete(key: string, options?: CacheGetOptions): Promise<void>
	deleteMany(keys: readonly string[], options?: CacheGetOptions): Promise<void>
	invalidate(request: CacheInvalidateRequest): Promise<number>
	load<T>(key: string, loader: () => Promise<T>, options?: CacheLoadOptions): Promise<T | undefined>
	loadMany<T>(
		keys: readonly string[],
		loader: (missingKeys: readonly string[]) => Promise<ReadonlyMap<string, T>>,
		options?: CacheLoadOptions
	): Promise<ReadonlyMap<string, T>>
	namespace(name: string, defaults?: Partial<CacheLoadOptions>): CacheServicePort

}

export interface ManagedCache extends CacheServicePort {
	getStatus(): CacheStatus
	flush(): Promise<void>
	shutdown(): Promise<void>
}
