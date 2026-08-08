import type {CacheEntryMetadata} from '@ooopsstudio/core/contracts/cache'

import {projectCacheEntryMetadata} from '../../core/runtime-metadata'
import {MAX_CACHE_ENTRY_BYTES} from '../../core/runtime-safety'
import {isEncodedNegativeCacheValue} from '../../core/runtime-serialization'

/** Maximum wire size of one encoded Redis record, including metadata/base64 overhead. */
export const MAX_REDIS_RECORD_BYTES = Math.ceil(MAX_CACHE_ENTRY_BYTES * 4 / 3) + 16 * 1024
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', {fatal: true})

export interface RedisCacheRecord {
	value: string
	metadata: CacheEntryMetadata
}

export function encodeRedisRecord(value: Uint8Array, metadata: CacheEntryMetadata): string {
	const metadataSnapshot = projectCacheEntryMetadata(metadata, value.byteLength)
	if (!metadataSnapshot) {
		throw new Error('CACHE_REDIS_METADATA_INVALID')
	}
	if (metadataSnapshot.negative && !isEncodedNegativeCacheValue(value)) {
		throw new Error('CACHE_REDIS_NEGATIVE_VALUE')
	}
	const encoded = JSON.stringify({value: Buffer.from(value).toString('base64'), metadata: metadataSnapshot})
	if (utf8Encoder.encode(encoded).byteLength > MAX_REDIS_RECORD_BYTES) {
		throw new RangeError('CACHE_REDIS_RECORD_LIMIT')
	}
	return encoded
}

export function decodeRedisRecord(raw: unknown): {value: Uint8Array; metadata: CacheEntryMetadata} {
	if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) {
		throw new Error('CACHE_REDIS_RECORD_INVALID')
	}
	const wireBytes = typeof raw === 'string' ? utf8Encoder.encode(raw).byteLength : raw.byteLength
	if (wireBytes > MAX_REDIS_RECORD_BYTES) throw new Error('CACHE_REDIS_RECORD_LIMIT')
	const parsed = JSON.parse(typeof raw === 'string' ? raw : utf8Decoder.decode(raw)) as unknown
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
		|| Object.getPrototypeOf(parsed) !== Object.prototype) {
		throw new Error('CACHE_REDIS_RECORD_INVALID')
	}
	const fields = Object.keys(parsed)
	if (fields.length !== 2 || !fields.includes('value') || !fields.includes('metadata')) {
		throw new Error('CACHE_REDIS_RECORD_INVALID')
	}
	const record = parsed as Partial<RedisCacheRecord>
	const metadata = projectCacheEntryMetadata(record.metadata)
	if (typeof record.value !== 'string' || !metadata) {
		throw new Error('CACHE_REDIS_RECORD_INVALID')
	}
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(record.value)) {
		throw new Error('CACHE_REDIS_RECORD_INVALID')
	}
	const value = new Uint8Array(Buffer.from(record.value, 'base64'))
	if (value.byteLength > MAX_CACHE_ENTRY_BYTES || metadata.sizeBytes !== value.byteLength) {
		throw new Error('CACHE_REDIS_RECORD_INVALID')
	}
	if (metadata.negative && !isEncodedNegativeCacheValue(value)) {
		throw new Error('CACHE_REDIS_RECORD_INVALID')
	}
	return {value, metadata}
}
