export type CacheKey = string
export type CacheNamespace = string

/** Internal storage metadata required by cache backend implementations. */
export interface CacheEntryMetadata {
	readonly key: CacheKey
	readonly namespace: CacheNamespace
	readonly version: string
	readonly createdAt: number
	readonly staleAt?: number
	readonly expiresAt?: number
	readonly negative: boolean
	readonly sizeBytes: number
}

export interface CacheGetOptions {
	readonly namespace?: CacheNamespace
	readonly version?: string
}

export interface CacheSetOptions extends CacheGetOptions {
	readonly ttlMs?: number
	readonly staleTtlMs?: number
}

export interface CacheLoadOptions extends CacheSetOptions {
	readonly negativeTtlMs?: number
	readonly staleIfError?: boolean
}

export interface CacheInvalidateRequest {
	readonly keys?: readonly CacheKey[]
	readonly namespace?: CacheNamespace
	readonly version?: string
}

export type CacheRuntimeState = 'running' | 'draining' | 'closed'
export type CacheBackendState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface CacheStatus {
	readonly state: CacheRuntimeState
	readonly activeOperations: number
	readonly activeLoads: number
	readonly droppedTotal: number
	readonly backendState: CacheBackendState
	readonly lastFailureCode?: string
}
