/**
 * @file Tests for W3C trace context propagation.
 */

import {describe, it, expect, vi} from 'vitest'

import {
	encodeTraceParent,
	decodeTraceParent,
	encodeBaggage,
	decodeBaggage,
	injectW3C,
	extractW3C,
	injectXTraceId,
	extractXTraceId,
	isValidTraceState,
	TRACEPARENT_VERSION,
	TRACEPARENT_LENGTH
} from '../../../src/utils/tracing/propagation'

describe('propagation', () => {
	it('contains rejected promises at tracing propagation boundaries', async() => {
		const scalar = Promise.reject(new Error('header rejected'))
		expect(decodeTraceParent(scalar as never)).toBeUndefined()
		const contextField = Promise.reject(new Error('trace id rejected'))
		expect(() => encodeTraceParent({
			traceId: contextField as never, spanId: '00f067aa0ba902b7'
		})).toThrow('traceId')
		const baggageField = Promise.reject(new Error('baggage rejected'))
		expect(encodeBaggage({field: baggageField as never})).toBe('')
		const carrierField = Promise.reject(new Error('carrier rejected'))
		expect(extractW3C({traceparent: carrierField as never})).toEqual({})
		await Promise.resolve()
	})

	it('does not inherit forged propagation fields from Object.prototype', () => {
		const forgedContext = {
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7', traceFlags: 1
		}
		let extracted: ReturnType<typeof extractW3C> | undefined
		let fallback: string | undefined
		let encodingFailure: unknown
		try {
			Object.defineProperties(Object.prototype, {
				traceId: {configurable: true, value: forgedContext.traceId},
				spanId: {configurable: true, value: forgedContext.spanId},
				traceFlags: {configurable: true, value: forgedContext.traceFlags},
				traceparent: {configurable: true, value: `00-${forgedContext.traceId}-${forgedContext.spanId}-01`},
				'x-trace-id': {configurable: true, value: forgedContext.traceId},
				context: {configurable: true, value: forgedContext}
			})
			try { encodeTraceParent(null as never) }
			catch(error) { encodingFailure = error }
			extracted = extractW3C({})
			fallback = extractXTraceId({})
		} finally {
			for (const key of ['traceId', 'spanId', 'traceFlags', 'traceparent', 'x-trace-id', 'context']) {
				delete (Object.prototype as Record<string, unknown>)[key]
			}
		}

		expect(encodingFailure).toBeInstanceOf(Error)
		expect(extracted?.context).toBeUndefined()
		expect(extracted?.baggage).toBeUndefined()
		expect(Object.getPrototypeOf(extracted)).toBeNull()
		expect(fallback).toBeUndefined()
	})

	it('preserves trace extraction and injection under wide prototype pollution', () => {
		const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
		const spanId = '00f067aa0ba902b7'
		const polluted: string[] = []
		let extracted: ReturnType<typeof extractW3C> | undefined
		const injected: Record<string, string> = {}
		let failure: unknown
		try {
			for (let index = 0; index < 1_100; index += 1) {
				const key = `polluted_trace_${index}`
				polluted.push(key)
				Object.defineProperty(Object.prototype, key, {
					configurable: true, enumerable: true, value: 'forged'
				})
			}
			extracted = extractW3C({traceparent: `00-${traceId}-${spanId}-01`})
			injectW3C(injected, {traceId, spanId, traceFlags: 1})
		} catch(error) { failure = error }
		finally {
			for (const key of polluted) delete (Object.prototype as Record<string, unknown>)[key]
		}

		expect(failure).toBeUndefined()
		expect(extracted?.context).toMatchObject({traceId, spanId, traceFlags: 1})
		expect(injected.traceparent).toBe(`00-${traceId}-${spanId}-01`)
	})

	it('preserves W3C validation after RegExp.prototype.test is rewired', () => {
		const context = {
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
			traceFlags: 1
		}
		const test = vi.spyOn(RegExp.prototype, 'test').mockImplementation(() => {
			throw new Error('rewired RegExp.test')
		})
		let encoded: string | undefined
		let decoded: ReturnType<typeof decodeTraceParent>
		let validTraceState = false
		try {
			encoded = encodeTraceParent(context)
			decoded = decodeTraceParent(`00-${context.traceId}-${context.spanId}-01`)
			validTraceState = isValidTraceState('vendor=value')
		} finally { test.mockRestore() }

		expect(encoded).toBe(`00-${context.traceId}-${context.spanId}-01`)
		expect(decoded).toMatchObject(context)
		expect(validTraceState).toBe(true)
	})

	it('does not consult rewired string iterators while validating tracestate', () => {
		const iteratorDescriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!
		const charCodeDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!
		const poison = (): never => { throw new Error('poisoned string intrinsic') }
		let valid = false
		try {
			Object.defineProperties(String.prototype, {
				[Symbol.iterator]: {configurable: true, writable: true, value: poison},
				charCodeAt: {configurable: true, writable: true, value: poison}
			})
			valid = isValidTraceState('vendor=value')
		} finally {
			Object.defineProperty(String.prototype, Symbol.iterator, iteratorDescriptor)
			Object.defineProperty(String.prototype, 'charCodeAt', charCodeDescriptor)
		}

		expect(valid).toBe(true)
	})

	it('preserves atomic propagation after array iteration and Map methods are rewired', () => {
		const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
		const mapDescriptors = Object.getOwnPropertyDescriptors(Map.prototype)
		const poison = (): never => { throw new Error('poisoned collection intrinsic') }
		const carrier: Record<string, string> = {}
		let baggage = ''
		try {
			Object.defineProperty(Array.prototype, Symbol.iterator, {
				configurable: true, writable: true, value: poison
			})
			const methods = ['get', 'has', 'set'] as const
			for (let index = 0; index < methods.length; index += 1) {
				const method = methods[index]!
				Object.defineProperty(Map.prototype, method, {
					configurable: true, writable: true, value: poison
				})
			}
			injectW3C(carrier, {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7', traceFlags: 1
			})
			baggage = encodeBaggage({region: 'eu'})
		} finally {
			Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor)
			Object.defineProperties(Map.prototype, mapDescriptors)
		}

		expect(carrier).toEqual({
			traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
		})
		expect(baggage).toBe('region=eu')
	})

	it('preserves propagation after parsing and inspection intrinsics are rewired', () => {
		const context = {
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7', traceFlags: 1
		}
		const traceparent = `00-${context.traceId}-${context.spanId}-01`
		const carrier: Record<string, string> = {TRACEPARENT: traceparent}
		const injected: Record<string, string> = {}
		const targets = [
			[Array, 'isArray'], [Number, 'isFinite'], [Number, 'isInteger'], [Number, 'parseInt'],
			[Number.prototype, 'toString'], [String.prototype, 'toLowerCase'],
			[String.prototype, 'slice'], [String.prototype, 'substring'], [String.prototype, 'split'],
			[String.prototype, 'indexOf'], [String.prototype, 'lastIndexOf'], [String.prototype, 'replace'],
			[String.prototype, 'startsWith'], [String.prototype, 'endsWith'], [String.prototype, 'padStart'],
			[String.prototype, 'repeat'], [Object, 'create'], [Object, 'defineProperty'],
			[Object, 'getOwnPropertyDescriptor'], [Object, 'getPrototypeOf'], [Object, 'isExtensible'],
			[globalThis, 'encodeURIComponent'], [TextDecoder.prototype, 'decode']
		] as const
		const defineProperty = Object.defineProperty
		const descriptors = targets.map((entry) => Object.getOwnPropertyDescriptor(entry[0], entry[1])!)
		const poison = (): never => { throw new Error('rewired propagation intrinsic') }
		let encoded: string | undefined
		let decoded: ReturnType<typeof decodeTraceParent>
		let baggage: ReturnType<typeof decodeBaggage> | undefined
		let extracted: ReturnType<typeof extractW3C> | undefined
		let traceState = false
		let failure: unknown
		try {
			for (let index = 0; index < targets.length; index += 1) {
				const entry = targets[index]!
				defineProperty(entry[0], entry[1], {
					configurable: true, writable: true, value: poison
				})
			}
			try {
				encoded = encodeTraceParent(context)
				decoded = decodeTraceParent(traceparent)
				baggage = decodeBaggage('region=eu%2Dwest')
				extracted = extractW3C(carrier)
				injectW3C(injected, context)
				traceState = isValidTraceState('vendor=value')
			} catch(error) { failure = error }
		} finally {
			for (let index = 0; index < targets.length; index += 1) {
				const entry = targets[index]!
				defineProperty(entry[0], entry[1], descriptors[index]!)
			}
		}

		expect(failure).toBeUndefined()
		expect(encoded).toBe(traceparent)
		expect(decoded).toMatchObject(context)
		expect(baggage).toEqual({region: 'eu-west'})
		expect(extracted?.context).toMatchObject(context)
		expect(injected.traceparent).toBe(traceparent)
		expect(traceState).toBe(true)
	})

	describe('encodeTraceParent', () => {
		it('rejects zero IDs, invalid flags, and unsafe tracestate', () => {
			expect(() => encodeTraceParent({traceId: '0'.repeat(32), spanId: 'a'.repeat(16)})).toThrow('traceId')
			expect(() => encodeTraceParent({traceId: 'a'.repeat(32), spanId: '0'.repeat(16)})).toThrow('spanId')
			expect(() => encodeTraceParent({traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1.5})).toThrow('traceFlags')
			expect(() => injectW3C({}, {
				traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceState: 'unsafe\nstate'
			})).toThrow('tracestate')
		})

		it('should encode span context to traceparent', () => {

			const context = {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7',
				traceFlags: 0x1
			}

			const result = encodeTraceParent(context)

			expect(result).toContain(TRACEPARENT_VERSION)
			expect(result).toContain(context.traceId)
			expect(result).toContain(context.spanId)
			expect(result.length).toBe(TRACEPARENT_LENGTH)
		})

		it('should reject short trace IDs', () => {

			const context = {
				traceId: 'abc',
				spanId: 'def',
				traceFlags: 0
			}

			expect(() => encodeTraceParent(context)).toThrow('traceId')
		})

		it('should reject long trace IDs', () => {

			const context = {
				traceId: 'a'.repeat(50),
				spanId: 'b'.repeat(30),
				traceFlags: 0
			}

			expect(() => encodeTraceParent(context)).toThrow('traceId')
		})

		it('should encode trace flags', () => {

			const context = {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7',
				traceFlags: 0x1
			}

			const result = encodeTraceParent(context)

			expect(result.endsWith('-01')).toBe(true)
		})

		it('should handle undefined traceFlags', () => {

			const context = {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7'
			}

			const result = encodeTraceParent(context)

			expect(result.endsWith('-00')).toBe(true)
		})

		it('should mask trace flags to 2 bits', () => {

			const context = {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7',
				traceFlags: 0xFF
			}

			const result = encodeTraceParent(context)

			// Should only use bits 0-1 (0x3)
			expect(result.endsWith('-03')).toBe(true)
		})

		it('does not invoke accessor-backed span context fields', () => {
			let reads = 0
			const context = {spanId: 'b'.repeat(16)} as Record<string, unknown>
			Object.defineProperty(context, 'traceId', {
				enumerable: true,
				get() { reads += 1; return 'a'.repeat(32) }
			})

			expect(() => encodeTraceParent(context as never)).toThrow('traceId')
			expect(reads).toBe(0)
		})

		it('rejects proxied span context before descriptor traps', () => {
			let traceIdReads = 0
			let traceStateReads = 0
			const context = new Proxy({
				traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1,
				traceState: 'vendor=stable'
			}, {
				getOwnPropertyDescriptor(target, key) {
					if (key === 'traceId') {
						traceIdReads += 1
						return {configurable: true, enumerable: true, writable: true,
							value: traceIdReads === 1 ? 'a'.repeat(32) : '0'.repeat(32)}
					}
					if (key === 'traceState') {
						traceStateReads += 1
						return {configurable: true, enumerable: true, writable: true,
							value: traceStateReads === 1 ? 'vendor=stable' : 'unsafe\nstate'}
					}
					return Reflect.getOwnPropertyDescriptor(target, key)
				}
			})

			const carrier: Record<string, string> = {}
			expect(() => injectW3C(carrier, context)).toThrow('traceId')

			expect(carrier).toEqual({})
			expect(traceIdReads).toBe(0)
			expect(traceStateReads).toBe(0)
		})
	})

	describe('decodeTraceParent', () => {

		it('should decode valid traceparent', () => {

			const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

			const result = decodeTraceParent(traceparent)

			expect(result).toBeDefined()
			expect(result?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
			expect(result?.spanId).toBe('00f067aa0ba902b7')
			expect(result?.traceFlags).toBe(0x1)
		})

		it('should return undefined for invalid length', () => {

			expect(decodeTraceParent('00-abc')).toBeUndefined()
			expect(decodeTraceParent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7')).toBeUndefined()
		})

		it('should return undefined for invalid format', () => {

			expect(decodeTraceParent('invalid-format')).toBeUndefined()
			expect(decodeTraceParent('00-4bf92f3577b34da6a3ce929d0e0e4736')).toBeUndefined()
		})

		it('accepts additive future versions and rejects the forbidden ff version', () => {

			const prefix = '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
			expect(decodeTraceParent(prefix)).toMatchObject({traceFlags: 1})
			expect(decodeTraceParent(`${prefix}-future-data`)).toMatchObject({traceFlags: 1})
			expect(decodeTraceParent(`${prefix}future-data`)).toBeUndefined()
			expect(decodeTraceParent(prefix.replace(/^01/u, 'ff'))).toBeUndefined()
			expect(decodeTraceParent(`00-${prefix.slice(3)}-extension`)).toBeUndefined()
		})

		it('should return undefined for non-hex characters', () => {

			const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01'

			expect(decodeTraceParent(traceparent)).toBeUndefined()
		})

		it('rejects upper-case hexadecimal fields required to be lower-case by W3C', () => {
			expect(decodeTraceParent('00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01')).toBeUndefined()
			expect(decodeTraceParent('00-4bf92f3577b34da6a3ce929d0e0e4736-00F067AA0BA902B7-01')).toBeUndefined()
		})

		it('should return undefined for all-zeros trace ID', () => {

			const traceparent = `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`

			expect(decodeTraceParent(traceparent)).toBeUndefined()
		})

		it('should return undefined for all-zeros span ID', () => {

			const traceparent = `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`

			expect(decodeTraceParent(traceparent)).toBeUndefined()
		})

		it('should return undefined for null or undefined', () => {

			expect(decodeTraceParent(null as unknown as string)).toBeUndefined()
			expect(decodeTraceParent(undefined as unknown as string)).toBeUndefined()
		})

		it('should extract parentSpanId from traceparent', () => {

			const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

			const result = decodeTraceParent(traceparent)

			expect(result?.parentSpanId).toBe('00f067aa0ba902b7')
		})
	})

	describe('isValidTraceState', () => {
		it('enforces W3C grammar, uniqueness, and member limits', () => {
			expect(isValidTraceState('vendor=value,tenant@system=opaque value')).toBe(true)
			expect(isValidTraceState(' vendor=value\t, next=ok ')).toBe(true)
			expect(isValidTraceState('')).toBe(false)
			expect(isValidTraceState('vendor=value,,next=ok')).toBe(false)
			expect(isValidTraceState(',vendor=value')).toBe(false)
			expect(isValidTraceState('vendor=value,')).toBe(false)
			expect(isValidTraceState('vendor= leading-space')).toBe(false)
			expect(isValidTraceState('Vendor=value')).toBe(false)
			expect(isValidTraceState('vendor=value,vendor=other')).toBe(false)
			expect(isValidTraceState('vendor=value=other')).toBe(false)
			expect(isValidTraceState('vendor=bad\tvalue')).toBe(false)
			expect(isValidTraceState(Array.from({length: 33}, (_, index) => `v${index}=x`).join(','))).toBe(false)
		})
	})

	describe('encodeBaggage', () => {

		it('should encode baggage attributes', () => {

			const attrs = {
				key1: 'value1',
				key2: 'value2'
			}

			const result = encodeBaggage(attrs)

			expect(result).toContain('key1=value1')
			expect(result).toContain('key2=value2')
		})

		it('should URL-encode values', () => {

			const attrs = {
				key: 'value with spaces'
			}

			const result = encodeBaggage(attrs)

			expect(result).toContain('value%20with%20spaces')
		})

		it('should skip invalid keys', () => {

			const attrs = {
				'valid-key': 'value',
				'invalid key': 'value',
				'invalid@key': 'value'
			}

			const result = encodeBaggage(attrs)

			expect(result).toContain('valid-key=value')
			expect(result).not.toContain('invalid')
		})

		it('should skip null or undefined values', () => {

			const attrs: Record<string, string | null | undefined> = {
				key1: 'value',
				key2: null,
				key3: undefined
			}

			const result = encodeBaggage(attrs)

			expect(result).toContain('key1=value')
			expect(result).not.toContain('key2')
			expect(result).not.toContain('key3')
		})

		it('should handle empty attributes', () => {

			const result = encodeBaggage({})

			expect(result).toBe('')
		})

		it('supports RFC token keys and enforces the W3C wire limits', () => {
			expect(encodeBaggage({'trace!key': 'value'})).toBe('trace!key=value')
			const encoded = encodeBaggage(Object.fromEntries(
				Array.from({length: 65}, (_, index) => [`key${index}`, 'value'])
			) as never)
			expect(encoded.split(',')).toHaveLength(64)
			expect(Buffer.byteLength(encodeBaggage({large: '😀'.repeat(10_000)}))).toBeLessThanOrEqual(8_192)
		})

		it('does not coerce object baggage values or materialize wide descriptor maps', () => {
			let coercions = 0
			const hostile = {toString: () => { coercions++; return 'secret' }}
			expect(encodeBaggage({safe: 'value', hostile} as never)).toBe('safe=value')
			expect(coercions).toBe(0)

			const descriptorMaps = vi.spyOn(Object, 'getOwnPropertyDescriptors')
			try {
				const baggage = Object.fromEntries(
					Array.from({length: 10_000}, (_, index) => [`key${index}`, 'value'])
				)
				expect(encodeBaggage(baggage as never)).toBe('')
				const headers = Object.fromEntries(
					Array.from({length: 10_000}, (_, index) => [`header${index}`, 'value'])
				)
				expect(extractW3C(headers)).toEqual({})
				expect(descriptorMaps.mock.calls.some(([value]) => value === baggage || value === headers)).toBe(false)
			} finally { descriptorMaps.mockRestore() }
		}, 120_000)

		it('rejects proxy baggage and carriers before enumeration traps run', () => {
			const baggageKeys = vi.fn(() => ['key'])
			const carrierKeys = vi.fn(() => ['traceparent'])
			const baggage = new Proxy({key: 'value'}, {ownKeys: baggageKeys})
			const carrier = new Proxy({traceparent: 'invalid'}, {ownKeys: carrierKeys})

			expect(encodeBaggage(baggage)).toBe('')
			expect(extractW3C(carrier)).toEqual({})
			expect(() => injectXTraceId(carrier, 'a'.repeat(32))).toThrow('Proxy')
			expect(baggageKeys).not.toHaveBeenCalled()
			expect(carrierKeys).not.toHaveBeenCalled()
		})
	})

	describe('decodeBaggage', () => {

		it('should decode baggage header', () => {

			const header = 'key1=value1,key2=value2'

			const result = decodeBaggage(header)

			expect(result.key1).toBe('value1')
			expect(result.key2).toBe('value2')
		})

		it('should URL-decode values', () => {

			const header = 'key=value%20with%20spaces'

			const result = decodeBaggage(header)

			expect(result.key).toBe('value with spaces')
		})

		it('should handle empty header', () => {

			const result = decodeBaggage('')

			expect(Object.keys(result).length).toBe(0)
		})

		it('should handle invalid header', () => {

			const result = decodeBaggage(null as unknown as string)

			expect(Object.keys(result).length).toBe(0)
		})

		it('should skip invalid pairs', () => {

			const header = 'key1=value1,invalid,key2=value2'

			const result = decodeBaggage(header)

			expect(result.key1).toBe('value1')
			expect(result.key2).toBe('value2')
		})

		it('should skip invalid keys', () => {

			const header = 'valid-key=value,invalid key=value'

			const result = decodeBaggage(header)

			expect(result['valid-key']).toBe('value')
			expect(result['invalid key']).toBeUndefined()
		})

		it('should handle invalid URL encoding', () => {

			const header = 'key=%invalid'

			const result = decodeBaggage(header)

			// Should skip invalid encoding
			expect(result.key).toBeUndefined()
		})

		it('should trim whitespace', () => {

			const header = ' key1 = value1 , key2 = value2 '

			const result = decodeBaggage(header)

			expect(result.key1).toBe('value1')
			expect(result.key2).toBe('value2')
		})

		it('parses values, properties, and malformed UTF-8 according to W3C baggage', () => {
			const result = decodeBaggage('trace!key=a=b;property=meta,utf8=%FF')
			expect(result['trace!key']).toBe('a=b')
			expect(result.utf8).toBe('\uFFFD')
			expect(decodeBaggage('key=value;bad property=x')).toEqual({})
			expect(decodeBaggage(Array.from({length: 65}, (_, index) => `k${index}=v`).join(','))).toEqual({})
		})
	})

	describe('injectW3C', () => {

		it('should inject traceparent into carrier', () => {

			const carrier: Record<string, string> = {}
			const context = {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7',
				traceFlags: 0x1
			}

			injectW3C(carrier, context)

			expect(carrier.traceparent).toBeDefined()
			expect(carrier.traceparent).toContain(TRACEPARENT_VERSION)
		})

		it('should inject tracestate if present', () => {

			const carrier: Record<string, string> = {}
			const context = {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7',
				traceFlags: 0x1,
				traceState: 'key=value'
			}

			injectW3C(carrier, context)

			expect(carrier.tracestate).toBe('key=value')
		})

		it('should inject baggage if provided', () => {

			const carrier: Record<string, string> = {}
			const context = {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7',
				traceFlags: 0x1
			}
			const baggage = {
				key1: 'value1',
				key2: 'value2'
			}

			injectW3C(carrier, context, baggage)

			expect(carrier.baggage).toBeDefined()
			expect(carrier.baggage).toContain('key1=value1')
		})

		it('should not inject empty baggage', () => {

			const carrier: Record<string, string> = {}
			const context = {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7',
				traceFlags: 0x1
			}

			injectW3C(carrier, context, {})

			expect(carrier.baggage).toBeUndefined()
		})

		it('preflights carrier mutation without invoking setters or leaving partial headers', () => {
			let writes = 0
			const accessor = Object.defineProperty({}, 'traceparent', {
				enumerable: true,
				configurable: true,
				set: () => { writes++ }
			})
			expect(() => injectW3C(accessor as never, {
				traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)
			})).toThrow('accessor-backed')
			expect(writes).toBe(0)

			const immutable = {existing: 'safe'} as Record<string, string>
			Object.defineProperty(immutable, 'baggage', {
				value: 'stale', enumerable: true, configurable: false, writable: false
			})
			expect(() => injectW3C(immutable, {
				traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)
			})).toThrow('immutable')
			expect(immutable).toEqual({existing: 'safe', baggage: 'stale'})
			expect(immutable).not.toHaveProperty('traceparent')

			const hiddenImmutable = {Traceparent: 'case-variant'} as Record<string, string>
			Object.defineProperty(hiddenImmutable, 'baggage', {
				value: 'hidden-stale', enumerable: false, configurable: false, writable: false
			})
			expect(() => injectW3C(hiddenImmutable, {
				traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)
			})).toThrow('immutable')
			expect(hiddenImmutable.Traceparent).toBe('case-variant')
			expect(Object.getOwnPropertyDescriptor(hiddenImmutable, 'baggage')?.value)
				.toBe('hidden-stale')
			expect(hiddenImmutable).not.toHaveProperty('traceparent')
		})

		it('canonicalizes case variants during injection', () => {
			const carrier = {Traceparent: 'stale', Tracestate: 'stale'} as Record<string, string>
			injectW3C(carrier, {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)})
			expect(carrier).not.toHaveProperty('Traceparent')
			expect(carrier).not.toHaveProperty('Tracestate')
			expect(carrier.traceparent).toContain('a'.repeat(32))
		})
	})

	describe('extractW3C', () => {

		it('should extract traceparent from carrier', () => {

			const carrier: Record<string, string> = {
				traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
			}

			const result = extractW3C(carrier)

			expect(result.context).toBeDefined()
			expect(result.context?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
		})

		it('should extract tracestate from carrier', () => {

			const carrier: Record<string, string> = {
				traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
				tracestate: 'key=value'
			}

			const result = extractW3C(carrier)

			expect(result.context?.traceState).toBe('key=value')
		})

		it('drops unsafe extracted tracestate without discarding valid trace context', () => {
			const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
			const result = extractW3C({traceparent, tracestate: 'bad\nstate'})
			expect(result.context).toEqual(expect.objectContaining({traceId: '4bf92f3577b34da6a3ce929d0e0e4736'}))
			expect(result.context?.traceState).toBeUndefined()
			expect(extractW3C({traceparent, tracestate: 'x'.repeat(513)}).context?.traceState).toBeUndefined()
		})

		it('should extract baggage from carrier', () => {

			const carrier: Record<string, string> = {
				baggage: 'key1=value1,key2=value2'
			}

			const result = extractW3C(carrier)

			expect(result.baggage).toBeDefined()
			expect(result.baggage?.key1).toBe('value1')
		})

		it('should handle case-insensitive header lookup', () => {

			const carrier: Record<string, string> = {
				TRACEPARENT: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
			}

			const result = extractW3C(carrier)

			expect(result.context).toBeDefined()
		})

		it('fails closed for conflicting or accessor-backed tracing headers', () => {
			const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
			expect(extractW3C({traceparent, Traceparent: traceparent.replace('4b', '5b')})).toEqual({})
			let getterCalls = 0
			const hostile = Object.defineProperty({}, 'traceparent', {
				enumerable: true,
				get: () => { getterCalls++; return traceparent }
			})
			expect(extractW3C(hostile as never)).toEqual({})
			expect(getterCalls).toBe(0)
		})

		it('fails closed before traps in a tracing carrier prototype chain', () => {
			const ownKeys = vi.fn(() => ['traceparent'])
			const getOwnPropertyDescriptor = vi.fn(() => ({
				value: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
				enumerable: true, configurable: true, writable: true
			}))
			const prototype = new Proxy({}, {ownKeys, getOwnPropertyDescriptor})
			const carrier = Object.create(prototype) as Record<string, string>
			Object.defineProperty(carrier, 'traceparent', {
				value: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', enumerable: true
			})

			expect(extractW3C(carrier)).toEqual({})
			expect(ownKeys).not.toHaveBeenCalled()
			expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		})

		it('should return empty result when no headers', () => {

			const carrier: Record<string, string> = {}

			const result = extractW3C(carrier)

			expect(result.context).toBeUndefined()
			expect(result.baggage).toBeUndefined()
		})

		it('should return undefined context for invalid traceparent', () => {

			const carrier: Record<string, string> = {
				traceparent: 'invalid'
			}

			const result = extractW3C(carrier)

			expect(result.context).toBeUndefined()
		})
	})

	describe('injectXTraceId', () => {

		it('should inject x-trace-id header', () => {

			const carrier: Record<string, string> = {}
			const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'

			injectXTraceId(carrier, traceId)

			expect(carrier['x-trace-id']).toBe(traceId)
		})
	})

	describe('extractXTraceId', () => {

		it('should extract x-trace-id header', () => {

			const carrier: Record<string, string> = {
				'x-trace-id': '4bf92f3577b34da6a3ce929d0e0e4736'
			}

			const result = extractXTraceId(carrier)

			expect(result).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
		})

		it('rejects malformed fallback trace IDs', () => {
			expect(extractXTraceId({'x-trace-id': 'short'})).toBeUndefined()
			expect(extractXTraceId({'x-trace-id': '0'.repeat(32)})).toBeUndefined()
			expect(() => injectXTraceId({}, 'short')).toThrow('x-trace-id')
		})

		it('should handle case variations', () => {

			const traceId = 'a'.repeat(32)
			expect(extractXTraceId({'X-Trace-Id': traceId})).toBe(traceId)
			expect(extractXTraceId({'X-TRACE-ID': traceId})).toBe(traceId)
		})

		it('rejects case-conflicting fallback headers', () => {
			expect(extractXTraceId({
				'x-trace-id': 'a'.repeat(32),
				'X-Trace-Id': 'b'.repeat(32)
			})).toBeUndefined()
		})

		it('does not invoke accessor-backed fallback headers', () => {
			let reads = 0
			const carrier = Object.create(null) as Record<string, string>
			Object.defineProperty(carrier, 'x-trace-id', {
				enumerable: true,
				get() { reads += 1; return 'a'.repeat(32) }
			})

			expect(extractXTraceId(carrier)).toBeUndefined()
			expect(reads).toBe(0)
		})

		it('should return undefined when not found', () => {

			const carrier: Record<string, string> = {}

			const result = extractXTraceId(carrier)

			expect(result).toBeUndefined()
		})
	})
})
