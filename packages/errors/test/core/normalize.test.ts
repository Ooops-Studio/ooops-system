/**
 * @file Tests for normalize factory.
 */

import {describe, expect, it, vi} from 'vitest'

import {createNormalize} from '../../src/core/normalize'
import {createFixedClock} from '../fixed-clock'

const FIXED_CLOCK_TIMESTAMP = 1_700_000_000_000

describe('createNormalize', () => {
	it('creates normalization function', () => {
		const clock = createFixedClock(FIXED_CLOCK_TIMESTAMP)
		const normalize = createNormalize({clock})

		expect(normalize).toBeDefined()
		expect(typeof normalize).toBe('function')
	})

	it('normalizes errors with clock timestamp', () => {
		const clock = createFixedClock(FIXED_CLOCK_TIMESTAMP)
		const normalize = createNormalize({clock})

		const error = new Error('Test error')
		const result = normalize(error)

		expect(result.timestamp).toBe(FIXED_CLOCK_TIMESTAMP)
		expect(result.kind).toBe('Error')
		expect(result.message).toBe('Test error')
	})

	it('uses defaultSource when provided', () => {
		const clock = createFixedClock(FIXED_CLOCK_TIMESTAMP)
		const normalize = createNormalize({
			clock,
			defaultSource: 'custom-source'
		})

		const error = new Error('Test error')
		const result = normalize(error)

		expect(result.source).toBe('custom-source')
	})

	it('generates ID by default', () => {
		const clock = createFixedClock(FIXED_CLOCK_TIMESTAMP)
		const normalize = createNormalize({clock})

		const error = new Error('Test error')
		const result = normalize(error)

		expect(result.id).toBeDefined()
		expect(typeof result.id).toBe('string')
	})

	it('generates a runtime-neutral fallback ID without Web Crypto', () => {
		vi.stubGlobal('crypto', undefined)
		try {
			const normalize = createNormalize({clock: createFixedClock(FIXED_CLOCK_TIMESTAMP)})
			expect(normalize(new Error('test')).id).toEqual(expect.any(String))
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('falls back from invalid or throwing clocks', () => {
		const invalid = createNormalize({clock: {now: () => Number.NaN}})
		const throwing = createNormalize({clock: {now: () => { throw new Error('clock failed') }}})
		expect(Number.isFinite(invalid(new Error('test')).timestamp)).toBe(true)
		expect(Number.isFinite(throwing(new Error('test')).timestamp)).toBe(true)
	})

	it('does not expose an invalid system-clock fallback timestamp', () => {
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Number.NaN)
		try {
			const normalize = createNormalize({clock: {now: () => Number.POSITIVE_INFINITY}})
			expect(normalize(new Error('test')).timestamp).toBe(0)
		} finally {
			dateNow.mockRestore()
		}
	})

	it('falls back when a clock returns a safe integer outside the JavaScript Date range', () => {
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(123)
		try {
			const normalize = createNormalize({clock: {now: () => Number.MAX_SAFE_INTEGER}})
			expect(normalize(new Error('test')).timestamp).toBe(123)
		} finally {
			dateNow.mockRestore()
		}
	})

	it('does not generate ID when generateId is false', () => {
		const clock = createFixedClock(FIXED_CLOCK_TIMESTAMP)
		const normalize = createNormalize({
			clock,
			generateId: false
		})

		const error = new Error('Test error')
		const result = normalize(error)

		expect(result.id).toBeUndefined()
	})

	it('includes traceId from tracer when available', () => {
		const clock = createFixedClock(FIXED_CLOCK_TIMESTAMP)
		const mockTracer = {
			currentTraceId: vi.fn().mockReturnValue('trace-id-123')
		}

		const normalize = createNormalize({
			clock,
			tracer: mockTracer
		})

		const error = new Error('Test error')
		const result = normalize(error)

		expect(result.traceId).toBe('trace-id-123')
	})

	it('merges context when provided', () => {
		const clock = createFixedClock(FIXED_CLOCK_TIMESTAMP)
		const normalize = createNormalize({clock})

		const error = new Error('Test error')
		const context = {userId: 'user-123', requestId: 'req-456'}
		const result = normalize(error, context)

		expect(result.context?.userId).toMatch(/^hash:/u)
		expect(result.context?.requestId).toMatch(/^hash:/u)
	})
})
