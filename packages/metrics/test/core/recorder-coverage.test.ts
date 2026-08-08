import {describe, expect, it} from 'vitest'

import {CARDINALITY_TRACKER_MAX_KEYS} from '../../src/constants'
import {MetricAggregator} from '../../src/core/aggregator'
import {MetricRecorder} from '../../src/core/recorder'
import {createFixedClock} from '../support/fixed-clock'

describe('metric recorder coverage', () => {

	it('covers internal definition and cache branches', () => {
		const clock = createFixedClock(1_000)
		const aggregator = new MetricAggregator({clock})
		const recorder = new MetricRecorder({
			aggregator,
			clock,
			labelLimits: {maxLabels: 10, maxCardinality: 100},
			exemplars: false
		})

		const cache = (recorder as unknown as {sanitizationCache: Map<string, string>}).sanitizationCache
		for (let i = 0; i < CARDINALITY_TRACKER_MAX_KEYS; i++) {
			cache.set(`metric_${i}`, `metric_${i}`)
		}

		const sanitized = (recorder as unknown as {
			getSanitizedName(name: string): string
		}).getSanitizedName('metric-overflow')
		expect(sanitized).toBe('metric_overflow')
		expect(cache.size).toBeLessThanOrEqual(CARDINALITY_TRACKER_MAX_KEYS)

		recorder.register({
			name: 'db.latency',
			instrument: 'histogram',
			unit: 'ms',
			labels: {database: 'primary'},
			histogramBuckets: [1, 5]
		})
		const definition = (recorder as unknown as {
			getDefinition(
				name: string,
				instrument: 'histogram',
				overrides?: {unit?: string}
			): {name: string; unit?: string}
		}).getDefinition('db.latency', 'histogram', {unit: 'seconds'})
		expect(definition.name).toBe('db_latency')
		expect(definition.unit).toBe('ms')
	})

	it('covers dropped normalization paths', () => {
		const clock = createFixedClock(1_000)
		const aggregator = new MetricAggregator({clock})
		const recorder = new MetricRecorder({
			aggregator,
			clock,
			labelLimits: {maxLabels: 10, maxCardinality: 1},
			exemplars: false
		})

		recorder.counter('limited_counter', 1, {env: 'a'})
		recorder.counter('limited_counter', 2, {env: 'b'})

		expect(aggregator.snapshot().some((record) => record.name === 'limited_counter')).toBe(true)
	})
})
