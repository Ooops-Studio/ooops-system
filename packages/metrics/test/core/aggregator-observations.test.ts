import {describe, expect, it} from 'vitest'

import {recordHistogramObservation} from '../../src/core/aggregator-observations'

describe('aggregator observations', () => {
	it('records new histogram states with stale bounds and overflow exemplars', () => {
		const states = new Map()
		recordHistogramObservation({
			states, key: 'histogram', name: 'latency', labels: {route: '/health'}, value: 10, now: 100,
			buckets: [1, 5], metadata: {}, definition: {name: 'latency', instrument: 'histogram', staleAfterMs: 50},
			exemplar: {value: 10, timestamp: 100}, touchState: (state) => state
		})

		const state = states.get('histogram') as {counts: number[]; bucketExemplars: Map<number, unknown>; staleAfterMs: number}
		expect(state.counts).toEqual([0, 0, 1])
		expect(state.bucketExemplars.get(Number.POSITIVE_INFINITY)).toEqual({value: 10, timestamp: 100})
		expect(state).toMatchObject({staleAfterMs: 50})
	})

	it('updates existing histogram states without optional exemplars', () => {
		const histogramStates = new Map([['histogram', {
			type: 'histogram' as const, buckets: [1], counts: [0, 0], sum: 0, count: 0,
			name: 'latency', labels: {}, metadata: {}, windowStartedAt: 1, lastSeenAt: 1, bucketExemplars: new Map()
		}]])
		recordHistogramObservation({
			states: histogramStates, key: 'histogram', name: 'latency', labels: {}, value: 1, now: 2, buckets: [1], metadata: {}, definition: {name: 'latency', instrument: 'histogram'},
			touchState: (state) => state
		})
		expect((histogramStates.get('histogram') as {count: number}).count).toBe(1)
	})
})
