import type {SpanContext} from '@ooopsstudio/core/contracts/tracing'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createTracerSpanTools} from '../../src/core/tracer-span-tools'

const traceId = 'a'.repeat(32)
const spanId = 'b'.repeat(16)

function createTools(overrides: Record<string, unknown> = {}) {
	let active: SpanContext | undefined
	const clock = createFixedClock(10)
	const processor = {onEnd: vi.fn(), flush: vi.fn(), shutdown: vi.fn()}
	const telemetry = {
		recordSpanProcessed: vi.fn(), recordSpansExported: vi.fn(),
		recordExportFailure: vi.fn(), recordSpansDropped: vi.fn()
	}
	const tools = createTracerSpanTools({
		clock,
		idGen: {nextTraceId: () => traceId, nextSpanId: () => spanId},
		processor,
		telemetry,
		getActiveSpanContext: () => active,
		createRecorderOptions: (startTime?: number) => ({
			clock, maxAttributes: 10, maxEvents: 10, maxAttrBytes: 1_000,
			...(startTime === undefined ? {} : {startTime})
		}),
		selfMetricsPrefix: '_traces_',
		...overrides
	} as never)
	return {tools, processor, telemetry, setActive: (context?: SpanContext) => { active = context }}
}

describe('tracer span tools', () => {
	it('validates and snapshots every supported parent form', () => {
		const {tools, setActive} = createTools()
		expect(tools.resolveParentContext(null)).toBeUndefined()
		expect(tools.resolveParentContext()).toBeUndefined()
		const parent = {traceId, spanId, traceFlags: 1, traceState: 'vendor=value'}
		setActive(parent)
		expect(tools.resolveParentContext()).toEqual(parent)
		expect(tools.resolveParentContext()).not.toBe(parent)
		expect(tools.resolveParentContext({getContext: () => parent} as never)).toEqual(parent)
		expect(() => tools.resolveParentContext({getContext: () => { throw new Error('hostile') }} as never)).toThrow('Unable to read')
		expect(() => tools.resolveParentContext({traceId: '0'.repeat(32), spanId})).toThrow('valid non-zero')
		expect(() => tools.resolveParentContext({traceId, spanId: '0'.repeat(16)})).toThrow('valid non-zero')
		expect(() => tools.resolveParentContext({traceId, spanId, traceFlags: 256})).toThrow('valid W3C')
		expect(() => tools.resolveParentContext({traceId, spanId, traceState: 'x'.repeat(513)})).toThrow('valid W3C')
		expect(() => tools.resolveParentContext({traceId, spanId, traceState: 'bad\u0000state'})).toThrow('valid W3C')
		let getterCalls = 0
		const accessor = Object.defineProperty({traceId, spanId}, 'traceFlags', {
			enumerable: true,
			get: () => { getterCalls++; return 1 }
		})
		expect(() => tools.resolveParentContext(accessor as never)).toThrow('valid W3C')
		expect(getterCalls).toBe(0)
	})

	it('rejects invalid generated identifiers and creates parented contexts', () => {
		const parent = {traceId, spanId, traceFlags: 0, traceState: 'vendor=value'}
		const {tools} = createTools()
		expect(tools.createSpanContext(parent)).toEqual({
			traceId, spanId, parentSpanId: spanId, traceFlags: 0, traceState: 'vendor=value'
		})
		expect(tools.createSpanContext(null)).toEqual({traceId, spanId, traceFlags: 1})
		expect(() => createTools({idGen: {nextTraceId: () => traceId, nextSpanId: () => '0'.repeat(16)}}).tools.createSpanContext(null)).toThrow('invalid span ID')
		expect(() => createTools({idGen: {nextTraceId: () => '0'.repeat(32), nextSpanId: () => spanId}}).tools.createSpanContext(null)).toThrow('invalid trace ID')
		expect(() => createTools({idGen: {nextTraceId: () => traceId, nextSpanId: () => 'B'.repeat(16)}}).tools.createSpanContext(null)).toThrow('invalid span ID')
		expect(() => createTools({idGen: {nextTraceId: () => 'A'.repeat(32), nextSpanId: () => spanId}}).tools.createSpanContext(null)).toThrow('invalid trace ID')
	})

	it('manages active spans and detached recorders without leaking identities', () => {
		const {tools, processor, telemetry} = createTools({resource: {service: 'api'}})
		const context = {traceId, spanId}
		const noop = tools.createNoOpSpan(context)
		tools.setActiveSpan(context, noop)
		expect(tools.getActiveSpan(context)).toBe(noop)
		tools.activateSpan(context, noop)
		tools.activateSpan(context, noop)
		tools.deactivateSpan(context, noop)
		expect(tools.getActiveSpan(context)).toBe(noop)
		tools.deactivateSpan(context, noop)
		expect(tools.getActiveSpan(context)).toBeUndefined()
		tools.deactivateSpan(context, noop)

		const other = tools.createNoOpSpan(context)
		tools.activateSpan(context, other)
		tools.deactivateSpan(context, noop)
		expect(tools.getActiveSpan(context)).toBe(other)
		other.end()

		const temporary = tools.createTemporaryRecorder('temporary', 'internal', context)
		processor.onEnd(temporary.end())
		const correlated = tools.createCorrelatedRecorder('correlated', 'internal', traceId)
		processor.onEnd(correlated.end())
		expect(() => tools.createCorrelatedRecorder('invalid', 'internal', '0'.repeat(32))).toThrow('Correlated trace ID')
		expect(processor.onEnd).toHaveBeenCalledTimes(2)
		expect(telemetry.recordExportFailure).not.toHaveBeenCalled()
	})
})
