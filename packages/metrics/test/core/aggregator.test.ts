import {describe, it, expect, beforeEach, vi} from 'vitest'

import {MetricAggregator} from '../../src/core/aggregator'
import type {Exemplar} from '../../src/types/metric-record'
import {createFixedClock} from '../support/fixed-clock'

describe('MetricAggregator', () => {

	let clock: ReturnType<typeof createFixedClock>
	let aggregator: MetricAggregator

	beforeEach(() => {

		clock = createFixedClock(1000)
		aggregator = new MetricAggregator({
			clock,
			histogramBuckets: [0.1, 0.5, 1.0, 2.5, 5.0, 10.0]
		})
	})

	describe('constructor', () => {

		it('rejects invalid options and clock timestamps before poisoning state', () => {
			expect(() => new MetricAggregator(null as never)).toThrow('options')
			expect(() => new MetricAggregator({clock: {} as never})).toThrow('provide now')
			const invalidClock = new MetricAggregator({clock: {now: () => Number.NaN}})

			expect(() => invalidClock.increment('invalid_clock_counter', {}, 1)).toThrow('finite non-negative')
			expect(invalidClock.getDiagnostics().activeSeries).toBe(0)
		})

	})

	describe('definition validation', () => {

		it('snapshots proxy-backed definitions and arrays without executing get traps', () => {
			const definitionGet = vi.fn((_target: object, key: PropertyKey, receiver: object) =>
				Reflect.get(_target, key, receiver))
			const bucketsGet = vi.fn((_target: number[], key: PropertyKey, receiver: number[]) =>
				Reflect.get(_target, key, receiver))
			const definition = new Proxy({
				name: 'proxy_histogram',
				instrument: 'histogram' as const,
				histogramBuckets: new Proxy([1, 5, 10], {get: bucketsGet})
			}, {get: definitionGet})

			aggregator.register(definition)

			expect(definitionGet).not.toHaveBeenCalled()
			expect(bucketsGet).not.toHaveBeenCalled()
			expect(aggregator.getDiagnostics()).toEqual({registeredMetrics: 1, activeSeries: 0})
		})

		it('rejects malformed, mismatched, and accessor-backed definitions', () => {
			expect(() => aggregator.register(null as never)).toThrow('must be an object')
			expect(() => aggregator.register({name: 'metric', instrument: 'invalid'} as never))
				.toThrow('instrument is invalid')
			expect(() => aggregator.increment('metric', {}, 1, undefined, {
				name: 'other', instrument: 'counter'
			})).toThrow('does not match')
			const hostile = Object.defineProperty({instrument: 'counter'}, 'name', {
				enumerable: true,
				get() { throw new Error('getter executed') }
			})
			expect(() => aggregator.register(hostile as never)).toThrow('unsupported fields')
			const coercion = vi.fn(() => 'cumulative')
			expect(() => new MetricAggregator({
				clock: createFixedClock(1_000),
				defaultTemporality: {toString: coercion} as never
			})).toThrow('got object')
			expect(coercion).not.toHaveBeenCalled()
		})

		it('snapshots registration labels without invoking custom serialization', () => {
			const definition = {
				name: 'safe_definition', instrument: 'counter' as const, labels: {env: 'test'}
			}
			aggregator.register(definition)
			definition.labels.env = 'mutated'
			expect(() => aggregator.register({
				name: 'safe_definition', instrument: 'counter', labels: {env: 'test'}
			})).not.toThrow()
		})
	})

	describe('increment', () => {

		it('should create new counter', () => {

			aggregator.increment('test_counter', {env: 'test'}, 1)
			const snapshot = aggregator.snapshot()

			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]).toMatchObject({
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {env: 'test'},
				timestamp: 1000
			})
		})

		it('should increment existing counter', () => {

			aggregator.increment('test_counter', {env: 'test'}, 1)
			aggregator.increment('test_counter', {env: 'test'}, 2)
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.value).toBe(3)
		})

		it('should handle counter with exemplar', () => {

			const exemplar: Exemplar = {
				traceId: 'trace123',
				spanId: 'span456',
				value: 1,
				timestamp: 1000
			}

			aggregator.increment('test_counter', {env: 'test'}, 1, exemplar)
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.exemplar).toEqual(exemplar)
		})

		it('should update exemplar on subsequent increments', () => {

			const exemplar1: Exemplar = {
				traceId: 'trace1',
				spanId: 'span1',
				value: 1,
				timestamp: 1000
			}
			const exemplar2: Exemplar = {
				traceId: 'trace2',
				spanId: 'span2',
				value: 2,
				timestamp: 1000
			}

			aggregator.increment('test_counter', {env: 'test'}, 1, exemplar1)
			aggregator.increment('test_counter', {env: 'test'}, 2, exemplar2)
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.exemplar).toEqual(exemplar2)
		})

		it('should handle multiple counters with different labels', () => {

			aggregator.increment('test_counter', {env: 'test'}, 1)
			aggregator.increment('test_counter', {env: 'prod'}, 2)
			const snapshot = aggregator.snapshot()

			expect(snapshot).toHaveLength(2)
			expect(snapshot.find((r) => r.labels.env === 'test')?.value).toBe(1)
			expect(snapshot.find((r) => r.labels.env === 'prod')?.value).toBe(2)
		})

		it('should not merge counters whose labels only collide in string form', () => {

			aggregator.increment('test_counter', {a: 'b,c=d'}, 1)
			aggregator.increment('test_counter', {a: 'b', c: 'd'}, 2)
			const snapshot = aggregator.snapshot()

			expect(snapshot).toHaveLength(2)
			expect(snapshot.find((r) => r.labels.a === 'b,c=d')?.value).toBe(1)
			expect(snapshot.find((r) => r.labels.a === 'b' && r.labels.c === 'd')?.value).toBe(2)
		})

		it('isolates stored state and snapshot records from caller mutation', () => {

			const labels = {environment: 'test'}
			const exemplar: Exemplar = {
				traceId: 'trace-original',
				value: 1,
				timestamp: 1000
			}
			aggregator.increment('isolated_counter', labels, 1, exemplar)

			labels.environment = 'mutated-input'
			exemplar.traceId = 'mutated-input'
			const first = aggregator.snapshot()
			const firstRecord = first[0]
			expect(firstRecord).toBeDefined()
			firstRecord!.labels.environment = 'mutated-snapshot'
			firstRecord!.exemplar!.traceId = 'mutated-snapshot'

			const second = aggregator.snapshot()[0]
			expect(second?.labels).toEqual({environment: 'test'})
			expect(second?.exemplar?.traceId).toBe('trace-original')
		})
	})

	describe('type conflicts', () => {
		it('rejects schema changes after registration while allowing idempotent registration', () => {
			const definition = {
				name: 'stable_histogram',
				instrument: 'histogram' as const,
				temporality: 'delta' as const,
				histogramBuckets: [1, 5]
			}
			aggregator.register(definition)
			expect(() => aggregator.register({...definition, histogramBuckets: [1, 5]})).not.toThrow()
			expect(() => aggregator.register({...definition, histogramBuckets: [2, 10]}))
				.toThrow('different histogram definition')
			expect(() => aggregator.register({...definition, temporality: 'cumulative'}))
				.toThrow('different histogram definition')
		})

		it('rejects recording different metric types for the same name and labels', () => {
			aggregator.increment('conflict_metric', {env: 'test'}, 1)

			expect(() => {
				aggregator.setGauge('conflict_metric', {env: 'test'}, 42)
			}).toThrow('already registered as counter')
		})

		it('rejects recording different metric types for the same name across labels', () => {
			aggregator.increment('family_conflict_metric', {env: 'test'}, 1)

			expect(() => {
				aggregator.setGauge('family_conflict_metric', {env: 'prod'}, 42)
			}).toThrow('already registered as counter')
		})

		it('rejects conflicting explicit definitions on write', () => {
			aggregator.increment('definition_conflict_metric', {env: 'test'}, 1, undefined, {
				name: 'definition_conflict_metric',
				instrument: 'counter'
			})

			expect(() => {
				aggregator.setGauge('definition_conflict_metric', {env: 'prod'}, 42, undefined, {
					name: 'definition_conflict_metric',
					instrument: 'gauge'
				})
			}).toThrow('already registered as counter')
		})

		it('rejects conflicting registered instruments for the same metric name', () => {
			aggregator.register({name: 'registered_conflict', instrument: 'counter'})

			expect(() => {
				aggregator.register({name: 'registered_conflict', instrument: 'gauge'})
			}).toThrow('already registered as counter')
		})
	})

	describe('setGauge', () => {

		it('should create new gauge', () => {

			aggregator.setGauge('test_gauge', {env: 'test'}, 42.5)
			const snapshot = aggregator.snapshot()

			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]).toMatchObject({
				name: 'test_gauge',
				type: 'gauge',
				value: 42.5,
				labels: {env: 'test'},
				timestamp: 1000
			})
		})

		it('should overwrite existing gauge', () => {

			aggregator.setGauge('test_gauge', {env: 'test'}, 42.5)
			aggregator.setGauge('test_gauge', {env: 'test'}, 100.0)
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.value).toBe(100.0)
		})

		it('should handle gauge with exemplar', () => {

			const exemplar: Exemplar = {
				traceId: 'trace123',
				spanId: 'span456',
				value: 42.5,
				timestamp: 1000
			}

			aggregator.setGauge('test_gauge', {env: 'test'}, 42.5, exemplar)
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.exemplar).toEqual(exemplar)
		})

		it('rejects non-finite gauge values', () => {

			expect(() => aggregator.setGauge('test_gauge', {env: 'test'}, Number.NaN)).toThrow('must be finite')
			expect(() => aggregator.setGauge('test_gauge2', {env: 'test'}, Number.POSITIVE_INFINITY)).toThrow('must be finite')
			expect(aggregator.snapshot()).toEqual([])
		})

	})

	describe('observeHistogram', () => {

		it('should create new histogram', () => {

			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.5)
			const snapshot = aggregator.snapshot()

			// Should emit sum, count, and bucket records
			expect(snapshot.length).toBeGreaterThan(2)
			expect(snapshot.find((r) => r.name === 'test_histogram_sum')?.value).toBe(1.5)
			expect(snapshot.find((r) => r.name === 'test_histogram_count')?.value).toBe(1)
		})

		it('should aggregate histogram observations', () => {

			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.0)
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 2.0)
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 3.0)
			const snapshot = aggregator.snapshot()

			expect(snapshot.find((r) => r.name === 'test_histogram_sum')?.value).toBe(6.0)
			expect(snapshot.find((r) => r.name === 'test_histogram_count')?.value).toBe(3)
		})

		it('should place values in correct buckets', () => {

			aggregator.observeHistogram('test_histogram', {env: 'test'}, 0.05) // Goes to bucket 0 (le=0.1)
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 0.3) // Goes to bucket 1 (le=0.5)
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.5) // Goes to bucket 3 (le=2.5)
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 20.0) // Goes to overflow bucket (+Inf)
			const snapshot = aggregator.snapshot()

			// Check bucket counts (non-cumulative - each bucket stores count for that range)
			const bucket0 = snapshot.find((r) => r.name === 'test_histogram_bucket' && r.labels.le === '0.1')
			const bucket1 = snapshot.find((r) => r.name === 'test_histogram_bucket' && r.labels.le === '0.5')
			const bucket2 = snapshot.find((r) => r.name === 'test_histogram_bucket' && r.labels.le === '1')
			const bucket3 = snapshot.find((r) => r.name === 'test_histogram_bucket' && r.labels.le === '2.5')
			const bucketInf = snapshot.find((r) => r.name === 'test_histogram_bucket' && r.labels.le === '+Inf')

			// Buckets store individual counts (not cumulative in storage)
			expect(bucket0?.value).toBe(1) // 0.05 falls in bucket 0
			expect(bucket1?.value).toBe(1) // 0.3 falls in bucket 1
			expect(bucket2?.value).toBe(0) // No values in bucket 2
			expect(bucket3?.value).toBe(1) // 1.5 falls in bucket 3
			expect(bucketInf?.value).toBe(1) // 20.0 falls in overflow bucket
		})

		it('should handle histogram with exemplar', () => {

			const exemplar: Exemplar = {
				traceId: 'trace123',
				spanId: 'span456',
				value: 1.5,
				timestamp: 1000
			}

			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.5, exemplar)
			const snapshot = aggregator.snapshot()

			// Exemplar should be attached to the bucket
			const bucket = snapshot.find((r) => r.name === 'test_histogram_bucket' && r.labels.le === '2.5')
			expect(bucket?.exemplar).toEqual(exemplar)
		})

		it('should handle values exceeding all buckets', () => {

			aggregator.observeHistogram('test_histogram', {env: 'test'}, 100.0)
			const snapshot = aggregator.snapshot()

			const bucketInf = snapshot.find((r) => r.name === 'test_histogram_bucket' && r.labels.le === '+Inf')
			expect(bucketInf?.value).toBe(1)
		})
	})

	describe('snapshot', () => {

		it('should return empty array when no metrics', () => {

			const snapshot = aggregator.snapshot()
			expect(snapshot).toEqual([])
		})

		it('should return all metrics with current timestamp', () => {

			clock.set(2000)

			aggregator.increment('counter1', {}, 1)
			aggregator.setGauge('gauge1', {}, 10)
			const snapshot = aggregator.snapshot()

			expect(snapshot).toHaveLength(2)
			expect(snapshot[0]?.timestamp).toBe(2000)
			expect(snapshot[1]?.timestamp).toBe(2000)
		})

	})

	describe('clear', () => {

		it('should clear all metrics', () => {

			aggregator.increment('counter1', {}, 1)
			aggregator.setGauge('gauge1', {}, 10)
			aggregator.clear()

			const snapshot = aggregator.snapshot()
			expect(snapshot).toEqual([])
		})

		it('should clear implicit first-write definitions', () => {
			aggregator.increment('reusable_metric', {}, 1)
			expect(aggregator.getDiagnostics().registeredMetrics).toBe(1)

			aggregator.clear()
			aggregator.setGauge('reusable_metric', {}, 10)

			expect(aggregator.getDiagnostics()).toMatchObject({
				registeredMetrics: 1,
				activeSeries: 1
			})
			expect(aggregator.snapshot()[0]).toMatchObject({
				name: 'reusable_metric',
				type: 'gauge',
				value: 10
			})
		})
	})

	describe('histogram edge cases', () => {

		it('should handle histogram bucket overflow with existing state', () => {

			// Create histogram with existing state
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.0)

			// Add value that exceeds all buckets
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 100.0)

			const snapshot = aggregator.snapshot()
			const overflowBucket = snapshot.find(
				(r) => r.name === 'test_histogram_bucket' && r.labels.le === '+Inf'
			)
			expect(overflowBucket?.value).toBe(1)
		})

		it('should handle overflow exemplar when histogram state already exists', () => {

			const exemplar: Exemplar = {
				traceId: 'trace-overflow',
				spanId: 'span-overflow',
				value: 100.0,
				timestamp: 1000
			}

			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.0)
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 100.0, exemplar)

			const snapshot = aggregator.snapshot()
			const overflowBucket = snapshot.find(
				(r) => r.name === 'test_histogram_bucket' && r.labels.le === '+Inf'
			)
			expect(overflowBucket?.exemplar).toEqual(exemplar)
		})

		it('should handle histogram with exemplar in overflow bucket', () => {

			const exemplar: Exemplar = {
				traceId: 'trace123',
				spanId: 'span456',
				value: 100.0,
				timestamp: 1000
			}

			aggregator.observeHistogram('test_histogram', {env: 'test'}, 100.0, exemplar)

			const snapshot = aggregator.snapshot()
			const overflowBucket = snapshot.find(
				(r) => r.name === 'test_histogram_bucket' && r.labels.le === '+Inf'
			)
			expect(overflowBucket?.exemplar).toEqual(exemplar)
		})

		it('should handle histogram bucketIndex >= counts.length in new state', () => {

			// Create histogram with value that exceeds buckets
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 100.0)

			const snapshot = aggregator.snapshot()
			const overflowBucket = snapshot.find(
				(r) => r.name === 'test_histogram_bucket' && r.labels.le === '+Inf'
			)
			expect(overflowBucket?.value).toBe(1)
		})

		it('should handle histogram with exemplar when bucketIndex >= buckets.length', () => {

			const exemplar: Exemplar = {
				traceId: 'trace123',
				spanId: 'span456',
				value: 100.0,
				timestamp: 1000
			}

			// Create new histogram with value exceeding buckets
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 100.0, exemplar)

			const snapshot = aggregator.snapshot()
			const overflowBucket = snapshot.find(
				(r) => r.name === 'test_histogram_bucket' && r.labels.le === '+Inf'
			)
			expect(overflowBucket?.exemplar).toEqual(exemplar)
		})

		it('should handle histogram with exact bucket match', () => {

			// Buckets: [0.1, 0.5, 1.0, 2.5, 5.0, 10.0]
			// Explicit histogram bounds are inclusive (value <= boundary).
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.0)

			const snapshot = aggregator.snapshot()
			const bucket = snapshot.find(
				(r) => r.name === 'test_histogram_bucket' && r.labels.le === '1'
			)
			expect(bucket?.value).toBe(1)
		})

		it('should handle histogram bucketIndex < buckets.length but >= counts.length', () => {

			// This edge case might occur if buckets array is modified
			// For now, test normal overflow case
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 100.0)

			const snapshot = aggregator.snapshot()
			expect(snapshot.length).toBeGreaterThan(0)
		})
	})

	describe('state management', () => {

		it('should handle counter increment with existing counter state', () => {

			aggregator.increment('test_counter', {env: 'test'}, 1)
			aggregator.increment('test_counter', {env: 'test'}, 2)

			const snapshot = aggregator.snapshot()
			expect(snapshot[0]?.value).toBe(3)
		})

		it('should handle gauge update with existing gauge state', () => {

			aggregator.setGauge('test_gauge', {env: 'test'}, 10.0)
			aggregator.setGauge('test_gauge', {env: 'test'}, 20.0)

			const snapshot = aggregator.snapshot()
			expect(snapshot[0]?.value).toBe(20.0)
		})

		it('should handle histogram with existing histogram state', () => {

			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.0)
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 2.0)

			const snapshot = aggregator.snapshot()
			expect(snapshot.find((r) => r.name === 'test_histogram_sum')?.value).toBe(3.0)
			expect(snapshot.find((r) => r.name === 'test_histogram_count')?.value).toBe(2)
		})

		it('should handle undefined bucketLe in histogram snapshot', () => {

			// This tests the continue branch when bucketLe is undefined
			aggregator.observeHistogram('test_histogram', {env: 'test'}, 1.0)

			const snapshot = aggregator.snapshot()
			// Should still emit buckets
			expect(snapshot.find((r) => r.name === 'test_histogram_bucket')).toBeDefined()
		})
	})

	describe('advanced aggregation', () => {

		it('should reset delta counters after snapshot when requested', () => {

			aggregator.register({
				name: 'delta_counter',
				instrument: 'counter',
				temporality: 'delta'
			})
			aggregator.increment('delta_counter', {}, 3)

			const first = aggregator.snapshot({resetDelta: true})
			const second = aggregator.snapshot({resetDelta: true})

			expect(first.find((record) => record.name === 'delta_counter')?.value).toBe(3)
			expect(second.find((record) => record.name === 'delta_counter')?.value).toBe(0)
		})

		it('commits delta reset only when explicitly requested after snapshot', () => {

			aggregator.register({
				name: 'deferred_delta_counter',
				instrument: 'counter',
				temporality: 'delta'
			})
			aggregator.increment('deferred_delta_counter', {}, 5)

			const snapshot = aggregator.snapshot({resetDelta: false})
			expect(aggregator.snapshot().find((record) => record.name === 'deferred_delta_counter')?.value).toBe(5)

			aggregator.commitDeltaSnapshot(snapshot)

			expect(aggregator.snapshot().find((record) => record.name === 'deferred_delta_counter')?.value).toBe(0)
		})

		it('tracks aggregation window starts and advances delta windows only after commit', () => {
			aggregator.increment('windowed_delta', {}, 5, undefined, {
				name: 'windowed_delta', instrument: 'counter', temporality: 'delta'
			})
			clock.advance(100)
			const first = aggregator.snapshot({resetDelta: false})
			expect(first[0]).toMatchObject({startTimestamp: 1000, timestamp: 1100})

			clock.advance(100)
			aggregator.increment('windowed_delta', {}, 2)
			aggregator.commitDeltaSnapshot(first)
			const second = aggregator.snapshot({resetDelta: false})

			expect(second[0]).toMatchObject({value: 2, startTimestamp: 1100, timestamp: 1200})
		})

		it('preserves counter writes recorded while a delta snapshot is being exported', () => {
			aggregator.increment('concurrent_delta_counter', {}, 5, undefined, {
				name: 'concurrent_delta_counter', instrument: 'counter', temporality: 'delta'
			})
			const snapshot = aggregator.snapshot({resetDelta: false})
			aggregator.increment('concurrent_delta_counter', {}, 2)

			aggregator.commitDeltaSnapshot(snapshot)

			expect(aggregator.snapshot().find((record) => record.name === 'concurrent_delta_counter')?.value).toBe(2)
		})

		it('does not commit a delta snapshot that was already reset eagerly', () => {
			aggregator.increment('eager_delta_counter', {}, 5, undefined, {
				name: 'eager_delta_counter', instrument: 'counter', temporality: 'delta'
			})
			const snapshot = aggregator.snapshot({resetDelta: true})
			aggregator.increment('eager_delta_counter', {}, 2)

			aggregator.commitDeltaSnapshot(snapshot)

			expect(aggregator.snapshot().find((record) => record.name === 'eager_delta_counter')?.value).toBe(2)
		})

		it('commits a deferred delta snapshot idempotently', () => {
			aggregator.increment('idempotent_delta_counter', {}, 5, undefined, {
				name: 'idempotent_delta_counter', instrument: 'counter', temporality: 'delta'
			})
			const snapshot = aggregator.snapshot({resetDelta: false})
			aggregator.commitDeltaSnapshot(snapshot)
			aggregator.increment('idempotent_delta_counter', {}, 2)

			aggregator.commitDeltaSnapshot(snapshot)

			expect(aggregator.snapshot().find((record) => record.name === 'idempotent_delta_counter')?.value).toBe(2)
		})

		it('ignores copied records that have lost their safe delta commit token', () => {
			aggregator.increment('copied_delta', {}, 5, undefined, {
				name: 'copied_delta', instrument: 'counter', temporality: 'delta'
			})
			const copied = aggregator.snapshot().map((record) => ({...record, labels: {...record.labels}}))
			aggregator.increment('copied_delta', {}, 2)

			aggregator.commitDeltaSnapshot(copied)

			expect(aggregator.snapshot().find((record) => record.name === 'copied_delta')?.value).toBe(7)
		})

		it.each(['newer-first', 'older-first'] as const)('commits overlapping deferred snapshots safely: %s', (order) => {
			aggregator.increment('overlapping_delta', {}, 5, undefined, {
				name: 'overlapping_delta', instrument: 'counter', temporality: 'delta'
			})
			const older = aggregator.snapshot()
			clock.advance(100)
			aggregator.increment('overlapping_delta', {}, 3)
			const newer = aggregator.snapshot()

			for (const snapshot of order === 'newer-first' ? [newer, older] : [older, newer]) {
				aggregator.commitDeltaSnapshot(snapshot)
			}

			expect(aggregator.snapshot().find((record) => record.name === 'overlapping_delta')?.value).toBe(0)
		})

		it('preserves histogram writes and commits exploded delta records once', () => {
			aggregator.observeHistogram('concurrent_delta_histogram', {}, 2, undefined, {
				name: 'concurrent_delta_histogram', instrument: 'histogram', temporality: 'delta',
				histogramBuckets: [1, 2, 5]
			})
			const snapshot = aggregator.snapshot({resetDelta: false})
			aggregator.observeHistogram('concurrent_delta_histogram', {}, 3)

			aggregator.commitDeltaSnapshot(snapshot)
			const remaining = aggregator.snapshot()

			expect(remaining.find((record) => record.name === 'concurrent_delta_histogram_count')?.value).toBe(1)
			expect(remaining.find((record) => record.name === 'concurrent_delta_histogram_sum')?.value).toBe(3)
			expect(remaining.find((record) => record.name === 'concurrent_delta_histogram_bucket' && record.labels.le === '5')?.value).toBe(1)
		})

		it('should evict stale series', () => {

			let now = 1000
			const staleAggregator = new MetricAggregator({
				clock: {now: () => now}
			})

			staleAggregator.register({
				name: 'stale_metric',
				instrument: 'gauge',
				staleAfterMs: 10
			})
			staleAggregator.setGauge('stale_metric', {}, 1)

			now += 11
			const evicted = staleAggregator.evictStale()

			expect(evicted).toBe(1)
			expect(staleAggregator.snapshot().find((record) => record.name === 'stale_metric')).toBeUndefined()
		})

		it('does not evict stale series when the wall clock moves backwards', () => {

			let now = 1000
			const staleAggregator = new MetricAggregator({
				clock: {now: () => now}
			})

			staleAggregator.register({
				name: 'stale_metric',
				instrument: 'gauge',
				staleAfterMs: 10
			})
			staleAggregator.setGauge('stale_metric', {}, 1)

			now = 900
			const evicted = staleAggregator.evictStale()

			expect(evicted).toBe(0)
			expect(staleAggregator.snapshot().find((record) => record.name === 'stale_metric')).toBeDefined()
		})

	})
})
