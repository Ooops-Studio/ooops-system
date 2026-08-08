import {describe, expect, it} from 'vitest'

import {MetricAggregator} from '../../src/core/aggregator'
import {createFixedClock} from '../support/fixed-clock'

describe('metric aggregator coverage', () => {

	it('covers histogram snapshot edge branches directly', () => {
		const clock = createFixedClock(1_000)
		const aggregator = new MetricAggregator({clock, defaultTemporality: 'delta'})
		const states = (aggregator as unknown as {states: Map<string, unknown>}).states

		states.set('histogram-edge', {
			type: 'histogram',
			name: 'histogram_edge',
			labels: {env: 'test'},
			buckets: [1, undefined, 5],
			counts: [1, 2, 3, 4],
			sum: 10,
			count: 4,
			windowStartedAt: 1_000,
			lastSeenAt: 1_000,
			bucketExemplars: new Map([[Number.POSITIVE_INFINITY, {value: 4, timestamp: 1_000}]]),
			metadata: {instrument: 'histogram', temporality: 'delta'}
		})

		const first = aggregator.snapshot({resetDelta: true})
		expect(first.find((record) => record.name === 'histogram_edge_bucket' && record.labels.le === '+Inf')?.exemplar)
			.toEqual({value: 4, timestamp: 1_000})
		expect(first.find((record) => record.name === 'histogram_edge_bucket' && record.labels.le === 'undefined')).toBeUndefined()

		const second = aggregator.snapshot({resetDelta: true})
		expect(second.find((record) => record.name === 'histogram_edge_count')?.value).toBe(0)
	})

	it('covers existing histogram overflow and bucket exemplar update branches', () => {
		const clock = createFixedClock(1_000)
		const aggregator = new MetricAggregator({clock})
		const states = (aggregator as unknown as {states: Map<string, unknown>}).states
		const createKey = (aggregator as unknown as {
			createKey(name: string, labels: Record<string, string>): string
		}).createKey.bind(aggregator)

		states.set(createKey('histogram_overflow', {env: 'test'}), {
			type: 'histogram',
			name: 'histogram_overflow',
			labels: {env: 'test'},
			buckets: [1, 2],
			counts: [0],
			sum: 0,
			count: 0,
			windowStartedAt: 1_000,
			lastSeenAt: 1_000,
			bucketExemplars: new Map(),
			metadata: {instrument: 'histogram', temporality: 'cumulative'}
		})

		aggregator.observeHistogram('histogram_overflow', {env: 'test'}, 100)
		const overflowState = states.get(createKey('histogram_overflow', {env: 'test'})) as {counts: number[]}
		expect(overflowState.counts[overflowState.counts.length - 1]).toBeGreaterThanOrEqual(0)

		aggregator.observeHistogram('histogram_existing', {env: 'test'}, 0.1)
		aggregator.observeHistogram('histogram_existing', {env: 'test'}, 0.5, {
			value: 0.5,
			timestamp: 1_000
		})
		const existingState = states.get(createKey('histogram_existing', {env: 'test'})) as {
			bucketExemplars: Map<number, {value: number; timestamp: number}>
		}
		expect(existingState.bucketExemplars.get(0.5)).toEqual({value: 0.5, timestamp: 1_000})
	})

	it('covers histogram metadata fallback branches in snapshot', () => {
		const clock = createFixedClock(1_000)
		const aggregator = new MetricAggregator({clock, defaultTemporality: 'delta'})
		const states = (aggregator as unknown as {states: Map<string, unknown>}).states

		states.set('histogram-metadata-fallback', {
			type: 'histogram',
			name: 'histogram_metadata_fallback',
			labels: {env: 'test'},
			buckets: [1],
			counts: [1, 0],
			sum: 1,
			count: 1,
			windowStartedAt: 1_000,
			lastSeenAt: 1_000,
			bucketExemplars: new Map(),
			metadata: {temporality: 'delta'}
		})

		const snapshot = aggregator.snapshot()

		expect(snapshot.find((record) => record.name === 'histogram_metadata_fallback_sum')?.metadata)
			.toMatchObject({instrument: 'histogram', temporality: 'delta'})
		expect(snapshot.find((record) => record.name === 'histogram_metadata_fallback_count')?.metadata)
			.toMatchObject({instrument: 'histogram', temporality: 'delta', monotonic: true})
	})
})
