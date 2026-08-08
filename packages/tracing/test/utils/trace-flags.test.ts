/**
 * @file Tests for trace flags utilities.
 */

import type {SpanContext} from '@ooopsstudio/core/contracts/tracing'
import {describe, it, expect} from 'vitest'

import {
	TRACE_FLAGS,
	isSampled,
	setSampled,
	setNotSampled,
	inheritTraceFlags
} from '../../src/utils/trace-flags'

describe('trace-flags', () => {

	it('should check if context is sampled', () => {

		const sampledContext: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1
		}

		const unsampledContext: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 0
		}

		expect(isSampled(sampledContext)).toBe(true)
		expect(isSampled(unsampledContext)).toBe(false)
	})

	it('should handle undefined traceFlags', () => {

		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef'
		}

		expect(isSampled(context)).toBe(false)
	})

	it('should set sampled flag', () => {

		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 0
		}

		const sampled = setSampled(context)
		expect(sampled.traceFlags).toBe(1)
		expect(isSampled(sampled)).toBe(true)
	})

	it('should preserve other context properties when setting sampled', () => {

		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 0,
			parentSpanId: 'parent1234567890'
		}

		const sampled = setSampled(context)
		expect(sampled.traceId).toBe(context.traceId)
		expect(sampled.spanId).toBe(context.spanId)
		expect(sampled.parentSpanId).toBe(context.parentSpanId)
		expect(sampled.traceFlags).toBe(1)
	})

	it('should clear sampled flag', () => {

		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1
		}

		const unsampled = setNotSampled(context)
		expect(unsampled.traceFlags).toBe(0)
		expect(isSampled(unsampled)).toBe(false)
	})

	it('should preserve other context properties when clearing sampled', () => {

		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1,
			parentSpanId: 'parent1234567890'
		}

		const unsampled = setNotSampled(context)
		expect(unsampled.traceId).toBe(context.traceId)
		expect(unsampled.spanId).toBe(context.spanId)
		expect(unsampled.parentSpanId).toBe(context.parentSpanId)
		expect(unsampled.traceFlags).toBe(0)
	})

	it('should inherit trace flags from parent', () => {

		const parent: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1
		}

		const flags = inheritTraceFlags(parent)
		expect(flags).toBe(1)
	})

	it('should default to sampled for root span', () => {

		const flags = inheritTraceFlags(undefined)
		expect(flags).toBe(TRACE_FLAGS.SAMPLED)
	})

	it('should handle parent with undefined traceFlags', () => {

		const parent: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef'
		}

		const flags = inheritTraceFlags(parent)
		expect(flags).toBe(TRACE_FLAGS.NOT_SAMPLED)
	})

	it('should handle parent with unsampled flag', () => {

		const parent: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 0
		}

		const flags = inheritTraceFlags(parent)
		expect(flags).toBe(0)
	})

	it('should set sampled flag on context with undefined traceFlags', () => {

		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef'
		}

		const sampled = setSampled(context)
		expect(sampled.traceFlags).toBe(1)
	})

	it('should clear sampled flag on context with undefined traceFlags', () => {

		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef'
		}

		const unsampled = setNotSampled(context)
		expect(unsampled.traceFlags).toBe(0)
	})
})
