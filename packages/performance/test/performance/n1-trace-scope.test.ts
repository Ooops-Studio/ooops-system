import {describe, expect, it} from 'vitest'

import {createN1Detector} from '../../src/performance/features/db/n1-detector'
import {cloneN1Event} from '../../src/performance/features/db/n1-patterns'

const event = (traceId: string | undefined, end: number) => ({
	name: 'db.query', duration: 1, start: end - 1, end, source: 'mark' as const,
	...(traceId ? {traceId} : {}), dbMetadata: {queryHash: 'shape', collection: 'users', method: 'get' as const}
})

describe('trace-scoped N+1 detection', () => {
	it('rejects N+1 configurations that exceed bounded CPU or memory state', () => {
		expect(() => createN1Detector({enabled: true, maxEventsPerTrace: 257})).toThrow('256')
		expect(() => createN1Detector({enabled: true, maxTrackedTraces: 1_001})).toThrow('1..1000')
		expect(() => createN1Detector({
			enabled: true, maxTrackedTraces: 100, maxEventsPerTrace: 101
		})).toThrow('10000 retained events')
	})

	it('retains only bounded fields required by N+1 detection', () => {
		const retained = cloneN1Event({
			...event('a'.repeat(32), 1),
			spanId: 'b'.repeat(16),
			outcome: 'ok',
			http: {method: 'GET', route: '/secret', statusCode: 200},
			labels: {collection: 'users', method: 'get', filter_type: 'active', secret: 'x'.repeat(256)},
			dbMetadata: {
				collection: 'users', operation: 'select', queryHash: 'q'.repeat(256),
				projection: Array.from({length: 32}, () => 'x'.repeat(128))
			}
		})

		expect(retained).toEqual({
			name: 'db.query', duration: 1, start: 0, end: 1, source: 'mark',
			dbMetadata: {collection: 'users', operation: 'select', queryHash: 'q'.repeat(128)},
			labels: {filter_type: 'active'}
		})
	})

	it('never combines uncorrelated or different traces', () => {
		const detector = createN1Detector({enabled: true, minDuplicates: 2})
		expect(detector.check(event(undefined, 1))).toEqual([])
		expect(detector.check(event('1'.repeat(32), 2))).toEqual([])
		expect(detector.check(event('2'.repeat(32), 3))).toEqual([])
	})

	it('detects and deduplicates a repeated shape inside one trace', () => {
		const detector = createN1Detector({enabled: true, minDuplicates: 2})
		const traceId = 'a'.repeat(32)
		expect(detector.check(event(traceId, 1))).toEqual([])
		expect(detector.check(event(traceId, 2)).length).toBeGreaterThan(0)
		expect(detector.check(event(traceId, 3))).toEqual([])
	})

	it('caps retained fingerprints and emitted patterns per trace', () => {
		const detector = createN1Detector({enabled: true, minDuplicates: 2, maxEventsPerTrace: 2})
		const traceId = 'c'.repeat(32)
		let emitted = 0
		for (let index = 0; index < 20; index += 1) {
			const sample = (end: number) => ({
				...event(traceId, end),
				dbMetadata: {collection: 'users', method: 'get' as const, queryHash: `shape-${index}`}
			})
			emitted += detector.check(sample(index * 2 + 1)).length
			emitted += detector.check(sample(index * 2 + 2)).length
		}
		expect(emitted).toBeLessThanOrEqual(10)
	})

	it('expires stale traces on the amortized cleanup boundary', () => {
		const detector = createN1Detector({enabled: true, minDuplicates: 2, timeWindowMs: 1})
		const original = 'a'.repeat(32)
		detector.check(event(original, 0))
		detector.check(event('b'.repeat(32), 2_000))
		expect(detector.check(event(original, 2_001))).toEqual([])
		detector.reset()
		expect(detector.check(event(original, 2_002))).toEqual([])
	})

})
