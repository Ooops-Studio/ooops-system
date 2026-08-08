import type {CacheEntryMetadata, CacheLoadOptions} from '@ooopsstudio/core/contracts/cache'
import type {Clock} from '@ooopsstudio/core/contracts/clock'

import {MAX_CACHE_ENTRY_BYTES, readCacheTimestamp, validateCacheComponent} from './runtime-safety'

type ResolvedMetadataOptions = CacheLoadOptions & {namespace: string; version: string}
export type CacheStoredEntry = {value: Uint8Array; metadata: CacheEntryMetadata}

const optionalTimestamp = (value: unknown): value is number | undefined =>
	value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)

const boundedString = (value: unknown, maxLength = 256): value is string => {
	if (typeof value !== 'string') return false
	try { validateCacheComponent(value, 'Cache metadata component', maxLength); return true } catch { return false }
}

const metadataFields = new Set([
	'key', 'namespace', 'version', 'createdAt', 'staleAt', 'expiresAt', 'negative', 'sizeBytes',
	// Legacy fields are accepted on reads so existing Redis records remain usable,
	// but are never projected into new canonical metadata.
	'revision', 'updatedAt', 'effectiveTtlMs', 'staleTtlMs', 'slidingTtl'
])

export function projectCacheEntryMetadata(value: unknown, expectedSize?: number): CacheEntryMetadata | undefined {
	if (!value || typeof value !== 'object') return undefined
	try {
		const prototype = Object.getPrototypeOf(value)
		if (Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) return undefined
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.some((key) => typeof key !== 'string' || !metadataFields.has(key))) return undefined
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) return undefined
		const read = (field: string): unknown => descriptors[field]?.value
		const metadata = {
			key: read('key'), namespace: read('namespace'), version: read('version'),
			createdAt: read('createdAt'), staleAt: read('staleAt'), expiresAt: read('expiresAt'),
			negative: read('negative'), sizeBytes: read('sizeBytes')
		}
		if (!(boundedString(metadata.key)
			&& boundedString(metadata.namespace)
			&& boundedString(metadata.version)
			&& typeof metadata.createdAt === 'number' && Number.isSafeInteger(metadata.createdAt) && metadata.createdAt >= 0
			&& optionalTimestamp(metadata.staleAt)
			&& optionalTimestamp(metadata.expiresAt)
			&& typeof metadata.negative === 'boolean'
			&& typeof metadata.sizeBytes === 'number' && Number.isSafeInteger(metadata.sizeBytes))) return undefined
		const hasCompleteTtlState = metadata.staleAt === undefined
			? metadata.expiresAt === undefined
			: metadata.expiresAt !== undefined
		if (!(metadata.sizeBytes >= 0 && metadata.sizeBytes <= MAX_CACHE_ENTRY_BYTES
		&& hasCompleteTtlState
		&& (expectedSize === undefined || metadata.sizeBytes === expectedSize)
		&& (metadata.staleAt === undefined || metadata.staleAt >= metadata.createdAt)
			&& !(metadata.staleAt !== undefined && metadata.expiresAt !== undefined && metadata.staleAt > metadata.expiresAt)
			&& (!metadata.negative || (
				metadata.staleAt !== undefined
				&& metadata.expiresAt !== undefined
				&& metadata.staleAt === metadata.expiresAt
			)))) {
			return undefined
		}
		return {
			key: metadata.key,
			namespace: metadata.namespace,
			version: metadata.version,
			createdAt: metadata.createdAt,
			...(metadata.staleAt === undefined ? {} : {staleAt: metadata.staleAt}),
			...(metadata.expiresAt === undefined ? {} : {expiresAt: metadata.expiresAt}),
			negative: metadata.negative,
			sizeBytes: metadata.sizeBytes
		}
	} catch { return undefined }
}

export function isCacheEntryMetadata(value: unknown, expectedSize?: number): value is CacheEntryMetadata {
	return projectCacheEntryMetadata(value, expectedSize) !== undefined
}

export function projectCacheStoredEntry(value: unknown): CacheStoredEntry | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return undefined
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.length !== 2 || !keys.includes('value') || !keys.includes('metadata')) return undefined
		const valueDescriptor = descriptors.value
		const metadataDescriptor = descriptors.metadata
		if (!valueDescriptor?.enumerable || !metadataDescriptor?.enumerable
			|| !('value' in valueDescriptor) || !('value' in metadataDescriptor)) return undefined
		const bytes = valueDescriptor.value
		if (!(bytes instanceof Uint8Array)) return undefined
		const metadata = projectCacheEntryMetadata(metadataDescriptor.value, bytes.byteLength)
		if (!metadata) return undefined
		return {value: new Uint8Array(bytes), metadata}
	} catch { return undefined }
}

function stableUnitInterval(value: string): number {
	let hash = 2_166_136_261
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 16_777_619)
	}
	return (hash >>> 0) / 0xffff_ffff
}

export function advanceCacheTimestamp(timestamp: number, durationMs: number): number {
	const result = timestamp + durationMs
	if (!Number.isSafeInteger(result) || result < 0) throw new Error('Cache timestamp exceeds the safe integer range')
	return result
}

export function createCacheEntryMetadata(options: {
	clock: Clock
	key: string
	resolvedKey: string
	resolved: ResolvedMetadataOptions
	value: Uint8Array
	negative: boolean
	jitterRatio: number
}): CacheEntryMetadata {
	const now = readCacheTimestamp(options.clock)
	const configuredTtl = options.negative ? options.resolved.negativeTtlMs : options.resolved.ttlMs
	const ttl = configuredTtl === undefined
		? undefined
		: Math.max(1, Math.floor(configuredTtl * (1 - stableUnitInterval(options.resolvedKey) * options.jitterRatio)))
	const staleTtlMs = options.negative ? 0 : (options.resolved.staleTtlMs ?? 0)
	const staleAt = ttl === undefined ? undefined : advanceCacheTimestamp(now, ttl)
	const expiresAt = staleAt === undefined ? undefined : advanceCacheTimestamp(staleAt, staleTtlMs)
	return {
		key: options.key,
		namespace: options.resolved.namespace,
		version: options.resolved.version,
		createdAt: now,
		...(ttl !== undefined && staleAt !== undefined && expiresAt !== undefined
			? {staleAt, expiresAt}
			: {}),
		negative: options.negative,
		sizeBytes: options.value.byteLength
	}
}
