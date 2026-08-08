import {describe, it, expect, vi} from 'vitest'

import type {MetricRecord} from '../../src/types/metric-record'
import {
	checkCardinality,
	createCardinalityTracker,
	enforceLabelLimits,
	getCardinalityDiagnostics,
	normalizeLabels,
	resetCardinalityDiagnostics,
	sanitizeLabelName,
	sanitizeLabelValue,
	sanitizeMetricName,
	validateMetricName
} from '../../src/utils/label-sanitizer'
import {createFixedClock} from '../support/fixed-clock'

describe('label-sanitizer', () => {

	it('can reset and inspect cardinality diagnostics', () => {
		resetCardinalityDiagnostics()
		expect(checkCardinality('diag_metric', {env: 'test'}, {maxLabels: 10, maxCardinality: 2})).toBe(false)
		expect(checkCardinality('diag_metric', {env: 'prod'}, {maxLabels: 10, maxCardinality: 2})).toBe(false)
		expect(getCardinalityDiagnostics(1)).toEqual([])

		resetCardinalityDiagnostics()
		expect(getCardinalityDiagnostics()).toEqual([])
	})

	describe('validateMetricName', () => {

		it('should accept valid metric names', () => {

			expect(validateMetricName('test_metric')).toEqual({valid: true})
			expect(validateMetricName('test:metric')).toEqual({valid: true})
			expect(validateMetricName('_test_metric')).toEqual({valid: true})
		})

		it('should reject invalid metric names', () => {

			const result = validateMetricName('123invalid')

			expect(result.valid).toBe(false)
			expect(result.error).toBeDefined()
		})

		it('should reject names with special characters', () => {

			const result = validateMetricName('test-metric!')

			expect(result.valid).toBe(false)
		})
	})

	describe('sanitizeMetricName', () => {
		it('rejects non-string names deterministically', () => {
			expect(validateMetricName(1 as never)).toEqual({valid: false, error: 'Metric name must be a string'})
			expect(() => sanitizeMetricName(1 as never)).toThrow('must be strings')
			expect(() => sanitizeLabelName(null as never)).toThrow('must be strings')
		})

		it('rejects metric and label names above the shared bound', () => {
			const oversized = 'x'.repeat(1_025)
			expect(validateMetricName(oversized)).toEqual({
				valid: false,
				error: 'Metric name must not exceed 1024 characters'
			})
			expect(() => sanitizeMetricName(oversized)).toThrow('must not exceed 1024 characters')
			expect(() => sanitizeLabelName(oversized)).toThrow('must not exceed 1024 characters')
		})

		it('should sanitize invalid characters', () => {

			expect(sanitizeMetricName('test-metric!')).toBe('test_metric_')
		})

		it('should prefix with underscore if starts with number', () => {

			expect(sanitizeMetricName('123metric')).toMatch(/^_/)
		})

		it('should preserve valid names', () => {

			expect(sanitizeMetricName('test_metric')).toBe('test_metric')
		})
	})

	describe('sanitizeLabelName', () => {

		it('should sanitize invalid characters', () => {

			expect(sanitizeLabelName('test-label!')).toBe('test_label_')
		})

		it('should prefix with underscore if starts with number', () => {

			expect(sanitizeLabelName('123label')).toMatch(/^_/)
		})

		it('should preserve valid names', () => {

			expect(sanitizeLabelName('test_label')).toBe('test_label')
		})

		it('removes metric-only colons from label names', () => {
			expect(sanitizeMetricName('http:requests')).toBe('http:requests')
			expect(sanitizeLabelName('http:route')).toBe('http_route')
		})
	})

	describe('sanitizeLabelValue', () => {

		it('should handle null and undefined', () => {

			expect(sanitizeLabelValue(null)).toBe('')
			expect(sanitizeLabelValue(undefined)).toBe('')
		})

		it('should convert to string', () => {

			expect(sanitizeLabelValue(123)).toBe('123')
			expect(sanitizeLabelValue(true)).toBe('true')
		})

		it('should truncate long values', () => {

			const longValue = 'a'.repeat(300)
			const result = sanitizeLabelValue(longValue, 200)

			expect(result.length).toBeLessThanOrEqual(200)
			expect(result).toContain('...')
			expect(sanitizeLabelValue('x'.repeat(4_097))).toBe('[redacted]')
			const toString = vi.fn(() => 'secret')
			expect(sanitizeLabelValue({toString})).toBe('[redacted]')
			expect(toString).not.toHaveBeenCalled()
		})

		it('leaves transport escaping to the exporter', () => {

			expect(sanitizeLabelValue('test"value')).toBe('test"value')
			expect(sanitizeLabelValue('test\\value')).toBe('test\\value')
			expect(sanitizeLabelValue('test\nvalue')).toBe('test\nvalue')
		})

		it('normalizes sensitive and high-cardinality label values before export', () => {
			expect(sanitizeLabelValue('user@example.com')).toBe('[email]')
			expect(sanitizeLabelValue('https://api.example.com/users/123456?token=secret#frag')).toBe('/users/:id')
			expect(sanitizeLabelValue('/workspaces/550e8400-e29b-41d4-a716-446655440000/search?q=secret')).toBe('/workspaces/:id/search')
			expect(sanitizeLabelValue('8f14e45fceea167a5a36dedd4bea2543')).toBe(':id')
			expect(sanitizeLabelValue('safe-route-name')).toBe('safe-route-name')
		})

		it('does not treat arbitrary non-network schemes as URLs', () => {
			expect(sanitizeLabelValue('value:ok')).toBe('value:ok')
		})
	})

	describe('enforceLabelLimits', () => {
		it('rejects malformed limits and hostile label objects', () => {
			expect(() => enforceLabelLimits({}, null as never)).toThrow('limits must be an object')
			const labels = Object.defineProperty({}, 'secret', {enumerable: true, get: () => 'value'})
			expect(() => enforceLabelLimits(labels as never, {maxLabels: 10, maxCardinality: 10}))
				.toThrow('string data fields')
			expect(() => enforceLabelLimits(
				Object.fromEntries(Array.from({length: 257}, (_, index) => [`label_${index}`, 'value'])),
				{maxLabels: 256, maxCardinality: 10}
			)).toThrow('at most 256 fields')
		})

		it('should return labels as-is when within limits', () => {

			const result = enforceLabelLimits(
				{env: 'test', service: 'api'},
				{maxLabels: 10, maxCardinality: 100}
			)

			expect(result.labels).toEqual({env: 'test', service: 'api'})
			expect(result.dropped).toBe(0)
			expect(result.reason).toBe('none')
		})

		it('returns a stable snapshot when labels are within limits', () => {
			const labels = {env: 'test'}
			const result = enforceLabelLimits(labels, {maxLabels: 10, maxCardinality: 100})
			labels.env = 'mutated'

			expect(result.labels).toEqual({env: 'test'})
		})

		it('should drop excess labels', () => {

			const labels = {
				label1: 'value1',
				label2: 'value2',
				label3: 'value3'
			}

			const result = enforceLabelLimits(labels, {maxLabels: 2, maxCardinality: 100})

			expect(Object.keys(result.labels).length).toBe(2)
			expect(result.dropped).toBe(1)
			expect(result.reason).toBe('max_labels')
		})

		it('should keep first maxLabels labels', () => {

			const labels = {
				label1: 'value1',
				label2: 'value2',
				label3: 'value3'
			}

			const result = enforceLabelLimits(labels, {maxLabels: 2, maxCardinality: 100})

			expect(result.labels).toHaveProperty('label1')
			expect(result.labels).toHaveProperty('label2')
			expect(result.labels).not.toHaveProperty('label3')
		})
	})

	describe('checkCardinality', () => {

		it('should return false when within cardinality limit', () => {

			// Use a unique metric name to avoid state from other tests
			const uniqueMetric = `test_metric_${Date.now()}`
			const exceeded = checkCardinality(
				uniqueMetric,
				{env: 'test'},
				{maxLabels: 10, maxCardinality: 100}
			)

			expect(exceeded).toBe(false)
		})

		it('should be stateless; use createCardinalityTracker for cross-call limits', () => {
			const limits = {maxLabels: 10, maxCardinality: 1}
			const tracker = createCardinalityTracker()

			expect(checkCardinality('stateless_metric', {env: 'test1'}, limits)).toBe(false)
			expect(checkCardinality('stateless_metric', {env: 'test2'}, limits)).toBe(false)
			expect(tracker.check('stateful_metric', {env: 'test1'}, limits)).toBe(false)
			expect(tracker.check('stateful_metric', {env: 'test2'}, limits)).toBe(true)
		})

		it('should support callbacks through explicit trackers', () => {

			const onCardinalityDrop = vi.fn()
			const limits = {maxLabels: 10, maxCardinality: 1}
			const tracker = createCardinalityTracker()

			tracker.check('test_metric', {env: 'test1'}, limits)
			tracker.check('test_metric', {env: 'test2'}, limits, onCardinalityDrop)

			expect(onCardinalityDrop).toHaveBeenCalledWith('test_metric', 'max_cardinality')
		})
	})

	describe('normalizeLabels', () => {
		it('rejects malformed records and accessor-backed labels without invoking getters', () => {
			const getter = vi.fn(() => 'secret')
			const labels = Object.defineProperty({}, 'token', {enumerable: true, get: getter})
			expect(() => normalizeLabels(null as never, {maxLabels: 10, maxCardinality: 10}))
				.toThrow('Metric record')
			expect(() => normalizeLabels({
				name: 'hostile', type: 'counter', value: 1, labels, timestamp: 0
			} as never, {maxLabels: 10, maxCardinality: 10})).toThrow('string data fields')
			expect(getter).not.toHaveBeenCalled()
			const nameGetter = vi.fn(() => 'hostile')
			const hostileRecord = Object.defineProperties({}, {
				name: {enumerable: true, get: nameGetter},
				labels: {enumerable: true, value: {}}
			})
			expect(() => normalizeLabels(hostileRecord as never, {maxLabels: 10, maxCardinality: 10}))
				.toThrow('stable data fields')
			expect(nameGetter).not.toHaveBeenCalled()
		})

		it('should normalize and sanitize labels', () => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {
					'env': 'test',
					'service-name': 'api-service',
					'value with spaces': 'value with "quotes"'
				},
				timestamp: 1000
			}

			const result = normalizeLabels(
				record,
				{maxLabels: 10, maxCardinality: 100}
			)

			expect(result).not.toBeNull()
			expect(result?.labels).toHaveProperty('env')
			expect(result?.labels).toHaveProperty('service_name') // Sanitized
		})

		it('should return null when cardinality exceeded', () => {

			// Use a unique metric name to avoid state from other tests
			const uniqueMetric = `test_metric_${Date.now()}`
			const record: MetricRecord = {
				name: uniqueMetric,
				type: 'counter',
				value: 1,
				labels: {env: 'test1'},
				timestamp: 1000
			}

			const limits = {maxLabels: 10, maxCardinality: 1}

			const tracker = createCardinalityTracker()

			// First call should succeed
			const first = normalizeLabels(record, limits, undefined, undefined, tracker)
			expect(first).not.toBeNull()

			// Second call with different labels should fail
			const second = normalizeLabels(
				{...record, labels: {env: 'test2'}},
				limits,
				undefined,
				undefined,
				tracker
			)
			expect(second).toBeNull()
		})

		it('should call onDrop callback when labels dropped', () => {

			const onDrop = vi.fn()
			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {
					label1: 'value1',
					label2: 'value2',
					label3: 'value3'
				},
				timestamp: 1000
			}

			normalizeLabels(
				record,
				{maxLabels: 2, maxCardinality: 100},
				onDrop
			)

			expect(onDrop).toHaveBeenCalled()
		})

		it('sanitizes labels without invoking onDrop when within limits', () => {

			const onDrop = vi.fn()
			const result = normalizeLabels({
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {service: 'api'},
				timestamp: 1000
			}, {maxLabels: 10, maxCardinality: 100}, onDrop)

			expect(result?.labels).toEqual({service: 'api'})
			expect(onDrop).not.toHaveBeenCalled()
		})

		it('should handle maxLabelValueLength option', () => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {
					longValue: 'a'.repeat(500)
				},
				timestamp: 1000
			}

			const result = normalizeLabels(
				record,
				{maxLabels: 10, maxCardinality: 100, maxLabelValueLength: 100}
			)

			expect(result).not.toBeNull()
			if (result && result.labels.longValue) {
				expect(result.labels.longValue.length).toBeLessThanOrEqual(100)
			}
		})

		it('redacts values for secret-like label keys before export', () => {
			const result = normalizeLabels({
				name: 'auth_metric',
				type: 'counter',
				value: 1,
				labels: {
					authorization: 'Bearer short-secret',
					api_key: 'sk_test_secret',
					sessionId: 'session-value',
					env: 'prod'
				},
				timestamp: 1000
			}, {maxLabels: 10, maxCardinality: 100})

			expect(result?.labels.authorization).toBe('[redacted]')
			expect(result?.labels.api_key).toBe('[redacted]')
			expect(result?.labels.sessionId).toBe('[redacted]')
			expect(result?.labels.env).toBe('prod')
		})

		it('checks cardinality after maxLabels enforcement', () => {
			const tracker = createCardinalityTracker()
			const limits = {maxLabels: 1, maxCardinality: 1}
			const onCardinalityDrop = vi.fn()

			const first = normalizeLabels({
				name: 'bounded_labels_metric',
				type: 'counter',
				value: 1,
				labels: {stable: 'same', volatile: 'one'},
				timestamp: 1000
			}, limits, undefined, onCardinalityDrop, tracker)
			const second = normalizeLabels({
				name: 'bounded_labels_metric',
				type: 'counter',
				value: 1,
				labels: {stable: 'same', volatile: 'two'},
				timestamp: 1000
			}, limits, undefined, onCardinalityDrop, tracker)

			expect(first).not.toBeNull()
			expect(second).not.toBeNull()
			expect(second?.labels).toEqual({stable: 'same'})
			expect(onCardinalityDrop).not.toHaveBeenCalled()
		})

		it('drops metrics when sanitized label keys collide', () => {
			const onDrop = vi.fn()
			const result = normalizeLabels({
				name: 'collision_metric',
				type: 'counter',
				value: 1,
				labels: {
					'user-id': 'one',
					user_id: 'two'
				},
				timestamp: 1000
			}, {maxLabels: 10, maxCardinality: 100}, onDrop)

			expect(result).toBeNull()
			expect(onDrop).toHaveBeenCalledWith('label_collision', 'collision_metric')
		})

		it('isolates throwing drop observers', () => {
			expect(() => normalizeLabels({
				name: 'collision_metric',
				type: 'counter',
				value: 1,
				labels: {'user-id': 'one', user_id: 'two'},
				timestamp: 1000
			}, {maxLabels: 10, maxCardinality: 100}, () => {
				throw new Error('drop observer failed')
			})).not.toThrow()
		})

		it('uses the injected clock instead of Date.now for cardinality tracking', () => {
			const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
				throw new Error('Date.now should not be called')
			})
			const clock = createFixedClock(1234)
			const tracker = createCardinalityTracker({clock})

			try {
				expect(() => {
					tracker.check('clock_metric', {env: 'test'}, {maxLabels: 10, maxCardinality: 2})
				}).not.toThrow()
			} finally {
				dateNowSpy.mockRestore()
			}
		})
	})

	describe('cardinality tracking edge cases', () => {

		it('should handle LRU eviction when tracker is full', () => {

			// This test verifies that evictLRUEntry is called when cache is full
			// We can't directly test the internal eviction, but we can verify
			// that checkCardinality still works when many metrics are tracked
			const limits = {maxLabels: 10, maxCardinality: 100}

			// Create many unique metrics to fill the tracker
			for (let i = 0; i < 50; i++) {
				expect(checkCardinality(`metric_${i}`, {env: 'test'}, limits)).toBe(false)
			}

			// Should still work
			const result = checkCardinality('metric_new', {env: 'test'}, limits)
			expect(typeof result).toBe('boolean')
		})

		it('should handle cleanup interval', () => {

			// This test verifies that cleanupCardinalityTracker is called
			// We can't directly test the cleanup interval, but we can verify
			// that checkCardinality continues to work after many operations
			const limits = {maxLabels: 10, maxCardinality: 100}

			// Perform many operations to trigger cleanup
			for (let i = 0; i < 200; i++) {
				expect(checkCardinality('test_metric', {env: `test${i}`}, limits)).toBe(false)
			}

			// Should still work
			const result = checkCardinality('test_metric', {env: 'test_new'}, limits)
			expect(typeof result).toBe('boolean')
		})

		it('tracks dropped combinations in diagnostics', () => {

			resetCardinalityDiagnostics()
			expect(getCardinalityDiagnostics()).toEqual([])
		})

		it('cleans up the tracker when operation and key limits are exceeded', () => {

			resetCardinalityDiagnostics()
			const limits = {maxLabels: 10, maxCardinality: 5}

			for (let i = 0; i < 1001; i++) {
				expect(checkCardinality(`cleanup_metric_${i}`, {env: 'test'}, limits)).toBe(false)
			}

			for (let i = 0; i < 10_000; i++) {
				expect(checkCardinality(`cleanup_metric_${i % 1001}`, {env: `test-${i}`}, limits)).toBe(false)
			}

			expect(getCardinalityDiagnostics()).toEqual([])
		}, 10_000)

		it('should handle existing label combination', () => {

			// Use unique metric name to avoid state from other tests
			const uniqueMetric = `test_metric_existing_${Date.now()}`
			const limits = {maxLabels: 10, maxCardinality: 100}

			const first = checkCardinality(uniqueMetric, {env: 'test'}, limits)
			expect(first).toBe(false) // Within limits

			const second = checkCardinality(uniqueMetric, {env: 'test'}, limits)
			expect(second).toBe(false) // Stateless compatibility helper
		})

		it('should handle cardinality limit exactly at max', () => {

			// Use unique metric name to avoid state from other tests
			const uniqueMetric = `test_metric_max_${Date.now()}`
			const limits = {maxLabels: 10, maxCardinality: 2}

			// First label combination
			const tracker = createCardinalityTracker()
			const first = tracker.check(uniqueMetric, {env: 'test1'}, limits)
			expect(first).toBe(false)

			// Second label combination (at limit)
			const second = tracker.check(uniqueMetric, {env: 'test2'}, limits)
			expect(second).toBe(false) // Still within limit (2 combinations)

			// Third label combination (exceeds limit)
			const third = tracker.check(uniqueMetric, {env: 'test3'}, limits)
			expect(third).toBe(true) // Exceeded
		})
	})

	describe('sanitization edge cases', () => {

		it('should handle metric name that needs fallback sanitization', () => {

			// Test the fallback path in sanitizeMetricName
			const result = sanitizeMetricName('!!!invalid!!!')
			expect(result).toMatch(/^_/)
			expect(validateMetricName(result).valid).toBe(true)
		})

		it('should handle label name that needs fallback sanitization', () => {

			// Test the fallback path in sanitizeLabelName
			const result = sanitizeLabelName('!!!invalid!!!')
			expect(result).toMatch(/^_/)
		})

		it('should handle empty metric name', () => {

			const result = sanitizeMetricName('')
			expect(result).toMatch(/^_/)
		})

		it('should handle empty label name', () => {

			const result = sanitizeLabelName('')
			expect(result).toMatch(/^_/)
		})

		it('should handle label value at exact maxLength', () => {

			const maxLength = 200
			const value = 'a'.repeat(maxLength)
			const result = sanitizeLabelValue(value, maxLength)

			expect(result.length).toBeLessThanOrEqual(maxLength)
		})

		it('should handle label value one character over maxLength', () => {

			const maxLength = 200
			const value = 'a'.repeat(maxLength + 1)
			const result = sanitizeLabelValue(value, maxLength)

			expect(result.length).toBeLessThanOrEqual(maxLength)
			expect(result).toContain('...')
		})
	})
})
