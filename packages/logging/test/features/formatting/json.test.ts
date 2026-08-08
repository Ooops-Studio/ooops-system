import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import {describe, it, expect, vi} from 'vitest'

import {formatJson} from '../../../src/features/formatting/json'

describe('formatJson', () => {
	it('should format record as JSON', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = formatJson(record, {mode: 'json'})

		expect(result).toContain('"level":"info"')
		expect(result).toContain('"message":"test message"')
		expect(result).toContain('"time":1234567890000')
	})

	it('should handle records with context', () => {
		const record: LogRecord = {
			level: 'warn',
			message: 'warning message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				tags: ['tag1', 'tag2'],
				attributes: {
					userId: '123',
					action: 'login'
				}
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.level).toBe('warn')
		expect(parsed.message).toBe('warning message')
		expect(parsed.time).toBe(1234567890000)
		expect(parsed.namespace).toBe('test.namespace')
		expect(parsed.tags).toEqual(['tag1', 'tag2'])
		expect(parsed.attributes).toEqual({
			userId: '123',
			action: 'login'
		})
	})

	it('should handle records with error field', () => {
		const record: LogRecord & {error?: unknown} = {
			level: 'error',
			message: 'error message',
			time: 1234567890000,
			error: {
				name: 'TypeError',
				message: 'Something went wrong',
				stack: 'Error stack trace'
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.level).toBe('error')
		expect(parsed.message).toBe('error message')
		expect(parsed.error).toEqual({
			name: 'TypeError',
			message: 'Something went wrong',
			stack: 'Error stack trace'
		})
	})

	it('should sort object keys deterministically', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {
				attributes: {
					zebra: 'last',
					apple: 'first',
					banana: 'middle'
				}
			}
		}

		const result1 = formatJson(record, {mode: 'json'})
		const result2 = formatJson(record, {mode: 'json'})

		expect(result1).toBe(result2) // Should be identical

		const parsed = JSON.parse(result1)
		const attributeKeys = Object.keys(parsed.attributes)
		expect(attributeKeys).toEqual(['apple', 'banana', 'zebra'])
	})

	it('should handle nested objects and arrays', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'complex data',
			time: 1234567890000,
			context: {
				attributes: {
					user: {
						name: 'John',
						age: 30,
						hobbies: ['reading', 'coding']
					},
					metadata: {
						version: '1.0.0',
						features: ['feature1', 'feature2']
					}
				}
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.attributes.user).toEqual({
			name: 'John',
			age: 30,
			hobbies: ['reading', 'coding']
		})
		expect(parsed.attributes.metadata).toEqual({
			version: '1.0.0',
			features: ['feature1', 'feature2']
		})
	})

	it('should preserve repeated sibling object references', () => {
		const shared = {
			id: 'shared',
			value: 1
		}
		const record: LogRecord = {
			level: 'info',
			message: 'repeated references',
			time: 1234567890000,
			context: {
				attributes: {
					first: shared,
					second: shared
				} as unknown as Record<string, JsonValue>
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.attributes.first).toEqual(shared)
		expect(parsed.attributes.second).toEqual(shared)
	})

	it('should mark true cycles as circular', () => {
		const circular: Record<string, unknown> = {
			id: 'cycle'
		}
		circular.self = circular
		const record: LogRecord = {
			level: 'info',
			message: 'circular reference',
			time: 1234567890000,
			context: {
				attributes: {
					circular
				} as unknown as Record<string, JsonValue>
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.attributes.circular).toEqual({
			id: 'cycle',
			self: '[Circular]'
		})
	})

	it('bounds deep objects, large arrays, large objects, and long strings', () => {
		const deep: Record<string, unknown> = {}
		let cursor = deep
		for (let index = 0; index < 12; index += 1) {
			const next: Record<string, unknown> = {}
			cursor.next = next
			cursor = next
		}
		const largeObject: Record<string, unknown> = {}
		for (let index = 0; index < 1_005; index += 1) {
			largeObject[`key${index}`] = index
		}
		const record: LogRecord = {
			level: 'info',
			message: 'bounded',
			time: 1234567890000,
			context: {
				attributes: {
					deep,
					largeArray: Array.from({length: 1_005}, (_, index) => index),
					largeObject,
					longString: 'x'.repeat(17_000)
				} as never
			}
		}

		const parsed = JSON.parse(formatJson(record, {mode: 'json'}))
		const encoded = JSON.stringify(parsed)

		expect(encoded).toContain('[MaxDepth]')
		expect(parsed.attributes.largeArray.at(-1)).toBe('[MaxArrayLength]')
		expect(parsed.attributes.largeObject.__truncated__).toBe('[MaxEntries]')
		expect(parsed.attributes.longString).toContain('[Truncated]')
	})

	it('should serialize bigint, symbol, and function values without dropping context', () => {
		function namedFunction() {}
		const record: LogRecord = {
			level: 'info',
			message: 'special primitives',
			time: 1234567890000,
			context: {
				attributes: {
					count: 10n,
					symbol: Symbol('token'),
					callback: namedFunction
				} as unknown as Record<string, JsonValue>
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.message).toBe('special primitives')
		expect(parsed.attributes).toEqual({
			callback: '[Function:namedFunction]',
			count: '10',
			symbol: 'Symbol(token)'
		})
	})

	it('does not execute a function proxy name getter while formatting', () => {
		const nameRead = vi.fn()
		const callback = new Proxy(function hiddenCallback() {}, {
			get(target, property, receiver) {
				if (property === 'name') nameRead()
				return Reflect.get(target, property, receiver)
			}
		})
		const result = formatJson({
			level: 'info', message: 'proxy function', time: 1,
			context: {attributes: {callback} as never}
		}, {mode: 'json'})

		expect(result).toContain('[Function:hiddenCallback]')
		expect(nameRead).not.toHaveBeenCalled()
	})

	it('keeps structured output when a revoked proxy is encountered', () => {
		const {proxy, revoke} = Proxy.revocable({secret: 'value'}, {})
		revoke()
		const record: LogRecord = {
			level: 'info',
			message: 'revoked proxy',
			time: 1234567890000,
			context: {
				attributes: {
					payload: proxy
				} as never
			}
		}

		const parsed = JSON.parse(formatJson(record, {mode: 'json'}))

		expect(parsed.message).toBe('revoked proxy')
		expect(parsed.attributes.payload).toBe('[Unserializable]')
	})

	it('should preserve context when hostile attributes throw during traversal', () => {
		const hostileObject: Record<string, unknown> = {safe: 'ok'}
		Object.defineProperty(hostileObject, 'secret', {
			enumerable: true,
			get() {
				throw new Error('getter failed')
			}
		})
		const hostileProxy = new Proxy({safe: 'ok'}, {
			ownKeys() {
				throw new Error('ownKeys failed')
			}
		})
		const hostileArray = new Proxy(['ok'], {
			get(target, property, receiver) {
				if (property === '0') throw new Error('index failed')
				return Reflect.get(target, property, receiver)
			}
		})
		const record: LogRecord = {
			level: 'info',
			message: 'hostile attributes',
			time: 1234567890000,
			context: {
				attributes: {
					hostileArray,
					hostileObject,
					hostileProxy
				} as never
			}
		}

		const parsed = JSON.parse(formatJson(record, {mode: 'json'}))

		expect(parsed.message).toBe('hostile attributes')
		expect(parsed.attributes).toEqual({
			hostileArray: ['ok'],
			hostileObject: {
				safe: 'ok',
				secret: '[Unserializable]'
			},
			hostileProxy: '[Unserializable]'
		})
	})

	it('should handle null and undefined values', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'null test',
			time: 1234567890000,
			context: {
				attributes: {
					nullValue: null,
					// undefinedValue: undefined, // Cannot assign undefined to JsonValue
					emptyString: '',
					zero: 0,
					falseValue: false
				}
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.attributes.nullValue).toBeNull()
		expect(parsed.attributes.undefinedValue).toBeUndefined()
		expect(parsed.attributes.emptyString).toBe('')
		expect(parsed.attributes.zero).toBe(0)
		expect(parsed.attributes.falseValue).toBe(false)
	})

	it('should handle empty context gracefully', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'empty context',
			time: 1234567890000,
			context: {}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.level).toBe('info')
		expect(parsed.message).toBe('empty context')
		expect(parsed.time).toBe(1234567890000)
		expect(parsed.context).toBeUndefined()
	})

	it('should handle context without attributes', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'no attributes',
			time: 1234567890000,
			context: {
				namespace: 'test',
				tags: ['tag1']
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.namespace).toBe('test')
		expect(parsed.tags).toEqual(['tag1'])
		expect(parsed.attributes).toBeUndefined()
	})

	it('should handle context without tags', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'no tags',
			time: 1234567890000,
			context: {
				namespace: 'test',
				attributes: {key: 'value'}
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.namespace).toBe('test')
		expect(parsed.attributes).toEqual({key: 'value'})
		expect(parsed.tags).toBeUndefined()
	})

	it('should handle empty tags array', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'empty tags',
			time: 1234567890000,
			context: {
				tags: []
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.tags).toBeUndefined() // Empty arrays should not be included
	})

	it('should handle special characters in strings', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'Special chars: "quotes" \n newline \t tab \\ backslash',
			time: 1234567890000,
			context: {
				attributes: {
					unicode: '🚀 emoji test',
					quotes: 'He said "Hello"',
					newlines: 'Line 1\nLine 2',
					tabs: 'Column1\tColumn2'
				}
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.message).toBe('Special chars: "quotes" \n newline \t tab \\ backslash')
		expect(parsed.attributes.unicode).toBe('🚀 emoji test')
		expect(parsed.attributes.quotes).toBe('He said "Hello"')
		expect(parsed.attributes.newlines).toBe('Line 1\nLine 2')
		expect(parsed.attributes.tabs).toBe('Column1\tColumn2')
	})

	it('should handle circular references gracefully', () => {
		const circular: Record<string, unknown> = {name: 'test'}
		circular.self = circular

		const record: LogRecord = {
			level: 'info',
			message: 'circular test',
			time: 1234567890000,
			context: {
				attributes: {
					data: circular as unknown as JsonValue
				}
			}
		}

		// This should not throw, but may produce a fallback result
		const result = formatJson(record, {mode: 'json'})
		expect(typeof result).toBe('string')
		expect(result).toContain('"level":"info"')
	})

	it('should serialize BigInt values without using the fallback path', () => {
		const mockErrors = {
			report: vi.fn()
		}

		// Create a record that will cause JSON.stringify to fail
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {
				attributes: {
					// Create a value that JSON.stringify can't handle
					bigInt: BigInt(123) as unknown as JsonValue
				}
			}
		}

		const result = formatJson(record, {errors: mockErrors, mode: 'json'})

		const parsed = JSON.parse(result)
		expect(parsed.level).toBe('info')
		expect(parsed.message).toBe('test')
		expect(parsed.time).toBe(1234567890000)
		expect(parsed.attributes.bigInt).toBe('123')

		expect(mockErrors.report).not.toHaveBeenCalled()
	})

	it('keeps direct fallback JSON-safe when record getters throw', () => {
		const record = new Proxy({}, {
			get(_target, property) {
				if (property === 'time' || property === 'level' || property === 'message') {
					throw new Error(`${String(property)} getter failed`)
				}
				return undefined
			}
		}) as unknown as LogRecord

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed).toMatchObject({
			level: '[unavailable]',
			message: '[formatting-error]',
			originalMessage: '[unavailable]',
			time: '[unavailable]'
		})
	})

	it('should serialize BigInt values without an errors handler', () => {
		// Create a record that will cause JSON.stringify to fail
		const record: LogRecord = {
			level: 'error',
			message: 'test error',
			time: 1234567890000,
			context: {
				attributes: {
					// Create a value that JSON.stringify can't handle
					bigInt: BigInt(456) as unknown as JsonValue
				}
			}
		}

		const result = formatJson(record, {mode: 'json'}) // No errors handler

		const parsed = JSON.parse(result)
		expect(parsed.level).toBe('error')
		expect(parsed.message).toBe('test error')
		expect(parsed.time).toBe(1234567890000)
		expect(parsed.attributes.bigInt).toBe('456')
	})

	it('should maintain consistent field order', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'order test',
			time: 1234567890000,
			context: {
				namespace: 'test',
				tags: ['tag1'],
				attributes: {key: 'value'}
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		// Check that fields are sorted alphabetically
		const keys = Object.keys(parsed)
		const sortedKeys = [...keys].sort()
		expect(keys).toEqual(sortedKeys)

		// Verify all expected fields are present
		expect(parsed).toHaveProperty('level')
		expect(parsed).toHaveProperty('message')
		expect(parsed).toHaveProperty('time')
		expect(parsed).toHaveProperty('namespace')
		expect(parsed).toHaveProperty('tags')
		expect(parsed).toHaveProperty('attributes')
	})

	it('should preserve direct JSON formatting with hostile tags', () => {
		const hostileTags = new Proxy(['safe'], {
			get(target, property, receiver) {
				if (property === '0') throw new Error('tag read failed')
				return Reflect.get(target, property, receiver)
			}
		})
		const record: LogRecord = {
			level: 'info',
			message: 'hostile tags',
			time: 1234567890000,
			context: {
				tags: hostileTags
			}
		}

		const parsed = JSON.parse(formatJson(record, {mode: 'json'}))

		expect(parsed.tags).toEqual(['safe'])
		expect(parsed.message).toBe('hostile tags')
	})

	it('should handle very large objects', () => {
		const largeAttributes: Record<string, JsonValue> = {}
		for (let i = 0; i < 1000; i++) {
			largeAttributes[`key${i}`] = `value${i}`
		}

		const record: LogRecord = {
			level: 'info',
			message: 'large object test',
			time: 1234567890000,
			context: {
				attributes: largeAttributes
			}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)

		expect(Object.keys(parsed.attributes)).toHaveLength(1000)
		expect(parsed.attributes.key0).toBe('value0')
		expect(parsed.attributes.key999).toBe('value999')
	})

	it('preserves prototype-named attributes as data without mutating output prototypes', () => {
		const attributes = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}')
		const record: LogRecord = {
			level: 'info', message: 'prototype keys', time: 1,
			context: {attributes}
		}

		const parsed = JSON.parse(formatJson(record, {mode: 'json'}))
		expect(Object.hasOwn(parsed.attributes, '__proto__')).toBe(true)
		expect(parsed.attributes.__proto__).toEqual({polluted: true})
		expect(parsed.attributes.constructor).toBe('value')
		expect(({} as {polluted?: boolean}).polluted).toBeUndefined()
	})

	it('replaces oversized object keys with bounded deterministic placeholders', () => {
		const oversizedKey = 'k'.repeat(50_000)
		const record: LogRecord = {
			level: 'info', message: 'oversized key', time: 1,
			context: {attributes: {[oversizedKey]: 'value'}}
		}

		const result = formatJson(record, {mode: 'json'})
		const parsed = JSON.parse(result)
		expect(parsed.attributes).toEqual({'[TruncatedKey:0]': 'value'})
		expect(result).not.toContain(oversizedKey)
		expect(result.length).toBeLessThan(1_000)
	})

	it('does not overwrite an existing key when a bounded key placeholder collides', () => {
		const oversizedKey = 'k'.repeat(50_000)
		const record: LogRecord = {
			level: 'info', message: 'key collision', time: 1,
			context: {attributes: {
				'[TruncatedKey:1]': 'existing',
				[oversizedKey]: 'oversized'
			}}
		}

		const parsed = JSON.parse(formatJson(record, {mode: 'json'}))
		expect(parsed.attributes).toEqual({
			'[TruncatedKey:1]': 'existing',
			'[DuplicateKey:1:1]': 'oversized'
		})
	})
})
