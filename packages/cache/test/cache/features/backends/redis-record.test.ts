import type {CacheEntryMetadata} from '@ooopsstudio/core/contracts/cache'
import {describe, expect, it} from 'vitest'

import {decodeRedisRecord, encodeRedisRecord} from '../../../../src/cache/features/backends/redis-record'

const metadata: CacheEntryMetadata = {
	key: 'key', namespace: 'app', version: 'v1', createdAt: 0,
	staleAt: 10, expiresAt: 10, negative: false, sizeBytes: 1
}

describe('Redis cache records', () => {
	it('round-trips canonical metadata and tolerates legacy fields on reads', () => {
		const encoded = encodeRedisRecord(new Uint8Array([1]), metadata)
		expect(decodeRedisRecord(encoded)).toEqual({value: new Uint8Array([1]), metadata})
		const legacy = JSON.parse(encoded) as {metadata: Record<string, unknown>}
		legacy.metadata.revision = 'legacy'
		legacy.metadata.updatedAt = 0
		legacy.metadata.slidingTtl = false
		expect(decodeRedisRecord(JSON.stringify(legacy))).toEqual({value: new Uint8Array([1]), metadata})
	})

	it('accepts only canonical encoded null bytes for negative records', () => {
		const value = new TextEncoder().encode('null')
		const negative = {...metadata, negative: true, sizeBytes: value.byteLength}
		expect(decodeRedisRecord(encodeRedisRecord(value, negative))).toEqual({value, metadata: negative})
		expect(() => encodeRedisRecord(new Uint8Array([1]), {...negative, sizeBytes: 1}))
			.toThrow('CACHE_REDIS_NEGATIVE_VALUE')
	})

	it('rejects malformed and oversized records', () => {
		expect(() => decodeRedisRecord('not-json')).toThrow()
		expect(() => decodeRedisRecord('{}')).toThrow('CACHE_REDIS_RECORD_INVALID')
		expect(() => encodeRedisRecord(new Uint8Array([1]), {...metadata, sizeBytes: 2})).toThrow()
	})
})
