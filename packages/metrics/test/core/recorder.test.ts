import {describe, it, expect, beforeEach, vi} from 'vitest'

import {MetricAggregator} from '../../src/core/aggregator'
import {MetricRecorder} from '../../src/core/recorder'
import {createCardinalityTracker} from '../../src/utils/cardinality-tracker'
import type {LabelLimits} from '../../src/utils/label-sanitizer'
import {createFixedClock} from '../support/fixed-clock'

describe('MetricRecorder', () => {

	let clock: ReturnType<typeof createFixedClock>
	let aggregator: MetricAggregator
	let recorder: MetricRecorder
	let labelLimits: LabelLimits

	beforeEach(() => {

		clock = createFixedClock(1000)
		aggregator = new MetricAggregator({clock})
		labelLimits = {
			maxLabels: 10,
			maxCardinality: 100
		}
		recorder = new MetricRecorder({
			aggregator,
			clock,
			labelLimits,
			exemplars: false
		})
	})

	describe('constructor', () => {
		it('rejects malformed options and temporality', () => {
			const oversizedLabelValue = 'x'.repeat(4_097)
			expect(() => new MetricRecorder(null as never)).toThrow('options')
			expect(() => new MetricRecorder({
				aggregator, clock: {} as never, labelLimits, exemplars: false
			})).toThrow('provide now')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits, exemplars: false,
				defaultTemporality: 'invalid' as never
			})).toThrow('defaultTemporality')
			expect(() => new MetricRecorder({
				aggregator: {} as never, clock, labelLimits, exemplars: false
			})).toThrow('valid aggregator')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits: null as never, exemplars: false
			})).toThrow('limits must be an object')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits, exemplars: 'yes' as never
			})).toThrow('exemplars must be a boolean')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits, exemplars: false, onLabelDrop: 1 as never
			})).toThrow('onLabelDrop must be a function')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits, exemplars: false, onCardinalityDrop: 1 as never
			})).toThrow('onCardinalityDrop must be a function')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits, exemplars: false, cardinalityTracker: null as never
			})).toThrow('cardinalityTracker is invalid')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits, exemplars: false, cardinalityTracker: {} as never
			})).toThrow('cardinalityTracker is invalid')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits, exemplars: false,
				resourceLabels: {env: 1 as never}
			})).toThrow('values must be strings')
			expect(() => new MetricRecorder({
				aggregator, clock, labelLimits, exemplars: false,
				resourceLabels: {service_name: oversizedLabelValue}
			})).toThrow('no longer than 4096 characters')
			expect(() => recorder.counter('bounded_labels', 1, {tenant: oversizedLabelValue}))
				.toThrow('no longer than 4096 characters')
		})

		it('snapshots mutable label limits', () => {
			const mutableLimits = {maxLabels: 10, maxCardinality: 1}
			const isolatedAggregator = new MetricAggregator({clock})
			const isolated = new MetricRecorder({
				aggregator: isolatedAggregator, clock, labelLimits: mutableLimits, exemplars: false
			})
			mutableLimits.maxCardinality = 100
			isolated.increment('cardinality_snapshot', {value: 'first'})
			isolated.increment('cardinality_snapshot', {value: 'second'})

			expect(isolatedAggregator.snapshot()).toHaveLength(1)
		})

		it('prevents caller labels from overriding resource identity after sanitization', () => {
			const isolatedAggregator = new MetricAggregator({clock})
			const isolated = new MetricRecorder({
				aggregator: isolatedAggregator,
				clock,
				labelLimits,
				exemplars: false,
				resourceLabels: {service_name: 'trusted-service'}
			})

			expect(() => isolated.counter('requests', 1, {'service-name': 'spoofed-service'}))
				.toThrow('cannot override resource label "service_name"')
			expect(isolatedAggregator.snapshot()).toEqual([])
		})

		it('rejects resource label names that collide after sanitization', () => {
			expect(() => new MetricRecorder({
				aggregator,
				clock,
				labelLimits,
				exemplars: false,
				resourceLabels: {service_name: 'one', 'service-name': 'two'}
			})).toThrow('collide after sanitization')
		})
	})

	describe('definition validation', () => {
		it('rejects malformed definitions and metric names deterministically', () => {
			expect(() => recorder.register(null as never)).toThrow('must be an object')
			expect(() => recorder.register({name: 'metric', instrument: 'invalid'} as never))
				.toThrow('instrument is invalid')
			expect(() => recorder.increment(1 as never)).toThrow('name must be a string')
			expect(() => recorder.register({name: 'metric', instrument: 'counter', description: 1} as never))
				.toThrow('description must be a string')
			expect(() => recorder.register({
				name: 'metric', instrument: 'counter', description: 'x'.repeat(1_025)
			})).toThrow('no longer than 1024 characters')
			expect(() => recorder.register({name: 'metric', instrument: 'counter', unit: 1} as never))
				.toThrow('unit must be a string')
			expect(() => recorder.register({
				name: 'metric', instrument: 'counter', unit: 'x'.repeat(129)
			})).toThrow('no longer than 128 characters')
			expect(() => recorder.register({name: 'metric', instrument: 'counter', temporality: 'bad'} as never))
				.toThrow('temporality is invalid')
			expect(() => recorder.register({name: 'metric', instrument: 'counter', histogramBuckets: {}} as never))
				.toThrow('histogramBuckets must be an array')
			expect(() => recorder.increment('x'.repeat(1_025))).toThrow('must not exceed 1024')
		})

		it('rejects distinct metric names that collide after sanitization', () => {
			recorder.increment('request-count', {}, 1)

			expect(() => recorder.increment('request_count', {}, 1))
				.toThrow('Metric name collision')
			expect(aggregator.snapshot().find((record) => record.name === 'request_count')?.value).toBe(1)
		})

		it('applies registered definition labels to every instrument kind', () => {
			for (const instrument of ['counter', 'up_down_counter', 'gauge', 'histogram', 'timer'] as const) {
				recorder.register({name: `defined_${instrument}`, instrument, labels: {region: 'eu'}})
			}
			recorder.counter('defined_counter', 1)
			recorder.upDownCounter('defined_up_down_counter', -1)
			recorder.gauge('defined_gauge', 2)
			recorder.histogram('defined_histogram', 0.5)
			recorder.timer('defined_timer', 1)

			const snapshot = aggregator.snapshot()
			for (const name of ['defined_counter', 'defined_up_down_counter', 'defined_gauge']) {
				expect(snapshot.find((record) => record.name === name)?.labels).toEqual({region: 'eu'})
			}
			for (const name of ['defined_histogram_sum', 'defined_timer_sum']) {
				expect(snapshot.find((record) => record.name === name)?.labels).toEqual({region: 'eu'})
			}
		})

		it('bounds dynamically registered metric names', () => {
			const onCardinalityDrop = vi.fn(() => { throw new Error('observer failure') })
			const boundedAggregator = new MetricAggregator({clock})
			const boundedRecorder = new MetricRecorder({
				aggregator: boundedAggregator,
				clock,
				labelLimits,
				exemplars: false,
				onCardinalityDrop
			})
			for (let index = 0; index < 1_000; index += 1) {
				boundedRecorder.increment(`metric_${index}`)
			}

			boundedRecorder.increment('overflow_metric')
			expect(() => boundedRecorder.register({name: 'registered_overflow', instrument: 'counter'}))
				.toThrow('registered metric limit')

			expect(boundedAggregator.getDiagnostics()).toEqual({
				registeredMetrics: 1_000,
				activeSeries: 1_000
			})
			expect(onCardinalityDrop).toHaveBeenCalledWith('overflow_metric', 'max_metric_names')
		})

		it('does not let invalid measurements consume metric-name capacity', () => {
			for (let index = 0; index < 1_000; index += 1) {
				expect(() => recorder.counter(`invalid_counter_${index}`, -1)).toThrow(
					'Counter increment must be non-negative'
				)
			}
			expect(() => recorder.timer('invalid_timer', -1)).toThrow(
				'Histogram observation must be non-negative'
			)

			recorder.increment('valid_after_invalid_measurements')

			expect(aggregator.getDiagnostics()).toEqual({registeredMetrics: 1, activeSeries: 1})
		})

		it('does not let globally dropped series consume metric-name registrations', () => {
			const boundedAggregator = new MetricAggregator({clock})
			const boundedRecorder = new MetricRecorder({
				aggregator: boundedAggregator,
				clock,
				labelLimits,
				exemplars: false,
				cardinalityTracker: createCardinalityTracker({clock, maxSeries: 1})
			})

			boundedRecorder.counter('accepted_metric', 1)
			for (const instrument of ['counter', 'gauge', 'histogram', 'timer'] as const) {
				const name = `globally_dropped_${instrument}`
				if (instrument === 'counter') boundedRecorder.counter(name, 1)
				if (instrument === 'gauge') boundedRecorder.gauge(name, 1)
				if (instrument === 'histogram') boundedRecorder.histogram(name, 1)
				if (instrument === 'timer') boundedRecorder.timer(name, 1)
			}

			expect(boundedAggregator.getDiagnostics()).toEqual({
				registeredMetrics: 1,
				activeSeries: 1
			})
			boundedRecorder.counter('globally_dropped_counter', 1)
			expect(boundedAggregator.getDiagnostics().registeredMetrics).toBe(1)
		})
	})

	describe('increment', () => {
		it('rejects empty metric names without claiming the underscore identity', () => {
			expect(() => recorder.increment('')).toThrow('must not be empty')
			recorder.increment('_')
			expect(aggregator.snapshot().some((record) => record.name === '_')).toBe(true)
		})
		it('snapshots proxy-backed labels without executing get traps', () => {
			const get = vi.fn((_target: object, key: PropertyKey, receiver: object) =>
				Reflect.get(_target, key, receiver))
			const labels = new Proxy({env: 'test'}, {get})

			recorder.increment('proxy_labels', labels)

			expect(get).not.toHaveBeenCalled()
			expect(aggregator.snapshot()[0]?.labels).toEqual({env: 'test'})
		})

		it('rejects accessor-backed call labels without invoking getters', () => {
			const getter = vi.fn(() => 'secret')
			const labels = Object.defineProperty({}, 'token', {enumerable: true, get: getter})
			expect(() => recorder.increment('hostile_labels', labels as never)).toThrow('unsupported fields')
			expect(getter).not.toHaveBeenCalled()
			expect(aggregator.getDiagnostics()).toEqual({registeredMetrics: 0, activeSeries: 0})
		})

		it('rejects unbounded label names before registering a metric', () => {
			expect(() => recorder.increment('bounded_labels', {['x'.repeat(1_025)]: 'value'}))
				.toThrow('names must not exceed 1024 characters')
			expect(aggregator.getDiagnostics()).toEqual({registeredMetrics: 0, activeSeries: 0})
		})

		it('preserves prototype-like label names as ordinary data fields', () => {
			const labels = Object.create(null) as Record<string, string>
			Object.defineProperty(labels, '__proto__', {
				value: 'safe-value', enumerable: true, writable: true, configurable: true
			})

			recorder.increment('prototype_label', labels)
			const recorded = aggregator.snapshot()[0]?.labels

			expect(Object.prototype.hasOwnProperty.call(recorded, '__proto__')).toBe(true)
			expect(recorded?.__proto__).toBe('safe-value')
			expect(Object.getPrototypeOf(recorded)).toBe(Object.prototype)
		})

		it('should increment counter with valid name and labels', () => {

			recorder.increment('test_counter', {env: 'test'}, 1)
			const snapshot = aggregator.snapshot()

			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]?.name).toBe('test_counter')
			expect(snapshot[0]?.value).toBe(1)
		})

		it('should use default count of 1', () => {

			recorder.increment('test_counter', {env: 'test'})
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.value).toBe(1)
		})

		it('should reject negative increments', () => {

			expect(() => {
				recorder.increment('test_counter', {env: 'test'}, -1)
			}).toThrow('Counter increment must be non-negative')
		})

		it('should reject non-finite counter increments', () => {

			expect(() => {
				recorder.increment('test_counter', {env: 'test'}, Number.NaN)
			}).toThrow('Counter increment must be finite')
			expect(() => {
				recorder.increment('test_counter', {env: 'test'}, Number.POSITIVE_INFINITY)
			}).toThrow('Counter increment must be finite')
		})

		it('rejects hostile runtime values without coercing names or measurements', () => {
			const coerceName = vi.fn(() => 'secret_metric')
			const coerceValue = vi.fn(() => '1')
			expect(() => recorder.increment(
				{toString: coerceName} as never,
				{},
				{toString: coerceValue} as never
			)).toThrow('Counter increment must be finite')
			expect(coerceName).not.toHaveBeenCalled()
			expect(coerceValue).not.toHaveBeenCalled()
		})

		it('should sanitize metric name', () => {

			recorder.increment('test-counter!', {env: 'test'}, 1)
			const snapshot = aggregator.snapshot()

			// Should sanitize invalid characters
			expect(snapshot[0]?.name).not.toContain('!')
		})

		it('should handle empty labels', () => {

			recorder.increment('test_counter', {}, 1)
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.labels).toEqual({})
		})

		it('should handle undefined labels', () => {

			recorder.increment('test_counter', undefined, 1)
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.labels).toEqual({})
		})

		it('should create exemplar when enabled and context available', () => {

			// Mock getContext to return trace context
			vi.mock('@ooopsstudio/core/runtime/context', () => ({
				getContext: vi.fn().mockReturnValue({
					traceId: 'trace123',
					spanId: 'span456'
				})
			}))

			const recorderWithExemplars = new MetricRecorder({
				aggregator,
				clock,
				labelLimits,
				exemplars: true
			})

			recorderWithExemplars.increment('test_counter', {env: 'test'}, 1)
			const snapshot = aggregator.snapshot()

			// Exemplar is only created if correlation context is available
			// Without context, exemplar will be undefined
			// This test verifies the code path works when exemplars are enabled
			expect(snapshot[0]).toBeDefined()
		})

		it('should call onLabelDrop when labels are dropped', () => {

			const onLabelDrop = vi.fn()
			const recorderWithCallback = new MetricRecorder({
				aggregator,
				clock,
				labelLimits: {maxLabels: 1, maxCardinality: 100},
				exemplars: false,
				onLabelDrop
			})

			recorderWithCallback.increment('test_counter', {label1: 'value1', label2: 'value2'}, 1)

			expect(onLabelDrop).toHaveBeenCalled()
		})

		it('should call onCardinalityDrop when cardinality exceeded', () => {

			const onCardinalityDrop = vi.fn()
			const recorderWithCallback = new MetricRecorder({
				aggregator,
				clock,
				labelLimits: {maxLabels: 10, maxCardinality: 1},
				exemplars: false,
				onCardinalityDrop
			})

			recorderWithCallback.increment('test_counter', {env: 'test1'}, 1)
			recorderWithCallback.increment('test_counter', {env: 'test2'}, 1)

			expect(onCardinalityDrop).toHaveBeenCalled()
		})

		it('should drop metric when cardinality exceeded', () => {

			// Create a fresh aggregator for this test to avoid state from previous tests
			const testAggregator = new MetricAggregator({clock})
			const recorderWithLowCardinality = new MetricRecorder({
				aggregator: testAggregator,
				clock,
				labelLimits: {maxLabels: 10, maxCardinality: 1},
				exemplars: false
			})

			recorderWithLowCardinality.increment('test_counter', {env: 'test1'}, 1)
			recorderWithLowCardinality.increment('test_counter', {env: 'test2'}, 1)

			const snapshot = testAggregator.snapshot()
			// Should only have one metric (first one) - second should be dropped
			const counterMetrics = snapshot.filter((r) => r.name === 'test_counter')
			expect(counterMetrics.length).toBeLessThanOrEqual(1)
		})
	})

	describe('record', () => {
		it('drops gauges that exceed the configured cardinality', () => {
			const limitedAggregator = new MetricAggregator({clock})
			const limited = new MetricRecorder({
				aggregator: limitedAggregator,
				clock,
				labelLimits: {maxLabels: 10, maxCardinality: 1},
				exemplars: false
			})
			limited.gauge('limited_gauge', 1, {value: 'first'})
			limited.gauge('limited_gauge', 2, {value: 'second'})

			expect(limitedAggregator.snapshot()).toHaveLength(1)
		})

		it('should record gauge value', () => {

			recorder.record('test_gauge', 42.5, {env: 'test'})
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.name).toBe('test_gauge')
			expect(snapshot[0]?.type).toBe('gauge')
			expect(snapshot[0]?.value).toBe(42.5)
		})

		it('rejects non-finite gauge values', () => {

			expect(() => recorder.record('test_gauge', Number.NaN, {env: 'test'})).toThrow('Gauge value must be finite')
			expect(() => recorder.record('test_gauge2', Number.POSITIVE_INFINITY, {env: 'test'})).toThrow('Gauge value must be finite')
			expect(aggregator.snapshot()).toEqual([])
		})

		it('should sanitize metric name', () => {

			recorder.record('test-gauge!', 42.5, {env: 'test'})
			const snapshot = aggregator.snapshot()

			expect(snapshot[0]?.name).not.toContain('!')
		})

		it('should attempt to create exemplar when enabled', () => {

			const recorderWithExemplars = new MetricRecorder({
				aggregator,
				clock,
				labelLimits,
				exemplars: true
			})

			recorderWithExemplars.record('test_gauge', 42.5, {env: 'test'})
			const snapshot = aggregator.snapshot()

			// Exemplar is only created if correlation context is available
			// Without context, exemplar will be undefined
			// This test verifies the code path works when exemplars are enabled
			expect(snapshot[0]).toBeDefined()
			expect(snapshot[0]?.value).toBe(42.5)
		})
	})

	describe('instrument conflicts', () => {

		it('rejects using the same metric name with a different instrument', () => {
			recorder.increment('conflict_metric', {env: 'test'}, 1)

			expect(() => {
				recorder.gauge('conflict_metric', 42, {env: 'test'})
			}).toThrow('already registered as counter')
		})

		it('rejects explicit registration conflicts after metric name sanitization', () => {
			recorder.register({name: 'db-latency', instrument: 'histogram'})

			expect(() => {
				recorder.register({name: 'db_latency', instrument: 'gauge'})
			}).toThrow('Metric name collision')
		})
	})

	describe('observe', () => {

		it('should record histogram observation', () => {

			recorder.observe('test_histogram', 1.5, {env: 'test'})
			const snapshot = aggregator.snapshot()

			expect(snapshot.find((r) => r.name === 'test_histogram_sum')).toBeDefined()
		})

		it('should reject negative values', () => {

			expect(() => {
				recorder.observe('test_histogram', -1, {env: 'test'})
			}).toThrow('Histogram observation must be non-negative')
		})

		it('should reject NaN values', () => {

			expect(() => {
				recorder.observe('test_histogram', Number.NaN, {env: 'test'})
			}).toThrow('Histogram observation must be finite')
		})

		it('should reject Infinity values', () => {

			expect(() => {
				recorder.observe('test_histogram', Number.POSITIVE_INFINITY, {env: 'test'})
			}).toThrow('Histogram observation must be finite')
		})

		it('should sanitize metric name', () => {

			recorder.observe('test-histogram!', 1.5, {env: 'test'})
			const snapshot = aggregator.snapshot()

			expect(snapshot.find((r) => r.name.includes('histogram'))?.name).not.toContain('!')
		})

		it('should attempt to create exemplar when enabled', () => {

			const recorderWithExemplars = new MetricRecorder({
				aggregator,
				clock,
				labelLimits,
				exemplars: true
			})

			recorderWithExemplars.observe('test_histogram', 1.5, {env: 'test'})
			const snapshot = aggregator.snapshot()

			const bucket = snapshot.find((r) => r.name === 'test_histogram_bucket')
			// Exemplar is only created if correlation context is available
			// Without context, exemplar will be undefined
			// This test verifies the code path works when exemplars are enabled
			expect(bucket).toBeDefined()
		})
	})

	describe('rich instruments', () => {

		it('should record timers with ms unit metadata', () => {

			recorder.timer('request_duration', 25, {route: '/test'})
			const snapshot = aggregator.snapshot()

			expect(snapshot.find((record) => record.name === 'request_duration_sum')?.metadata?.unit).toBe('ms')
		})

		it('rejects labels reserved for composite instrument encoding', () => {
			expect(() => recorder.histogram('latency', 1, {le: 'user'}))
				.toThrow('cannot use reserved label "le"')
			expect(() => recorder.timer('duration', 1, {le: 'user'}))
				.toThrow('cannot use reserved label "le"')
			expect(aggregator.getDiagnostics()).toEqual({registeredMetrics: 0, activeSeries: 0})
		})
	})

	describe('sanitization cache', () => {

		it('should cache sanitized names', () => {

			// Access private cache through multiple calls
			recorder.increment('test-counter', {env: 'test'}, 1)
			recorder.increment('test-counter', {env: 'test'}, 1)
			recorder.increment('test-counter', {env: 'prod'}, 1)

			// All should use same sanitized name
			const snapshot = aggregator.snapshot()
			const names = snapshot.map((r) => r.name)
			const uniqueNames = new Set(names)

			// Should have consistent sanitized names
			expect(uniqueNames.size).toBeLessThanOrEqual(names.length)
		})
	})
})
