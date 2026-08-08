/**
 * @file Tests for OTLP span export utilities.
 */

import {describe, it, expect, vi} from 'vitest'

import {
	serializeSpanToOtlp,
	serializeSpansToOtlpJson
} from '../../../src/runtime/tracing/export-otlp'

describe('export-otlp', () => {

	describe('serializeSpanToOtlp', () => {

		it('should serialize basic span', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.traceId).toBe('12345678901234567890123456789012')
			expect(result.spanId).toBe('1234567890123456')
			expect(result.name).toBe('test-span')
			expect(result.kind).toBe(1) // internal
		})

		it('preserves span data under wide prototype pollution', () => {
			const polluted: string[] = []
			let result: ReturnType<typeof serializeSpanToOtlp> | undefined
			let failure: unknown
			try {
				for (let index = 0; index < 1_100; index += 1) {
					const key = `polluted_otlp_${index}`
					polluted.push(key)
					Object.defineProperty(Object.prototype, key, {
						configurable: true, enumerable: true, value: 'forged'
					})
				}
				result = serializeSpanToOtlp({
					context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
					name: 'safe-span', kind: 'internal', startTime: 1_000,
					status: {code: 'ok'}, attributes: {safe: 'value'}, events: [], links: []
				})
			} catch(error) { failure = error }
			finally {
				for (const key of polluted) delete (Object.prototype as Record<string, unknown>)[key]
			}

			expect(failure).toBeUndefined()
			expect(result?.attributes).toEqual([{key: 'safe', value: {stringValue: 'value'}}])
		})

		it('preserves identifier validation after RegExp.prototype.test is rewired', () => {
			const traceId = '1234567890abcdef1234567890abcdef'
			const spanId = '1234567890abcdef'
			const parentSpanId = 'fedcba0987654321'
			const test = vi.spyOn(RegExp.prototype, 'test').mockImplementation(() => {
				throw new Error('rewired RegExp.test')
			})
			let result: ReturnType<typeof serializeSpanToOtlp> | undefined
			try {
				result = serializeSpanToOtlp({
					context: {traceId, spanId, parentSpanId},
					parentContext: {traceId, spanId: parentSpanId},
					name: 'safe-span', kind: 'internal', startTime: 1_000,
					status: {code: 'ok'}, attributes: {}, events: [],
					links: [{context: {traceId, spanId: parentSpanId}}]
				})
			} finally { test.mockRestore() }

			expect(result).toMatchObject({traceId, spanId, parentSpanId})
		})

		it('does not consult rewired string iterators while validating span names', () => {
			const iteratorDescriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!
			const charCodeDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!
			const poison = (): never => { throw new Error('poisoned string intrinsic') }
			let name = ''
			try {
				Object.defineProperties(String.prototype, {
					[Symbol.iterator]: {configurable: true, writable: true, value: poison},
					charCodeAt: {configurable: true, writable: true, value: poison}
				})
				name = serializeSpanToOtlp({
					context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
					name: 'safe-span', kind: 'internal', startTime: 1_000,
					status: {code: 'ok'}, attributes: {}, events: [], links: []
				}).name
			} finally {
				Object.defineProperty(String.prototype, Symbol.iterator, iteratorDescriptor)
				Object.defineProperty(String.prototype, 'charCodeAt', charCodeDescriptor)
			}

			expect(name).toBe('safe-span')
		})

		it('preserves OTLP serialization after collection intrinsics are rewired', () => {
			const span = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				name: 'safe-span', kind: 'internal', startTime: 1_000,
				status: {code: 'ok'}, attributes: {nested: {safe: true}},
				events: [{name: 'event', timestamp: 1_001}], links: [],
				resource: {'service.name': 'api'}
			}
			const targets = [
				[Array, 'isArray'], [Array.prototype, 'includes'], [Array.prototype, 'map'],
				[Array.prototype, 'push'], [Array.prototype, 'sort'], [Array.prototype, 'join'],
				[Array.prototype, Symbol.iterator], [Number, 'isFinite'], [Number, 'isInteger'],
				[Number, 'isSafeInteger'], [Number.prototype, 'toString'], [Math, 'floor'], [Math, 'trunc'],
				[BigInt.prototype, 'toString'],
				[Map.prototype, 'get'], [Map.prototype, 'set'], [Map.prototype, 'values'],
				[WeakMap.prototype, 'get'], [WeakMap.prototype, 'set'],
				[WeakSet.prototype, 'add'], [WeakSet.prototype, 'has'], [WeakSet.prototype, 'delete'],
				[Object, 'create'], [Object, 'freeze'], [Object, 'getOwnPropertyDescriptor'],
				[Object, 'getPrototypeOf'], [Reflect, 'ownKeys'], [globalThis, 'String']
			] as const
			const descriptors = targets.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key)!)
			const poison = (): never => { throw new Error('poisoned collection intrinsic') }
			let serialized = ''
			try {
				for (let index = 0; index < targets.length; index += 1) {
					const entry = targets[index]!
					const owner = entry[0]
					const key = entry[1]
					Object.defineProperty(owner, key, {configurable: true, writable: true, value: poison})
				}
				serialized = serializeSpansToOtlpJson([span] as never)
			} finally {
				for (let index = 0; index < targets.length; index += 1) {
					const entry = targets[index]!
					const owner = entry[0]
					const key = entry[1]
					Object.defineProperty(owner, key, descriptors[index]!)
				}
			}

			expect(JSON.parse(serialized).resourceSpans[0].scopeSpans[0].spans[0].name)
				.toBe('safe-span')
		})

		it('should serialize span with endTime', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'server',
				startTime: 1000,
				endTime: 2000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.startTimeUnixNano).toBeDefined()
			expect(result.endTimeUnixNano).toBeDefined()
			expect(result.endTimeUnixNano).not.toBe(result.startTimeUnixNano)
		})

		it('converts real epoch milliseconds without unsafe number multiplication', () => {
			const startTime = 1_700_000_000_000.25
			const result = serializeSpanToOtlp({
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}, name: 'timestamp', kind: 'internal',
				startTime, endTime: startTime + 0.5, status: {code: 'ok'}, attributes: {}, events: [], links: []
			})
			expect(result.startTimeUnixNano).toBe('1700000000000250000')
			expect(result.endTimeUnixNano).toBe('1700000000000750000')
		})

		it('should serialize span without endTime', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'client',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.endTimeUnixNano).toBe(result.startTimeUnixNano)
		})

		it('uses durationMs when an explicit endTime is absent', () => {
			const result = serializeSpanToOtlp({
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				name: 'duration-only', kind: 'internal', startTime: 1000, durationMs: 250.5,
				status: {code: 'ok'}, attributes: {}, events: [], links: []
			})

			expect(result.startTimeUnixNano).toBe('1000000000')
			expect(result.endTimeUnixNano).toBe('1250500000')
		})

		it('rejects invalid or overflowing durationMs values', () => {
			const base = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				name: 'duration-only', kind: 'internal' as const, startTime: 1000,
				status: {code: 'ok' as const}, attributes: {}, events: [], links: []
			}

			expect(() => serializeSpanToOtlp({...base, durationMs: -1})).toThrow('durationMs')
			expect(() => serializeSpanToOtlp({...base, durationMs: Number.NaN})).toThrow('durationMs')
			expect(() => serializeSpanToOtlp({
				...base, startTime: 18_446_744_073_709, durationMs: 1
			})).toThrow('startTime + durationMs')
		})

		it('should serialize span with attributes', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {
					key1: 'value1',
					key2: 123,
					key3: true
				},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.attributes).toBeDefined()
			expect(Array.isArray(result.attributes)).toBe(true)
		})

		it('should serialize span with events', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [
					{
						timestamp: 1500,
						name: 'event1',
						attributes: {key: 'value'}
					}
				],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.events).toBeDefined()
			expect(Array.isArray(result.events)).toBe(true)
			expect(result.events.length).toBe(1)
		})

		it('should serialize span with links', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: [
					{
						context: {
							traceId: 'abcdefabcdefabcdefabcdefabcdefab',
							spanId: 'abcdefabcdefabcd'
						}
					}
				]
			}

			const result = serializeSpanToOtlp(span)

			expect(result.links).toBeDefined()
			expect(Array.isArray(result.links)).toBe(true)
			expect(result.links.length).toBe(1)
		})

		it('should not serialize resource on individual spans', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: [],
				resource: {
					service: 'test-service',
					version: '1.0.0'
				}
			}

			const result = serializeSpanToOtlp(span)

			expect(result.resource).toBeUndefined()
		})

		it('should convert span kinds correctly', () => {

			const kinds = ['internal', 'server', 'client', 'producer', 'consumer'] as const

			for (const kind of kinds) {
				const span = {
					context: {
						traceId: '12345678901234567890123456789012',
						spanId: '1234567890123456'
					},
					name: 'test-span',
					kind,
					startTime: 1000,
					status: {code: 'ok'},
					attributes: {},
					events: [],
					links: []
				}

				const result = serializeSpanToOtlp(span)

				const expectedKind = kinds.indexOf(kind) + 1
				expect(result.kind).toBe(expectedKind)
			}
		})

		it('should convert status codes correctly', () => {

			const codes = ['unset', 'ok', 'error'] as const

			for (const code of codes) {
				const span = {
					context: {
						traceId: '12345678901234567890123456789012',
						spanId: '1234567890123456'
					},
					name: 'test-span',
					kind: 'internal',
					startTime: 1000,
					status: {code},
					attributes: {},
					events: [],
					links: []
				}

				const result = serializeSpanToOtlp(span)

				const expectedCode = codes.indexOf(code)
				expect(result.status.code).toBe(expectedCode)
			}
		})

		it('should include status description when provided', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'error', description: 'error occurred'},
				attributes: {},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.status.message).toBe('error occurred')
		})

		it('should handle parentSpanId from parentContext', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				parentContext: {
					traceId: '12345678901234567890123456789012',
					spanId: 'abcdef1234567890'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.parentSpanId).toBe('abcdef1234567890')
		})

		it('rejects cross-trace, conflicting, and upper-case context topology', () => {
			const base = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16)},
				name: 'topology', kind: 'internal' as const, startTime: 1,
				status: {code: 'ok' as const}, attributes: {}, events: []
			}
			expect(() => serializeSpanToOtlp({
				...base, parentContext: {traceId: 'd'.repeat(32), spanId: 'c'.repeat(16)}
			})).toThrow('same trace')
			expect(() => serializeSpanToOtlp({
				...base, parentContext: {traceId: 'a'.repeat(32), spanId: 'd'.repeat(16)}
			})).toThrow('conflicts')
			expect(() => serializeSpanToOtlp({
				...base, context: {...base.context, traceId: 'A'.repeat(32)}
			})).toThrow('lower-case')
		})

		it('should handle parentSpanId from context', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456',
					parentSpanId: 'abcdef1234567890'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.parentSpanId).toBe('abcdef1234567890')
		})

		it('should validate traceId format', () => {

			const span = {
				context: {
					traceId: 'invalid',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			expect(() => serializeSpanToOtlp(span)).toThrow('traceId must be 32 characters')
		})

		it('rejects zero identifiers and malformed events', () => {
			const base = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}, name: 'test-span', kind: 'internal' as const,
				startTime: 1, status: {code: 'ok' as const}, attributes: {}, events: [], links: []
			}
			expect(() => serializeSpanToOtlp({...base, context: {...base.context, traceId: '0'.repeat(32)}})).toThrow('all zeros')
			expect(() => serializeSpanToOtlp({...base, context: {...base.context, spanId: '0'.repeat(16)}})).toThrow('all zeros')
			expect(() => serializeSpanToOtlp({...base, events: [{name: '', timestamp: 1}]})).toThrow('events[0].name')
			expect(() => serializeSpanToOtlp({...base, events: [{name: 'bad\nevent', timestamp: 1}]})).toThrow('events[0].name')
			expect(() => serializeSpanToOtlp({...base, events: [{name: 'event', timestamp: Number.NaN}]})).toThrow('timestamp')
			expect(() => serializeSpanToOtlp({...base, links: [{context: {traceId: '0'.repeat(32), spanId: 'b'.repeat(16)}}]})).toThrow('all zeros')
			expect(() => serializeSpanToOtlp({...base, links: [{context: {traceId: 'a'.repeat(32), spanId: '0'.repeat(16)}}]})).toThrow('all zeros')
			expect(() => serializeSpanToOtlp({...base, name: ''})).toThrow('name')
			expect(() => serializeSpanToOtlp({...base, attributes: null as never})).toThrow('attributes')
			expect(() => serializeSpanToOtlp({...base, droppedEventsCount: -1})).toThrow('droppedEventsCount')
		})

		it('serializes integers outside the safe range as OTLP doubles', () => {
			const span = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}, name: 'numbers', kind: 'internal' as const,
				startTime: 1, status: {code: 'ok' as const}, attributes: {large: 10 ** 20}, events: [], links: []
			}
			const result = serializeSpanToOtlp(span)
			expect(result.attributes).toEqual([{key: 'large', value: {doubleValue: 10 ** 20}}])
		})

		it('should validate spanId format', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: 'invalid'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			expect(() => serializeSpanToOtlp(span)).toThrow('spanId must be 16 characters')
		})

		it('should validate traceId is hexadecimal', () => {

			const span = {
				context: {
					traceId: '1234567890123456789012345678901g', // Invalid hex
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			expect(() => serializeSpanToOtlp(span)).toThrow('traceId must be hexadecimal')
		})

		it('should validate startTime is finite', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: Infinity,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			expect(() => serializeSpanToOtlp(span)).toThrow('startTime must be a finite number')
		})

		it('should validate endTime is after startTime', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 2000,
				endTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			expect(() => serializeSpanToOtlp(span)).toThrow('endTime')
		})

		it('should validate span kind', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'invalid-kind',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			expect(() => serializeSpanToOtlp(span)).toThrow('kind must be one of')
		})

		it('should validate status code', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'invalid-code'},
				attributes: {},
				events: [],
				links: []
			}

			expect(() => serializeSpanToOtlp(span)).toThrow('status.code must be one of')
		})

		it('should handle attributes with different types', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {
					string: 'value',
					number: 123,
					float: 123.456,
					boolean: true,
					array: [1, 2, 3]
				},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.attributes).toBeDefined()
			expect(Array.isArray(result.attributes)).toBe(true)
		})

		it('encodes nested JSON attributes as OTLP kvlists and rejects non-finite numbers', () => {
			const base = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}, name: 'test-span', kind: 'internal' as const,
				startTime: 1, status: {code: 'ok' as const}, events: [], links: []
			}
			const result = serializeSpanToOtlp({...base, attributes: {nested: {tenant: 'one'}}})
			expect(result.attributes).toEqual([
				{key: 'nested', value: {kvlistValue: {values: [{key: 'tenant', value: {stringValue: 'one'}}]}}}
			])
			expect(() => serializeSpanToOtlp({...base, attributes: {invalid: Number.NaN}})).toThrow('finite')
		})

		it('rejects sparse and accessor-backed attribute arrays before mapping them', () => {
			const base = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}, name: 'test-span', kind: 'internal' as const,
				startTime: 1, status: {code: 'ok' as const}, events: [], links: []
			}
			const sparse = new Array(10_001)
			let reads = 0
			const accessor = ['safe']
			Object.defineProperty(accessor, '0', {
				enumerable: true,
				get() { reads += 1; return 'unsafe' }
			})

			expect(() => serializeSpanToOtlp({...base, attributes: {sparse}})).toThrow('at most 10000')
			expect(() => serializeSpanToOtlp({...base, attributes: {accessor}})).toThrow('dense data arrays')
			expect(reads).toBe(0)
		})

		it('does not execute accessor-backed top-level span fields', () => {
			let reads = 0
			const span = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				kind: 'internal', startTime: 1, status: {code: 'ok'},
				attributes: {}, events: [], links: []
			} as Record<string, unknown>
			Object.defineProperty(span, 'name', {
				enumerable: true,
				get() { reads += 1; return 'unsafe' }
			})

			expect(() => serializeSpanToOtlp(span as never)).toThrow('data properties')
			expect(reads).toBe(0)
		})

		it('does not traverse unknown span fields that cannot affect the OTLP payload', () => {
			let reads = 0
			const unused = Object.defineProperty({}, 'hidden', {
				enumerable: true,
				get() { reads += 1; return 'unsafe' }
			})
			const wideUnused = Object.fromEntries(
				Array.from({length: 10_001}, (_, index) => [`unused-${index}`, index])
			)
			const base = {
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				name: 'bounded', kind: 'internal' as const, startTime: 1,
				status: {code: 'ok' as const}, attributes: {}, events: [], links: []
			}

			expect(serializeSpanToOtlp({...base, unused} as never).name).toBe('bounded')
			expect(serializeSpanToOtlp({...base, wideUnused} as never).name).toBe('bounded')
			expect(reads).toBe(0)
		})

		it('rejects proxies before executing descriptor traps', () => {
			let traceIdReads = 0
			const context = new Proxy({traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}, {
				getOwnPropertyDescriptor(target, key) {
					if (key === 'traceId') {
						traceIdReads += 1
						return {configurable: true, enumerable: true, writable: true,
							value: traceIdReads === 1 ? 'a'.repeat(32) : 'c'.repeat(32)}
					}
					return Reflect.getOwnPropertyDescriptor(target, key)
				}
			})
			expect(() => serializeSpanToOtlp({
				context, name: 'proxied', kind: 'internal', startTime: 1,
				status: {code: 'ok'}, attributes: {}, events: [], links: []
			})).toThrow('Proxy')

			expect(traceIdReads).toBe(0)
		})

		it('rejects wide span objects before materializing their complete key list', () => {
			const attributes = Object.fromEntries(
				Array.from({length: 10_001}, (_, index) => [`key-${index}`, index])
			)
			const ownKeys = vi.spyOn(Reflect, 'ownKeys')
			try {
				expect(() => serializeSpanToOtlp({
					context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
					name: 'wide', kind: 'internal', startTime: 1,
					status: {code: 'ok'}, attributes, events: [], links: []
				})).toThrow('at most 10000')
				expect(ownKeys.mock.calls.some(([value]) => value === attributes)).toBe(false)
			} finally { ownKeys.mockRestore() }
		})

		it('should handle dropped counts', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: [],
				droppedAttributesCount: 5,
				droppedEventsCount: 3,
				droppedLinksCount: 2
			}

			const result = serializeSpanToOtlp(span)

			expect(result.droppedAttributesCount).toBe(5)
			expect(result.droppedEventsCount).toBe(3)
			expect(result.droppedLinksCount).toBe(2)
		})

		it('should handle traceState', () => {

			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456',
					traceState: 'key=value'
				},
				name: 'test-span',
				kind: 'internal',
				startTime: 1000,
				status: {code: 'ok'},
				attributes: {},
				events: [],
				links: []
			}

			const result = serializeSpanToOtlp(span)

			expect(result.traceState).toBe('key=value')
		})
	})

	describe('serializeSpansToOtlpJson', () => {
		it('rejects proxied batches before descriptor traps', () => {
			const getOwnPropertyDescriptor = vi.fn(() => undefined)
			const spans = new Proxy([], {getOwnPropertyDescriptor})

			expect(() => serializeSpansToOtlpJson(spans)).toThrow('input must be an array')
			expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		})

		it('serializes optional fields, null attributes, and mixed attribute arrays', () => {
			const span = {
				context: {
					traceId: '12345678901234567890123456789012',
					spanId: '1234567890123456'
				},
				name: 'optional-fields',
				kind: 'producer',
				startTime: 0,
				endTime: 0,
				status: {code: 'unset'},
				attributes: {
					nullish: null,
					missing: undefined,
					mixed: ['text', 1, 1.5, false, null],
					object: {nested: true}
				},
				events: [{timestamp: 0, name: 'event'}],
				links: []
			}

			const result = serializeSpanToOtlp(span)
			expect(result.endTimeUnixNano).toBe('0')
			expect(result.attributes).toEqual([
				{key: 'mixed', value: {arrayValue: {values: [
					{stringValue: 'text'}, {intValue: '1'}, {doubleValue: 1.5},
					{boolValue: false}, {stringValue: 'null'}
				]}}},
				{key: 'object', value: {kvlistValue: {values: [
					{key: 'nested', value: {boolValue: true}}
				]}}}
			])
		})

		it('validates optional resource and link shapes', () => {
			const base = {
				context: {traceId: '12345678901234567890123456789012', spanId: '1234567890123456'},
				name: 'invalid', kind: 'internal', startTime: 1, status: {code: 'ok'}, attributes: {}, events: [], links: []
			}
			expect(() => serializeSpanToOtlp({...base, resource: []})).toThrow('resource must be')
			expect(() => serializeSpanToOtlp({...base, links: [{}]})).toThrow('links[0].context')
			expect(() => serializeSpanToOtlp({...base, links: [{context: {traceId: 'x'.repeat(32), spanId: '1234567890123456'}}]})).toThrow('traceId must be hexadecimal')
		})

		it('rejects remaining invalid scalar and nested span shapes', () => {
			const base = {
				context: {traceId: '12345678901234567890123456789012', spanId: '1234567890123456'},
				name: 'invalid', kind: 'internal', startTime: 1, status: {code: 'ok'}, attributes: {}, events: [], links: []
			}
			expect(() => serializeSpanToOtlp({...base, context: {...base.context, traceId: ''}})).toThrow('traceId is required')
			expect(() => serializeSpanToOtlp({...base, context: {...base.context, spanId: 'g'.repeat(16)}})).toThrow('spanId must be hexadecimal')
			expect(() => serializeSpanToOtlp({...base, startTime: -1})).toThrow('startTime must be between')
			expect(() => serializeSpanToOtlp({...base, endTime: -1})).toThrow('endTime must be between')
			expect(() => serializeSpanToOtlp({...base, endTime: Number.NaN})).toThrow('endTime must be a finite number')
			expect(() => serializeSpanToOtlp({...base, startTime: 18_446_744_073_710})).toThrow('startTime must be between')
			expect(() => serializeSpanToOtlp({...base, endTime: 18_446_744_073_710})).toThrow('endTime must be between')
			expect(() => serializeSpanToOtlp({...base, events: [{name: 'future', timestamp: 18_446_744_073_710}]}))
				.toThrow('OTLP uint64')
			expect(() => serializeSpanToOtlp({...base, droppedEventsCount: 0x1_0000_0000}))
				.toThrow('OTLP uint32')
			expect(() => serializeSpanToOtlp({...base, resource: {bad: new Date()}})).toThrow('resource attribute "bad"')
			expect(() => serializeSpanToOtlp({...base, links: 'not-an-array'})).toThrow('links must be')
			expect(() => serializeSpanToOtlp({...base, links: [{context: {traceId: '12345678901234567890123456789012', spanId: '1234567890123456'}, attributes: []}]})).toThrow('attributes must be')
		})

		it('should serialize multiple spans', () => {

			const spans = [
				{
					context: {
						traceId: '12345678901234567890123456789012',
						spanId: '1234567890123456'
					},
					name: 'span1',
					kind: 'internal',
					startTime: 1000,
					status: {code: 'ok'},
					attributes: {},
					events: [],
					links: []
				},
				{
					context: {
						traceId: '12345678901234567890123456789012',
						spanId: 'abcdefabcdefabcd'
					},
					name: 'span2',
					kind: 'internal',
					startTime: 2000,
					status: {code: 'ok'},
					attributes: {},
					events: [],
					links: []
				}
			]

			const result = serializeSpansToOtlpJson(spans)
			const parsed = JSON.parse(result)

			expect(parsed.resourceSpans).toBeDefined()
			expect(Array.isArray(parsed.resourceSpans)).toBe(true)
			expect(parsed.resourceSpans[0].scopeSpans[0].spans.length).toBe(2)
		})

		it('should serialize empty spans array', () => {

			const result = serializeSpansToOtlpJson([])
			const parsed = JSON.parse(result)

			expect(parsed.resourceSpans).toBeDefined()
			expect(parsed.resourceSpans[0].scopeSpans[0].spans.length).toBe(0)
		})

		it('rejects oversized sparse batches and does not invoke custom iterators', () => {
			expect(() => serializeSpansToOtlpJson(new Array(10_001) as never)).toThrow('at most 10000')

			let iteratorCalls = 0
			const spans = [{
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				name: 'safe', kind: 'internal', startTime: 1,
				status: {code: 'ok'}, attributes: {}, events: [], links: []
			}]
			Object.defineProperty(spans, Symbol.iterator, {
				value() { iteratorCalls += 1; throw new Error('must not execute') }
			})

			expect(() => serializeSpansToOtlpJson(spans as never)).not.toThrow()
			expect(iteratorCalls).toBe(0)
		})

		it('should group spans by resource', () => {

			const spans = [
				{
					context: {
						traceId: '12345678901234567890123456789012',
						spanId: '1234567890123456'
					},
					name: 'span1',
					kind: 'internal',
					startTime: 1000,
					status: {code: 'ok'},
					attributes: {},
					events: [],
					links: [],
					resource: {'service.name': 'api'}
				},
				{
					context: {
						traceId: '12345678901234567890123456789012',
						spanId: 'abcdefabcdefabcd'
					},
					name: 'span2',
					kind: 'internal',
					startTime: 2000,
					status: {code: 'ok'},
					attributes: {},
					events: [],
					links: [],
					resource: {'service.name': 'worker'}
				}
			]

			const parsed = JSON.parse(serializeSpansToOtlpJson(spans))

			expect(parsed.resourceSpans).toHaveLength(2)
			expect(parsed.resourceSpans[0].resource.attributes).toEqual([
				{key: 'service.name', value: {stringValue: 'api'}}
			])
			expect(parsed.resourceSpans[0].scopeSpans[0].spans[0]).not.toHaveProperty('resource')
		})

		it('enforces one traversal budget for attributes omitted from the wire payload', () => {
			const attributes = Object.fromEntries(
				Array.from({length: 10_000}, (_, index) => [`unused-${index}`, undefined])
			)
			const spans = Array.from({length: 60}, (_, index) => ({
				context: {
					traceId: 'a'.repeat(32),
					spanId: (index + 1).toString(16).padStart(16, '0')
				},
				name: `span-${index}`, kind: 'internal' as const, startTime: 1,
				status: {code: 'ok' as const}, attributes, events: [], links: []
			}))

			expect(() => serializeSpansToOtlpJson(spans)).toThrow('snapshot budget exceeded')
		}, 10_000)

		it('enforces one aggregate wire budget across individually valid spans', () => {
			// Many compact inputs have much larger OTLP key/value wrappers. This
			// reaches the wire budget before the independent traversal budget.
			const attributes = Object.fromEntries(
				Array.from({length: 10_000}, (_, index) => [`k${index}`, true])
			)
			const spans = Array.from({length: 50}, (_, index) => ({
				context: {
					traceId: 'a'.repeat(32),
					spanId: (index + 1).toString(16).padStart(16, '0')
				},
				name: `span-${index}`, kind: 'internal' as const, startTime: 1,
				status: {code: 'ok' as const}, attributes, events: [], links: []
			}))

			expect(() => serializeSpansToOtlpJson(spans)).toThrow('must not exceed 16777216 bytes')
		}, 120_000)
	})
})
