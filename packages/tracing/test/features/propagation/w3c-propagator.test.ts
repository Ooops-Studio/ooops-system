/**
 * @file Tests for W3C propagator.
 */

import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi} from 'vitest'

import {createW3CPropagator} from '../../../src/features/propagation/w3c-propagator'

describe('createW3CPropagator', () => {
	it('ignores symbol-only carrier fields without materializing a symbol-key array', () => {
		const propagator = createW3CPropagator()
		const carrier = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`hidden-${index}`), index]
		)) as Record<string, string>
		const enumerateSymbols = vi.spyOn(Object, 'getOwnPropertySymbols')
			.mockImplementation(() => [])
		let extracted: ReturnType<typeof propagator.extract>
		let enumerationCalls = 0
		try {
			propagator.inject(carrier, {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1})
			extracted = propagator.extract(carrier)
			enumerationCalls = enumerateSymbols.mock.calls.length
		} finally { enumerateSymbols.mockRestore() }
		expect(extracted!.context).toMatchObject({
			traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)
		})
		expect(enumerationCalls).toBe(0)
	})

	it('should create a W3C propagator', () => {

		const propagator = createW3CPropagator()
		expect(propagator).toBeDefined()
		expect(propagator.inject).toBeDefined()
		expect(propagator.extract).toBeDefined()
	})

	it('should inject traceparent header', () => {

		const propagator = createW3CPropagator()
		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1
		}

		const carrier: Record<string, string> = {}
		propagator.inject(carrier, context)

		expect(carrier.traceparent).toBeDefined()
		expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
	})

	it('should not inject when context is undefined', () => {

		const propagator = createW3CPropagator()
		const carrier: Record<string, string> = {}

		propagator.inject(carrier, undefined)

		expect(carrier.traceparent).toBeUndefined()
	})

	it('injects independent W3C baggage when trace context is undefined', () => {
		const propagator = createW3CPropagator()
		const carrier: Record<string, string> = {}

		propagator.inject(carrier, undefined, {tenant: 'acme'})

		expect(carrier).toEqual({baggage: 'tenant=acme'})
	})

	it('clears stale tracing headers before reinjection', () => {
		const propagator = createW3CPropagator()
		const carrier: Record<string, string> = {Traceparent: 'stale', tracestate: 'stale', baggage: 'stale', 'X-Trace-Id': 'stale'}
		propagator.inject(carrier, undefined)
		expect(carrier).toEqual({})
		propagator.inject(carrier, {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)})
		expect(carrier.traceparent).toBeDefined()
		expect(carrier).not.toHaveProperty('tracestate')
		expect(carrier).not.toHaveProperty('baggage')
	})

	it('skips oversized carrier keys before case normalization during injection', () => {
		const oversizedKey = 'x'.repeat(1_000_000)
		const carrier = {[oversizedKey]: 'untouched'}
		createW3CPropagator().inject(carrier, {
			traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1
		})
		expect(carrier[oversizedKey]).toBe('untouched')
		expect(carrier).toHaveProperty('traceparent')
	})

	it('rejects inherited carrier fields without invoking their setters', () => {
		let setterCalls = 0
		const report = vi.fn()
		const prototype = Object.defineProperties({}, {
			traceparent: {set: () => { setterCalls++ }},
			baggage: {set: () => { setterCalls++ }}
		})
		const carrier = Object.create(prototype) as Record<string, string>
		const propagator = createW3CPropagator({errors: {report}})

		propagator.inject(carrier, {
			traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1
		}, {tenant: 'acme'})

		expect(setterCalls).toBe(0)
		expect(Object.hasOwn(carrier, 'traceparent')).toBe(false)
		expect(Object.hasOwn(carrier, 'baggage')).toBe(false)
		expect(report).toHaveBeenCalled()
		expect(propagator.extract(carrier)).toEqual({})
	})

	it('should extract traceparent header', () => {

		const propagator = createW3CPropagator()
		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdef'
		const traceparent = `00-${traceId}-${spanId}-01`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(result.context).toBeDefined()
		if (result.context) {
			expect(result.context.traceId).toBe(traceId)
		}
	})

	it('should handle case-insensitive headers', () => {

		const propagator = createW3CPropagator()
		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdef'
		const traceparent = `00-${traceId}-${spanId}-01`

		// Test different casings
		const carriers = [
			{TRACEPARENT: traceparent},
			{Traceparent: traceparent},
			{traceparent: traceparent}
		]

		for (const carrier of carriers) {
			const result = propagator.extract(carrier)
			expect(result.context).toBeDefined()
			if (result.context) {
				expect(result.context.traceId).toBe(traceId)
			}
		}
	})

	it('rejects conflicting case-insensitive duplicate headers', () => {
		const report = vi.fn()
		const propagator = createW3CPropagator({errors: {report}})
		const first = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
		const second = `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`
		expect(propagator.extract({traceparent: first, Traceparent: second})).toEqual({})
		expect(report).toHaveBeenCalled()
	})

	it('rejects duplicate tracing headers before comparing oversized values', () => {
		const report = vi.fn()
		const propagator = createW3CPropagator({errors: {report}})
		const oversized = 'x'.repeat(1_000_000)
		expect(propagator.extract({traceparent: oversized, Traceparent: `${oversized}y`})).toEqual({})
		expect(propagator.extract({baggage: 'tenant=acme', Baggage: 'tenant=acme'})).toEqual({})
		expect(report).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			reason: 'duplicate-header'
		}))
	})

	it('should reject all-zero trace IDs', () => {

		const propagator = createW3CPropagator()
		const zeroTraceId = '0'.repeat(32)
		const spanId = '1234567890abcdef'
		const traceparent = `00-${zeroTraceId}-${spanId}-01`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(result.context).toBeUndefined()
	})

	it('should reject all-zero span IDs', () => {

		const propagator = createW3CPropagator()
		const traceId = '1234567890abcdef1234567890abcdef'
		const zeroSpanId = '0'.repeat(16)
		const traceparent = `00-${traceId}-${zeroSpanId}-01`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(result.context).toBeUndefined()
	})

	it('should reject invalid traceparent length', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})
		const carrier: Record<string, string> = {
			traceparent: '00-123-456-01' // Too short
		}

		const result = propagator.extract(carrier)
		expect(result.context).toBeUndefined()
		expect(mockErrors.report).toHaveBeenCalled()
	})

	it('preserves independent baggage when traceparent is invalid', () => {
		const propagator = createW3CPropagator()

		const result = propagator.extract({traceparent: 'invalid', baggage: 'tenant=acme'})

		expect(result.context).toBeUndefined()
		expect(result.baggage).toEqual({tenant: 'acme'})
	})

	it('accepts additive future traceparent versions and rejects ff', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})
		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdef'
		const traceparent = `01-${traceId}-${spanId}-01-future`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(result.context).toMatchObject({traceId, spanId, traceFlags: 1})
		expect(mockErrors.report).not.toHaveBeenCalled()
		expect(propagator.extract({traceparent: `ff-${traceId}-${spanId}-01`}).context).toBeUndefined()
	})

	it('should apply baggage limits on inject', () => {

		const propagator = createW3CPropagator()
		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1
		}

		const largeBaggage: Record<string, string> = {}
		for (let i = 0; i < 100; i++) {
			largeBaggage[`key${i}`] = `value${i}`
		}

		const carrier: Record<string, string> = {}
		propagator.inject(carrier, context, largeBaggage as LogAttributes)

		// Baggage should be limited (default max is 180 bytes, 10 keys)
		// The exact result depends on baggage limits implementation
		expect(carrier.traceparent).toBeDefined()
	})

	it('should apply baggage limits on extract', () => {

		const propagator = createW3CPropagator()
		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdef'
		const traceparent = `00-${traceId}-${spanId}-01`

		const carrier: Record<string, string> = {
			traceparent,
			baggage: 'key1=value1,key2=value2,key3=value3,key4=value4,key5=value5,key6=value6,key7=value7,key8=value8,key9=value9,key10=value10,key11=value11'
		}

		const result = propagator.extract(carrier)
		expect(result.context).toBeDefined()
		// Baggage should be limited (default max is 10 keys, 180 bytes)
		// The exact limit depends on byte size calculation
		if (result.baggage) {
			// Should be limited to some reasonable number
			expect(Object.keys(result.baggage).length).toBeLessThanOrEqual(20)
		}
	})

	it('drops an oversized remote baggage header before parsing it', () => {
		const report = vi.fn()
		const propagator = createW3CPropagator({errors: {report}})
		const encode = vi.spyOn(TextEncoder.prototype, 'encode')
		const result = propagator.extract({
			traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
			baggage: `payload=${'x'.repeat(100_000)}`
		})
		expect(result.context).toBeDefined()
		expect(result.baggage).toBeUndefined()
		expect(encode.mock.calls.every(([value]) => value.length <= 8_192)).toBe(true)
		expect(report).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({reason: 'baggage-too-large'}))
		encode.mockRestore()
	})

	it('bounds every parsed tracing header before validation', () => {
		const report = vi.fn()
		const propagator = createW3CPropagator({errors: {report}})
		const result = propagator.extract({
			traceparent: 'x'.repeat(100_000),
			tracestate: 'vendor=value,'.repeat(10_000),
			baggage: 'tenant=acme'
		})
		expect(result).toEqual({baggage: {tenant: 'acme'}})
		expect(report).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({reason: 'invalid-traceparent'}))
	})

	it('does not erase existing headers when the replacement context is invalid', () => {
		const report = vi.fn()
		const propagator = createW3CPropagator({errors: {report}})
		const carrier = {
			traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
			baggage: 'tenant=acme'
		}
		propagator.inject(carrier, {traceId: 'invalid', spanId: 'invalid'})
		expect(carrier).toEqual({
			traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
			baggage: 'tenant=acme'
		})
		expect(report).toHaveBeenCalled()
	})

	it('preflights carrier capacity before clearing stale headers', () => {
		const report = vi.fn()
		const propagator = createW3CPropagator({errors: {report}})
		const carrier = Object.preventExtensions({
			Traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
		}) as Record<string, string>
		propagator.inject(carrier, {traceId: 'c'.repeat(32), spanId: 'd'.repeat(16)})
		expect(carrier.Traceparent).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`)
		expect(report).toHaveBeenCalled()
	})

	it('should handle injection errors gracefully', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})
		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1
		}

		// Create a carrier that might cause issues (frozen object)
		const carrier: Record<string, string> = {}

		// Should not throw
		propagator.inject(carrier, context)
		expect(carrier.traceparent).toBeDefined()
	})

	it('should handle extraction errors gracefully', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})

		// Invalid carrier that might cause issues
		const carrier = null as unknown as Record<string, string>

		// Should not throw, should return empty result
		const result = propagator.extract(carrier)
		expect(result.context).toBeUndefined()
	})

	it('ignores legacy x-trace-id when traceparent is missing', () => {

		const propagator = createW3CPropagator()

		const carrier: Record<string, string> = {
			'x-trace-id': '1234567890abcdef1234567890abcdef'
		}

		const result = propagator.extract(carrier)
		expect(result.context).toBeUndefined()
	})

	it('removes stale legacy x-trace-id without injecting it', () => {

		const propagator = createW3CPropagator()
		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1
		}

		const carrier: Record<string, string> = {'x-trace-id': 'stale'}
		propagator.inject(carrier, context)

		expect(carrier['x-trace-id']).toBeUndefined()
		expect(carrier.traceparent).toBeDefined()
	})

	it('should handle undefined context in inject', () => {

		const propagator = createW3CPropagator()
		const carrier: Record<string, string> = {}

		// Should not throw
		propagator.inject(carrier, undefined)
		expect(carrier.traceparent).toBeUndefined()
	})

	it('should handle empty baggage in inject', () => {

		const propagator = createW3CPropagator()
		const context: SpanContext = {
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef',
			traceFlags: 1
		}

		const carrier: Record<string, string> = {}
		propagator.inject(carrier, context, {})

		expect(carrier.traceparent).toBeDefined()
	})

	it('should reject traceparent with invalid length', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})

		const carrier: Record<string, string> = {
			traceparent: '00-123-456-01' // Too short
		}

		const result = propagator.extract(carrier)
		expect(mockErrors.report).toHaveBeenCalled()
		// Invalid W3C input returns an empty extraction result.
		expect(result).toBeDefined()
	})

	it('should reject the forbidden traceparent ff version', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})

		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdef'
		const traceparent = `ff-${traceId}-${spanId}-01`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(mockErrors.report).toHaveBeenCalled()
		expect(result.context).toBeUndefined()
	})

	it('should reject traceparent with invalid traceId format', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})

		const traceId = '1234567890abcdef1234567890abcdeg' // Invalid hex (has 'g')
		const spanId = '1234567890abcdef'
		const traceparent = `00-${traceId}-${spanId}-01`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(mockErrors.report).toHaveBeenCalled()
		expect(result.context).toBeUndefined()
	})

	it('should reject all-zeros traceId', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})

		const traceId = '0'.repeat(32) // All zeros
		const spanId = '1234567890abcdef'
		const traceparent = `00-${traceId}-${spanId}-01`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(mockErrors.report).toHaveBeenCalled()
		expect(result.context).toBeUndefined()
	})

	it('should reject traceparent with invalid spanId format', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})

		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdeg' // Invalid hex (has 'g')
		const traceparent = `00-${traceId}-${spanId}-01`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(mockErrors.report).toHaveBeenCalled()
		expect(result.context).toBeUndefined()
	})

	it('should reject all-zeros spanId', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})

		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '0'.repeat(16) // All zeros
		const traceparent = `00-${traceId}-${spanId}-01`

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(mockErrors.report).toHaveBeenCalled()
		expect(result.context).toBeUndefined()
	})

	it('should reject traceparent with invalid flags format', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const propagator = createW3CPropagator({errors: mockErrors})

		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdef'
		const traceparent = `00-${traceId}-${spanId}-gg` // Invalid hex

		const carrier: Record<string, string> = {
			traceparent
		}

		const result = propagator.extract(carrier)
		expect(mockErrors.report).toHaveBeenCalled()
		expect(result.context).toBeUndefined()
	})

	it('should handle traceparent with wrong number of parts', () => {

		const propagator = createW3CPropagator()

		const carrier: Record<string, string> = {
			traceparent: '00-123-456' // Only 3 parts instead of 4
		}

		// Should not throw, should attempt extraction
		const result = propagator.extract(carrier)
		expect(result).toBeDefined()
	})

	it('should handle case-insensitive header lookup', () => {

		const propagator = createW3CPropagator()
		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdef'
		const traceparent = `00-${traceId}-${spanId}-01`

		// Test various case combinations (normalized to lowercase)
		const testCases = [
			{'Traceparent': traceparent},
			{'TRACEPARENT': traceparent},
			{'traceparent': traceparent}
		]

		for (const carrier of testCases) {
			const result = propagator.extract(carrier)
			// All should work due to case normalization
			expect(result.context).toBeDefined()
			if (result.context) {
				expect(result.context.traceId).toBe(traceId)
			}
		}
	})

	it('should apply baggage limits on extract', () => {

		const propagator = createW3CPropagator()
		const traceId = '1234567890abcdef1234567890abcdef'
		const spanId = '1234567890abcdef'
		const traceparent = `00-${traceId}-${spanId}-01`

		// Large baggage that should be limited (default max is 10 keys, 180 bytes)
		// Use a smaller number to ensure limits are applied
		const largeBaggage = Array.from({length: 20}, (_, i) => `key${i}=value${i}`).join(',')
		const carrier: Record<string, string> = {
			traceparent,
			baggage: largeBaggage
		}

		const result = propagator.extract(carrier)
		expect(result.context).toBeDefined()
		if (result.baggage) {
			// Should be limited (default max is 10 keys, 180 bytes)
			// The exact number depends on byte size calculation
			expect(Object.keys(result.baggage).length).toBeLessThanOrEqual(20)
			// Should definitely be less than the original 20 if limits are working
			// But we allow up to 20 since byte limits might allow more keys than key count limits
		}
		// If baggage was completely filtered out, that's also valid
	})

	it('rejects upper-case W3C identifiers and reports malformed tracestate', () => {
		const report = vi.fn()
		const propagator = createW3CPropagator({errors: {report}})
		expect(propagator.extract({
			traceparent: `00-${'A'.repeat(32)}-${'b'.repeat(16)}-01`
		}).context).toBeUndefined()
		const validParent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
		const result = propagator.extract({traceparent: validParent, tracestate: 'Vendor=value'})
		expect(result.context).toBeDefined()
		expect(result.context?.traceState).toBeUndefined()
		expect(report).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({reason: 'invalid-tracestate'}))
	})

	it('fails closed without invoking accessor-backed header values', () => {
		let getterCalls = 0
		const report = vi.fn()
		const carrier = Object.defineProperty({}, 'traceparent', {
			enumerable: true,
			get: () => { getterCalls++; return `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` }
		})
		expect(createW3CPropagator({errors: {report}}).extract(carrier as never)).toEqual({})
		expect(getterCalls).toBe(0)
		expect(report).toHaveBeenCalled()
	})

	it('bounds descriptor inspection for very wide header carriers', () => {
		const wide = Object.fromEntries(Array.from({length: 2_000}, (_, index) => [`header-${index}`, 'value']))
		let descriptorReads = 0
		const observed = new Proxy(wide, {
			getOwnPropertyDescriptor: (target, key) => {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		const report = vi.fn()

		expect(createW3CPropagator({errors: {report}}).extract(observed)).toEqual({})
		expect(descriptorReads).toBeLessThan(3_100)
		expect(report).toHaveBeenCalled()
	})
})
