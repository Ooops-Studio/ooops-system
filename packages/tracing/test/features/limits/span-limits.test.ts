/**
 * @file Tests for span limits.
 */

import {describe, it, expect, vi} from 'vitest'

import {createSpanLimits, SpanLimits} from '../../../src/features/limits/span-limits'

describe('SpanLimits', () => {

	it('should create span limits with defaults', () => {

		const limits = createSpanLimits()
		expect(limits.maxAttributesPerSpan).toBe(64)
		expect(limits.maxEventsPerSpan).toBe(32)
		expect(limits.maxAttrBytes).toBe(4000)
	})

	it('should create span limits with custom values', () => {

		const limits = createSpanLimits({
			maxAttributesPerSpan: 128,
			maxEventsPerSpan: 64,
			maxAttrBytes: 8000
		})

		expect(limits.maxAttributesPerSpan).toBe(128)
		expect(limits.maxEventsPerSpan).toBe(64)
		expect(limits.maxAttrBytes).toBe(8000)
	})

	it('should validate limits in constructor', () => {

		expect(() => createSpanLimits({
			maxAttributesPerSpan: -1
		})).toThrow()

		expect(() => createSpanLimits({
			maxEventsPerSpan: -1
		})).toThrow()

		expect(() => createSpanLimits({
			maxAttrBytes: -1
		})).toThrow()
		const getter = vi.fn(() => 1)
		const accessor = Object.defineProperty({}, 'maxAttrBytes', {enumerable: true, get: getter})
		expect(() => createSpanLimits(accessor)).toThrow('closed plain data object')
		expect(getter).not.toHaveBeenCalled()
	})

	it('should convert to object', () => {

		const limits = createSpanLimits({
			maxAttributesPerSpan: 128,
			maxEventsPerSpan: 64,
			maxAttrBytes: 8000
		})

		const obj = limits.toObject()
		expect(obj).toEqual({
			maxAttributesPerSpan: 128,
			maxEventsPerSpan: 64,
			maxAttrBytes: 8000
		})
	})

	it('should use SpanLimits class directly', () => {

		const limits = new SpanLimits({
			maxAttributesPerSpan: 100,
			maxEventsPerSpan: 50,
			maxAttrBytes: 5000
		})

		expect(limits.maxAttributesPerSpan).toBe(100)
		expect(limits.maxEventsPerSpan).toBe(50)
		expect(limits.maxAttrBytes).toBe(5000)
	})
})
