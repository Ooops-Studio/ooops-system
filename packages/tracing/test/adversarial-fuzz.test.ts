import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import {describe, expect, it} from 'vitest'

import {snapshotSpanRecord} from '../src/core/processor-utils'
import {createW3CPropagator} from '../src/features/propagation/w3c-propagator'

function createRandom(seed = 0x1234_5678): () => number {
	return () => {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
		return seed / 0x1_0000_0000
	}
}

describe('tracing adversarial boundary fuzz', () => {
	it('rejects Proxy-backed records and carriers before invoking ownKeys traps', () => {
		let ownKeysCalls = 0
		const hostileObject = new Proxy({}, {
			ownKeys: () => { ownKeysCalls++; throw new Error('unbounded enumeration') }
		})
		const base: SpanRecord = {
			name: 'proxy', kind: 'internal',
			context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			startTime: 0, endTime: 1, attributes: hostileObject, status: {code: 'ok'}, events: []
		}
		expect(snapshotSpanRecord(base)).toBeUndefined()
		expect(createW3CPropagator().extract(hostileObject as Record<string, string>)).toEqual({})
		expect(ownKeysCalls).toBe(0)
	})

	it('snapshots bounded Proxy arrays without enumerating custom fields', () => {
		let ownKeysCalls = 0
		const values = new Proxy(['safe'], {
			ownKeys: () => { ownKeysCalls++; throw new Error('unbounded enumeration') }
		})
		const record: SpanRecord = {
			name: 'proxy-array', kind: 'internal',
			context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			startTime: 0, endTime: 1, attributes: {values}, status: {code: 'ok'}, events: []
		}
		expect(snapshotSpanRecord(record)?.attributes).toEqual({values: ['safe']})
		expect(ownKeysCalls).toBe(0)
	})

	it('keeps randomized W3C carriers and span graphs bounded and fail-safe', () => {
		const random = createRandom()
		const propagator = createW3CPropagator()
		const names = ['traceparent', 'TraceParent', 'TRACESTATE', 'baggage', 'Baggage', 'x-trace-id', 'other']
		const sizes = [0, 1, 32, 55, 256, 512, 513, 8_192, 8_193, 20_000]

		for (let iteration = 0; iteration < 1_000; iteration++) {
			const carrier: Record<string, string> = Object.create(null) as Record<string, string>
			const count = Math.floor(random() * 20)
			for (let index = 0; index < count; index++) {
				const key = names[Math.floor(random() * names.length)]! + (random() < 0.15 ? String(index) : '')
				const size = sizes[Math.floor(random() * sizes.length)]!
				Object.defineProperty(carrier, key, {
					value: 'x'.repeat(size), enumerable: true, configurable: true, writable: true
				})
			}
			expect(() => propagator.extract(carrier)).not.toThrow()
		}

		const base: SpanRecord = {
			name: 'fuzz', kind: 'internal',
			context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			startTime: 0, endTime: 1, attributes: {}, status: {code: 'ok'}, events: []
		}
		let accepted = 0
		let rejected = 0
		for (let iteration = 0; iteration < 500; iteration++) {
			let value: unknown = {leaf: 'x'.repeat(Math.floor(random() * 2_000))}
			const depth = Math.floor(random() * 40)
			for (let level = 0; level < depth; level++) value = {[`key-${level}`]: value}
			const snapshot = snapshotSpanRecord({...base, attributes: value as never})
			if (snapshot) accepted++
			else rejected++
		}
		// The deterministic corpus crosses both sides of the depth boundary.
		// This also prevents the fuzz loop from silently degenerating into only
		// valid or only invalid cases after a future generator edit.
		expect(accepted).toBeGreaterThan(0)
		expect(rejected).toBeGreaterThan(0)
	})
})
