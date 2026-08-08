import {describe, expect, it, vi} from 'vitest'

import {
	hasControlCharacters,
	isSensitivePerformanceKey,
	sanitizePerformanceEventName,
	sanitizePerformanceLabelValue,
	snapshotPerformanceLabels
} from '../../../src/performance/utils/safe-identifiers'

describe('performance safe identifiers', () => {
	it('detects ASCII control characters without rejecting normal Unicode', () => {
		expect(hasControlCharacters('metric.name')).toBe(false)
		expect(hasControlCharacters('μέτρηση')).toBe(false)
		expect(hasControlCharacters('bad\nname')).toBe(true)
		expect(hasControlCharacters(`bad${String.fromCharCode(127)}name`)).toBe(true)
	})

	it('normalizes unsafe event names and label values', () => {
		expect(sanitizePerformanceEventName('db.query')).toBe('db.query')
		expect(sanitizePerformanceEventName('route/user@example.com')).toBe('custom_event')
		expect(sanitizePerformanceLabelValue('https://example.test/path?token=secret')).toBe('[url]')
		expect(sanitizePerformanceLabelValue('user@example.com')).toBe('[email]')
		expect(sanitizePerformanceLabelValue('123e4567-e89b-12d3-a456-426614174000')).toBe('[uuid]')
		expect(sanitizePerformanceLabelValue('a'.repeat(32))).toBe('[opaque]')
		expect(sanitizePerformanceLabelValue('   ')).toBe('')
		expect(sanitizePerformanceLabelValue('12345')).toBe('[numeric-id]')
		expect(sanitizePerformanceLabelValue('!'.repeat(65))).toBe('[redacted]')
		expect(sanitizePerformanceLabelValue('unsafe\nvalue')).toBe('[redacted]')
		for (const key of ['credential', 'privateKey', 'access_key', 'bearer', 'session-id']) {
			expect(isSensitivePerformanceKey(key)).toBe(true)
		}
		expect(isSensitivePerformanceKey('region')).toBe(false)
	})

	it('snapshots only bounded plain data labels without invoking accessors', () => {
		expect(snapshotPerformanceLabels(undefined)).toBeUndefined()
		expect(snapshotPerformanceLabels({scope: 'original'})).toEqual({scope: 'original'})
		expect(() => snapshotPerformanceLabels(null as never)).toThrow('safe key/value limits')
		expect(() => snapshotPerformanceLabels([] as never)).toThrow('safe key/value limits')
		expect(() => snapshotPerformanceLabels(new (class Labels {})() as never)).toThrow('safe key/value limits')
		expect(snapshotPerformanceLabels({[Symbol('hidden')]: 'value'} as never)).toEqual({})
		expect(snapshotPerformanceLabels(Object.defineProperty({}, 'hidden', {
			enumerable: false, value: 'value'
		}) as never)).toEqual({})
		expect(() => snapshotPerformanceLabels({'unsafe key': 'value'})).toThrow('safe key/value limits')
		expect(() => snapshotPerformanceLabels({scope: 1 as never})).toThrow('safe key/value limits')
		expect(() => snapshotPerformanceLabels({scope: 'x'.repeat(257)})).toThrow('safe key/value limits')
		expect(() => snapshotPerformanceLabels(Object.fromEntries(
			Array.from({length: 33}, (_, index) => [`key_${index}`, 'value'])
		))).toThrow('safe key/value limits')
		const accessor = Object.defineProperty({}, 'scope', {enumerable: true, get: expect.unreachable})
		expect(() => snapshotPerformanceLabels(accessor as never)).toThrow('safe key/value limits')
	})

	it('rejects proxy labels before invoking ownKeys', () => {
		const ownKeys = vi.fn(() => ['fabricated'])
		const labels = new Proxy({}, {ownKeys}) as Record<string, string>
		expect(() => snapshotPerformanceLabels(labels)).toThrow('safe key/value limits')
		expect(ownKeys).not.toHaveBeenCalled()
	})
})
