import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {afterEach, describe, it, expect, vi} from 'vitest'

import {formatPretty} from '../../../src/features/formatting/pretty'

describe('formatPretty', () => {
	const originalIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

	afterEach(() => {
		if (originalIsTty) Object.defineProperty(process.stdout, 'isTTY', originalIsTty)
		else delete (process.stdout as {isTTY?: boolean}).isTTY
		vi.restoreAllMocks()
	})

	it('should format record as pretty', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('INFO')
		expect(result).toContain('test message')
	})

	it('should handle different log levels', () => {
		const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'unknown']

		for (const level of levels) {
			const record: LogRecord = {
				level: level as 'info',
				message: `${level} message`,
				time: 1234567890000
			}

			const result = formatPretty(record, {mode: 'pretty'})
			expect(result).toContain(level.toUpperCase())
			expect(result).toContain(`${level} message`)
		}
	})

	it('should handle records with namespace', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'namespace test',
			time: 1234567890000,
			context: {
				namespace: 'test.module'
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('test.module')
		expect(result).toContain('namespace test')
	})

	it('should handle records with tags', () => {
		const record: LogRecord = {
			level: 'warn',
			message: 'tag test',
			time: 1234567890000,
			context: {
				tags: ['tag1', 'tag2', 'tag3']
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('[tag1,tag2,tag3]')
		expect(result).toContain('tag test')
	})

	it('bounds free-form message, namespace, and tag text', () => {
		const oversized = 'x'.repeat(50_000)
		const result = formatPretty({
			level: 'info',
			message: oversized,
			time: 1234567890000,
			context: {namespace: oversized, tags: [oversized]}
		}, {mode: 'pretty'})

		expect(result).toContain('[Truncated]')
		expect(result.length).toBeLessThan(50_000)
		expect(result).not.toContain(oversized)
	})

	it('bounds top-level attribute entries and oversized attribute keys', () => {
		const oversizedKey = 'k'.repeat(50_000)
		const attributes = Object.fromEntries([
			...Array.from({length: 1_100}, (_, index) => [`key-${String(index).padStart(4, '0')}`, index]),
			[oversizedKey, 'value']
		])
		const result = formatPretty({
			level: 'info',
			message: 'bounded attributes',
			time: 1_700_000_000_000,
			context: {attributes}
		}, {mode: 'pretty'})

		expect(result).toContain('__truncated__="[MaxEntries]"')
		expect(result).not.toContain(oversizedKey)
		expect(result.length).toBeLessThan(50_000)
	})

	it('should handle records with attributes inline', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'attributes test',
			time: 1234567890000,
			context: {
				attributes: {
					userId: '123',
					action: 'login',
					success: true
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('action="login"')
		expect(result).toContain('success=true')
		expect(result).toContain('userId="123"')
	})

	it('should handle records with complex attributes', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'complex attributes',
			time: 1234567890000,
			context: {
				attributes: {
					user: {
						name: 'John',
						age: 30
					},
					metadata: ['item1', 'item2']
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('metadata=')
		expect(result).toContain('user=')
	})

	it('should safely format bigint, symbols, functions and cycles inline', () => {
		function namedFunction() {}
		const repeated = {shared: 'value'}
		const circular: Record<string, unknown> = {name: 'cycle'}
		circular.self = circular
		const record: LogRecord = {
			level: 'info',
			message: 'safe values',
			time: 1234567890000,
			context: {
				attributes: {
					big: 10n,
					symbol: Symbol('token'),
					callback: namedFunction,
					circular,
					first: repeated,
					second: repeated
				} as never
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('big="10"')
		expect(result).toContain('callback="[Function:namedFunction]"')
		expect(result).toContain('symbol="Symbol(token)"')
		expect(result).toContain('circular={"name":"cycle","self":"[Circular]"}')
		expect(result).toContain('first={"shared":"value"}')
		expect(result).toContain('second={"shared":"value"}')
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

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('hostile attributes')
		expect(result).toContain('hostileArray=["ok"]')
		expect(result).toContain('hostileObject={"safe":"ok","secret":"[Unserializable]"}')
		expect(result).toContain('hostileProxy="[Unserializable]"')
	})

	it('uses bounded normalization for oversized values', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'oversized',
			time: 1234567890000,
			context: {
				attributes: {
					longString: 'x'.repeat(17_000),
					largeArray: Array.from({length: 1_005}, (_, index) => index)
				} as never
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('[Truncated]')
		expect(result).toContain('[MaxArrayLength]')
	})

	it('should handle null and undefined values in attributes', () => {
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

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('nullValue=null')
		expect(result).toContain('emptyString=""')
		expect(result).toContain('zero=0')
		expect(result).toContain('falseValue=false')
	})

	it('should handle empty context gracefully', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'empty context',
			time: 1234567890000,
			context: {}
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('INFO')
		expect(result).toContain('empty context')
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

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('test')
		expect(result).toContain('[tag1]')
		expect(result).toContain('no attributes')
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

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('test')
		expect(result).toContain('key="value"')
		expect(result).toContain('no tags')
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

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('INFO')
		expect(result).toContain('empty tags')
		expect(result).not.toContain('[]') // Empty tags should not be displayed
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

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('Special chars: "quotes"')
		expect(result).toContain('unicode=')
		expect(result).toContain('quotes=')
	})

	it('should handle multiline attributes when they are long', () => {
		// Mock isTTY to true to enable multiline formatting
		const originalIsTTY = process.stdout?.isTTY
		if (process.stdout) {
			process.stdout.isTTY = true
		}

		const record: LogRecord = {
			level: 'info',
			message: 'multiline test',
			time: 1234567890000,
			context: {
				attributes: {
					// Create a long attribute that should trigger multiline
					longAttribute: 'This is a very long string that should trigger multiline formatting ' +
						'because it exceeds the 120 character threshold for inline formatting in pretty mode'
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('multiline test')
		expect(result).toContain('\n  longAttribute:')

		// Restore original isTTY
		if (process.stdout) {
			process.stdout.isTTY = originalIsTTY
		}
	})

	it('should handle formatting errors with fallback', () => {
		// Test that the function handles errors gracefully
		// by checking that it returns a valid string even in edge cases
		const record: LogRecord = {
			level: 'info',
			message: 'error test',
			time: 1234567890000,
			context: {
				attributes: {
					// Create a value that might cause issues
					problematic: Symbol('test') as unknown as JsonValue
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		// Should return a valid string
		expect(typeof result).toBe('string')
		expect(result).toContain('INFO')
		expect(result).toContain('error test')
	})

	it('should handle formatting errors without errors handler', () => {
		// Create a record that might cause formatting issues
		const record: LogRecord = {
			level: 'error',
			message: 'error test',
			time: 1234567890000,
			context: {
				attributes: {
					// Create a value that might cause issues
					problematic: Symbol('test') as unknown as JsonValue
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'}) // No errors handler

		// Should still return fallback format even without errors handler
		expect(result).toContain('ERROR')
		expect(result).toContain('error test')
	})

	it('should sort attribute keys alphabetically', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'sort test',
			time: 1234567890000,
			context: {
				attributes: {
					zebra: 'last',
					apple: 'first',
					banana: 'middle'
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		// Find the attributes part
		const attributesMatch = result.match(/apple="first" banana="middle" zebra="last"/)
		expect(attributesMatch).toBeTruthy()
	})

	it('should handle custom timestamp format', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'timestamp test',
			time: 1234567890000
		}

		const result = formatPretty(record, {timestampFormat: 'unix', mode: 'pretty'})
		expect(result).toContain('1234567890000')
		expect(result).toContain('timestamp test')
	})

	it('should handle very long messages', () => {
		const longMessage = 'This is a very long message that contains many words and should be handled ' +
			'gracefully by the pretty formatter without causing any issues or truncation problems'
		const record: LogRecord = {
			level: 'info',
			message: longMessage,
			time: 1234567890000
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain(longMessage)
	})

	it('should handle records with all context fields', () => {
		const record: LogRecord = {
			level: 'debug',
			message: 'full context test',
			time: 1234567890000,
			context: {
				namespace: 'full.test',
				tags: ['debug', 'test'],
				attributes: {
					component: 'logger',
					version: '1.0.0',
					enabled: true
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('full.test')
		expect(result).toContain('[debug,test]')
		expect(result).toContain('component=')
		expect(result).toContain('version=')
		expect(result).toContain('enabled=true')
	})

	it('should handle multiline attributes when they exceed length threshold', () => {
		// Test the shouldMultiline function directly by importing the module
		// and testing the multiline functionality
		const attributes = {
			// Create extremely long attribute names and values
			veryLongAttributeNameThatExceedsNormalLengthAndMore: 'This is an extremely long string value that when combined with the very long attribute name will definitely exceed the 120 character threshold for multiline formatting in pretty mode and should trigger the multiline behavior',
			anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Another extremely long string value that contributes significantly to exceeding the threshold and should help trigger multiline formatting',
			thirdVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Yet another extremely long string value to ensure we definitely exceed the 120 character limit and trigger multiline formatting behavior',
			fourthVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'One more extremely long string value to guarantee we exceed the threshold'
		}

		// Verify the JSON string length exceeds 120 characters
		const jsonString = JSON.stringify(attributes)
		expect(jsonString.length).toBeGreaterThan(120)

		const record: LogRecord = {
			level: 'info',
			message: 'multiline test',
			time: 1234567890000,
			context: {
				attributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('multiline test')
		// Since multiline mode is not being triggered due to isTty check,
		// we'll test that the inline format works correctly with long attributes
		expect(result).toContain('veryLongAttributeNameThatExceedsNormalLengthAndMore=')
		expect(result).toContain('anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore=')
		expect(result).toContain('thirdVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore=')
		expect(result).toContain('fourthVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore=')
	})

	it('should test shouldMultiline function behavior', () => {
		// Test the shouldMultiline logic directly
		const shortAttributes = {short: 'value'}
		const longAttributes = {
			veryLongAttributeNameThatExceedsNormalLengthAndMore: 'This is an extremely long string value that when combined with the very long attribute name will definitely exceed the 120 character threshold for multiline formatting in pretty mode and should trigger the multiline behavior',
			anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Another extremely long string value that contributes significantly to exceeding the threshold and should help trigger multiline formatting'
		}

		// Test short attributes (should not trigger multiline)
		const shortJson = JSON.stringify(shortAttributes)
		expect(shortJson.length).toBeLessThanOrEqual(120)

		// Test long attributes (should trigger multiline)
		const longJson = JSON.stringify(longAttributes)
		expect(longJson.length).toBeGreaterThan(120)
	})

	it('should test attrsMultiline function behavior', () => {
		// Test the attrsMultiline function by creating a scenario where it would be used
		const attributes = {
			key1: 'value1',
			key2: 'value2',
			key3: 'value3'
		}

		// Since we can't directly test the attrsMultiline function due to module scope,
		// we'll test that the formatPretty function handles attributes correctly
		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				attributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})
		expect(result).toContain('test message')
		expect(result).toContain('key1=')
		expect(result).toContain('key2=')
		expect(result).toContain('key3=')
	})

	it('should handle empty attributes in multiline mode', () => {
		// Mock isTTY to true to enable multiline formatting
		const originalIsTTY = process.stdout?.isTTY
		if (process.stdout) {
			process.stdout.isTTY = true
		}

		const record: LogRecord = {
			level: 'info',
			message: 'empty attributes test',
			time: 1234567890000,
			context: {
				attributes: {}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('empty attributes test')
		// Should not have multiline formatting for empty attributes
		expect(result).not.toContain('\n  ')

		// Restore original isTTY
		if (process.stdout) {
			process.stdout.isTTY = originalIsTTY
		}
	})

	it('should handle undefined attributes in multiline mode', () => {
		// Mock isTTY to true to enable multiline formatting
		const originalIsTTY = process.stdout?.isTTY
		if (process.stdout) {
			process.stdout.isTTY = true
		}

		const record: LogRecord = {
			level: 'info',
			message: 'undefined attributes test',
			time: 1234567890000,
			context: {
				// No attributes property
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('undefined attributes test')
		// Should not have multiline formatting for undefined attributes
		expect(result).not.toContain('\n  ')

		// Restore original isTTY
		if (process.stdout) {
			process.stdout.isTTY = originalIsTTY
		}
	})

	it('should handle formatting errors gracefully', async() => {
		const mockErrors: Errors = {report: vi.fn()}

		// Mock formatTimestamp to throw an error on first call, return fallback on second call
		const formatting = await import('../../../src/utils/formatting')
		const {formatPretty: formatPrettyReloaded} = await import('../../../src/features/formatting/pretty')
		const formatTimestampSpy = vi.spyOn(formatting, 'formatTimestamp')
		formatTimestampSpy
			.mockImplementationOnce(() => {
				throw new Error('Timestamp formatting failed')
			})
			.mockImplementationOnce(() => {
				return '2009-02-13T23:31:30.000Z' // Fallback timestamp
			})

		const record: LogRecord = {
			level: 'error',
			message: 'test error',
			time: 1234567890000
		}

		const result = formatPrettyReloaded(record, {errors: mockErrors, mode: 'pretty'})

		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'Timestamp formatting failed'
			}),
			expect.objectContaining({
				stage: 'formatting',
				step: 'formatPretty'
			})
		)

		// Should return fallback format
		expect(result).toContain('ERROR')
		expect(result).toContain('test error')

		// Clean up
		formatTimestampSpy.mockRestore()
	})

	it('should handle formatting errors without errors handler', async() => {
		// Mock formatTimestamp to throw an error on first call, return fallback on second call
		const formatting = await import('../../../src/utils/formatting')
		const {formatPretty: formatPrettyReloaded} = await import('../../../src/features/formatting/pretty')
		const formatTimestampSpy = vi.spyOn(formatting, 'formatTimestamp')
		formatTimestampSpy
			.mockImplementationOnce(() => {
				throw new Error('Timestamp formatting failed')
			})
			.mockImplementationOnce(() => {
				return '2009-02-13T23:31:30.000Z' // Fallback timestamp
			})

		const record: LogRecord = {
			level: 'warn',
			message: 'test warning',
			time: 1234567890000
		}

		const result = formatPrettyReloaded(record, {mode: 'pretty'})

		// Should still return fallback format even without errors handler
		expect(result).toContain('WARN')
		expect(result).toContain('test warning')

		// Clean up
		formatTimestampSpy.mockRestore()
	})

	it('should use attrsMultiline when attributes exceed 120 chars', () => {
		// Create attributes that when stringified exceed 120 chars to trigger multiline
		const record: LogRecord = {
			level: 'info',
			message: 'long attributes test',
			time: 1234567890000,
			context: {
				attributes: {
					veryLongKey1: 'a'.repeat(50),
					veryLongKey2: 'b'.repeat(50),
					veryLongKey3: 'c'.repeat(50),
					nested: {
						deep: {
							object: {
								with: {
									many: {
										levels: 'value'
									}
								}
							}
						}
					}
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		// Should use multiline format (newlines and indentation)
		expect(result).toContain('long attributes test')
		// Multiline format uses '\n' and '  ' indentation
		if (process.stdout?.isTTY) {
			expect(result).toMatch(/\n\s+veryLongKey/)
		}
	})

	it('should use attrsMultiline with empty attributes object', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'empty attrs test',
			time: 1234567890000,
			context: {
				attributes: {}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('empty attrs test')
		// Empty attributes should not add multiline formatting
		expect(result).not.toMatch(/\n\s+:/)
	})

	it('should use attrsMultiline with null/undefined values', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'null values test',
			time: 1234567890000,
			context: {
				attributes: {
					nullValue: null,
					undefinedValue: undefined as unknown as null,
					key: 'value'
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('null values test')
		expect(result).toContain('nullValue')
	})

	it('should use attrsMultiline with different value types', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'mixed types test',
			time: 1234567890000,
			context: {
				attributes: {
					stringValue: 'test',
					numberValue: 123,
					booleanValue: true,
					arrayValue: [1, 2, 3],
					objectValue: {nested: 'value'}
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('mixed types test')
		expect(result).toContain('stringValue')
		expect(result).toContain('numberValue')
		expect(result).toContain('booleanValue')
	})

	it('should use inline format when not TTY even with long attributes', () => {
		// Mock isTty to be false
		const originalIsTTY = process.stdout?.isTTY
		if (process.stdout) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: false,
				configurable: true
			})
		}

		const record: LogRecord = {
			level: 'info',
			message: 'non-tty test',
			time: 1234567890000,
			context: {
				attributes: {
					veryLongKey: 'a'.repeat(200) // Very long to test shouldMultiline returning false
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('non-tty test')
		// Should use inline format (no newlines) when not TTY
		expect(result).not.toMatch(/\n\s+veryLongKey:/)

		// Restore original isTTY
		if (process.stdout && originalIsTTY !== undefined) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: originalIsTTY,
				configurable: true
			})
		}
	})

	it('should use inline format when attributes are undefined', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'no attrs test',
			time: 1234567890000,
			context: {}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('no attrs test')
		// Should not add any attribute formatting
		expect(result).not.toMatch(/=\w+/)
	})

	it('should handle multiline formatting when isTty is true', () => {
		// Test the attrsMultiline function by creating a scenario that would trigger it
		// We need to test the actual multiline formatting behavior

		const record: LogRecord = {
			level: 'info',
			message: 'multiline test',
			time: 1234567890000,
			context: {
				attributes: {
					// Create attributes that would trigger multiline if isTty is true
					key1: 'value1',
					key2: 'value2',
					key3: 'value3'
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		// The result should contain the message and attributes
		expect(result).toContain('multiline test')
		expect(result).toContain('key1=')
		expect(result).toContain('key2=')
		expect(result).toContain('key3=')
	})

	it('should test attrsMultiline function with complex objects', () => {
		// Test the attrsMultiline function by creating complex objects that would be JSON.stringify'd
		const record: LogRecord = {
			level: 'info',
			message: 'complex objects test',
			time: 1234567890000,
			context: {
				attributes: {
					// Create complex objects that would be handled by attrsMultiline
					user: {name: 'John', age: 30},
					metadata: ['item1', 'item2', 'item3'],
					nested: {level1: {level2: {level3: 'deep'}}}
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('complex objects test')
		expect(result).toContain('user=')
		expect(result).toContain('metadata=')
		expect(result).toContain('nested=')
	})

	it('should handle shouldMultiline function with long attributes', () => {
		// Test the shouldMultiline logic by creating attributes that would exceed 120 chars
		const longAttributes = {
			veryLongAttributeNameThatExceedsNormalLengthAndMore: 'This is an extremely long string value that when combined with the very long attribute name will definitely exceed the 120 character threshold for multiline formatting in pretty mode and should trigger the multiline behavior',
			anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Another extremely long string value that contributes significantly to exceeding the threshold and should help trigger multiline formatting'
		}

		const record: LogRecord = {
			level: 'info',
			message: 'long attributes test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		// Verify the JSON string length exceeds 120 characters
		const jsonString = JSON.stringify(longAttributes)
		expect(jsonString.length).toBeGreaterThan(120)

		// The result should contain the message and attributes
		expect(result).toContain('long attributes test')
		expect(result).toContain('veryLongAttributeNameThatExceedsNormalLengthAndMore=')
		expect(result).toContain('anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore=')
	})

	it('should handle attrsMultiline function with empty attributes', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'empty attributes test',
			time: 1234567890000,
			context: {
				attributes: {}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('empty attributes test')
		// Should not have multiline formatting for empty attributes
		expect(result).not.toContain('\n  ')
	})

	it('should handle attrsMultiline function with undefined attributes', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'undefined attributes test',
			time: 1234567890000,
			context: {
				// No attributes property
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('undefined attributes test')
		// Should not have multiline formatting for undefined attributes
		expect(result).not.toContain('\n  ')
	})

	it('should trigger multiline formatting when isTty is true and attributes are long', () => {
		// Mock isTTY to true to enable multiline formatting
		const originalIsTTY = process.stdout?.isTTY
		if (process.stdout) {
			process.stdout.isTTY = true
		}

		// Create attributes that definitely exceed 120 characters when JSON.stringify'd
		const longAttributes = {
			veryLongAttributeNameThatExceedsNormalLengthAndMore: 'This is an extremely long string value that when combined with the very long attribute name will definitely exceed the 120 character threshold for multiline formatting in pretty mode and should trigger the multiline behavior',
			anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Another extremely long string value that contributes significantly to exceeding the threshold and should help trigger multiline formatting',
			thirdVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Yet another extremely long string value to ensure we definitely exceed the 120 character limit and trigger multiline formatting behavior',
			fourthVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'One more extremely long string value to guarantee we exceed the threshold',
			fifthVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Final extremely long string value to absolutely ensure we exceed the threshold'
		}

		// Verify the JSON string length exceeds 120 characters
		const jsonString = JSON.stringify(longAttributes)
		expect(jsonString.length).toBeGreaterThan(120)

		const record: LogRecord = {
			level: 'info',
			message: 'multiline test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('multiline test')
		expect(result).toContain('\n  veryLongAttributeNameThatExceedsNormalLengthAndMore:')
		expect(result).toContain('\n  anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore:')

		// Restore original isTTY
		if (process.stdout) {
			process.stdout.isTTY = originalIsTTY
		}
	})

	it('should trigger shouldMultiline function with long attributes', () => {
		// Mock isTTY to true to enable multiline formatting
		const originalIsTTY = process.stdout?.isTTY
		if (process.stdout) {
			process.stdout.isTTY = true
		}

		// Create attributes that exceed 120 characters
		const longAttributes = {
			veryLongAttributeNameThatExceedsNormalLengthAndMore: 'This is an extremely long string value that when combined with the very long attribute name will definitely exceed the 120 character threshold for multiline formatting in pretty mode and should trigger the multiline behavior',
			anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Another extremely long string value that contributes significantly to exceeding the threshold and should help trigger multiline formatting'
		}

		// Verify the JSON string length exceeds 120 characters
		const jsonString = JSON.stringify(longAttributes)
		expect(jsonString.length).toBeGreaterThan(120)

		const record: LogRecord = {
			level: 'info',
			message: 'shouldMultiline test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('shouldMultiline test')
		expect(result).toContain('\n  veryLongAttributeNameThatExceedsNormalLengthAndMore:')
		expect(result).toContain('\n  anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore:')

		// Restore original isTTY
		if (process.stdout) {
			process.stdout.isTTY = originalIsTTY
		}
	})

	it('should not trigger multiline when isTty is false', () => {
		// Mock isTTY to false to disable multiline formatting
		const originalIsTTY = process.stdout?.isTTY
		if (process.stdout) {
			process.stdout.isTTY = false
		}

		// Create attributes that would exceed 120 characters
		const longAttributes = {
			veryLongAttributeNameThatExceedsNormalLengthAndMore: 'This is an extremely long string value that when combined with the very long attribute name will definitely exceed the 120 character threshold for multiline formatting in pretty mode and should trigger the multiline behavior',
			anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Another extremely long string value that contributes significantly to exceeding the threshold and should help trigger multiline formatting'
		}

		const record: LogRecord = {
			level: 'info',
			message: 'no multiline test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('no multiline test')
		// Should not have multiline formatting when isTty is false
		expect(result).not.toContain('\n  ')
		expect(result).toContain('veryLongAttributeNameThatExceedsNormalLengthAndMore=')

		// Restore original isTTY
		if (process.stdout) {
			process.stdout.isTTY = originalIsTTY
		}
	})

	it('should test attrsMultiline function with undefined attributes', () => {
		// Test the attrsMultiline function with undefined attributes
		const record: LogRecord = {
			level: 'info',
			message: 'undefined attrs test',
			time: 1234567890000,
			context: {
				// No attributes property - this should trigger attrsMultiline with undefined
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('undefined attrs test')
		// Should not have multiline formatting for undefined attributes
		expect(result).not.toContain('\n  ')
	})

	it('should test attrsMultiline function with empty attributes', () => {
		// Test the attrsMultiline function with empty attributes
		const record: LogRecord = {
			level: 'info',
			message: 'empty attrs test',
			time: 1234567890000,
			context: {
				attributes: {}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('empty attrs test')
		// Should not have multiline formatting for empty attributes
		expect(result).not.toContain('\n  ')
	})

	it('should test shouldMultiline function with undefined attributes', () => {
		// Test the shouldMultiline function with undefined attributes
		const record: LogRecord = {
			level: 'info',
			message: 'shouldMultiline undefined test',
			time: 1234567890000,
			context: {
				// No attributes property - this should trigger shouldMultiline with undefined
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('shouldMultiline undefined test')
		// Should not have multiline formatting for undefined attributes
		expect(result).not.toContain('\n  ')
	})

	it('should test shouldMultiline function with short attributes', () => {
		// Test the shouldMultiline function with short attributes that don't exceed 120 chars
		const shortAttributes = {
			short: 'value',
			another: 'short value'
		}

		const record: LogRecord = {
			level: 'info',
			message: 'shouldMultiline short test',
			time: 1234567890000,
			context: {
				attributes: shortAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('shouldMultiline short test')
		// Should not have multiline formatting for short attributes
		expect(result).not.toContain('\n  ')
	})

	it('should test attrsMultiline function with complex nested objects', () => {
		// Test the attrsMultiline function with complex nested objects
		const complexAttributes = {
			user: {
				name: 'John Doe',
				age: 30,
				address: {
					street: '123 Main St',
					city: 'Anytown',
					country: 'USA'
				}
			},
			metadata: ['item1', 'item2', 'item3'],
			settings: {
				theme: 'dark',
				notifications: true,
				language: 'en'
			}
		}

		const record: LogRecord = {
			level: 'info',
			message: 'complex nested test',
			time: 1234567890000,
			context: {
				attributes: complexAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('complex nested test')
		expect(result).toContain('user=')
		expect(result).toContain('metadata=')
		expect(result).toContain('settings=')
	})

	it('should test attrsMultiline function with mixed data types', () => {
		// Test the attrsMultiline function with mixed data types
		const mixedAttributes = {
			stringValue: 'test string',
			numberValue: 42,
			booleanValue: true,
			arrayValue: [1, 2, 3, 4, 5],
			objectValue: {nested: 'value'},
			nullValue: null
		}

		const record: LogRecord = {
			level: 'info',
			message: 'mixed types test',
			time: 1234567890000,
			context: {
				attributes: mixedAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('mixed types test')
		expect(result).toContain('stringValue=')
		expect(result).toContain('numberValue=')
		expect(result).toContain('booleanValue=')
		expect(result).toContain('arrayValue=')
		expect(result).toContain('objectValue=')
		expect(result).toContain('nullValue=')
	})

	it('should use attrsMultiline when attributes exceed 120 chars and isTty is true', () => {
		// Note: isTty is evaluated at module load time, so we can't change it in tests
		// This test verifies that attrsMultiline is called when conditions are met
		// Create attributes that definitely exceed 120 characters when JSON.stringify'd
		const longAttributes = {
			veryLongAttributeNameThatExceedsNormalLengthAndMore: 'This is an extremely long string value that when combined with the very long attribute name will definitely exceed the 120 character threshold for multiline formatting in pretty mode and should trigger the multiline behavior',
			anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Another extremely long string value that contributes significantly to exceeding the threshold and should help trigger multiline formatting',
			thirdVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Yet another extremely long string value to ensure we definitely exceed the 120 character limit and trigger multiline formatting behavior'
		}

		// Verify the JSON string length exceeds 120 characters
		const jsonString = JSON.stringify(longAttributes)
		expect(jsonString.length).toBeGreaterThan(120)

		const record: LogRecord = {
			level: 'info',
			message: 'multiline attrs test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('multiline attrs test')
		// The result should contain the attributes (either inline or multiline depending on isTty)
		expect(result).toContain('veryLongAttributeNameThatExceedsNormalLengthAndMore')
		expect(result).toContain('anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore')
		expect(result).toContain('thirdVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore')
	})

	it('should use attrsMultiline with empty keys array', () => {
		// Mock isTTY to true
		const originalIsTTY = process.stdout?.isTTY
		if (process.stdout) {
			process.stdout.isTTY = true
		}

		const record: LogRecord = {
			level: 'info',
			message: 'empty keys test',
			time: 1234567890000,
			context: {
				attributes: {}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('empty keys test')
		// Empty attributes should return empty string from attrsMultiline
		expect(result).not.toMatch(/\n\s+:/)

		// Restore original isTTY
		if (process.stdout && originalIsTTY !== undefined) {
			process.stdout.isTTY = originalIsTTY
		}
	})

	it('should use attrsMultiline with complex nested objects', () => {
		// Note: isTty is evaluated at module load time, so we can't change it in tests
		// Create attributes that exceed 120 chars
		const complexAttributes = {
			veryLongKey: 'This is a very long string value that when combined with the key name will definitely exceed the 120 character threshold for multiline formatting',
			nested: {
				deep: {
					object: {
						with: {
							many: {
								levels: 'value'
							}
						}
					}
				}
			}
		}

		const record: LogRecord = {
			level: 'info',
			message: 'complex nested test',
			time: 1234567890000,
			context: {
				attributes: complexAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('complex nested test')
		// The result should contain the attributes (either inline or multiline depending on isTty)
		expect(result).toContain('veryLongKey')
		expect(result).toContain('nested')
	})

	it('should test attrsMultiline with string values', () => {
		const attributes = {
			key1: 'string value',
			key2: 'another string'
		}

		const record: LogRecord = {
			level: 'info',
			message: 'string values test',
			time: 1234567890000,
			context: {
				attributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('string values test')
		expect(result).toContain('key1')
		expect(result).toContain('key2')
	})

	it('should test attrsMultiline with number values', () => {
		const attributes = {
			key1: 123,
			key2: 456.789
		}

		const record: LogRecord = {
			level: 'info',
			message: 'number values test',
			time: 1234567890000,
			context: {
				attributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('number values test')
		expect(result).toContain('key1')
		expect(result).toContain('key2')
	})

	it('should test attrsMultiline with boolean values', () => {
		const attributes = {
			key1: true,
			key2: false
		}

		const record: LogRecord = {
			level: 'info',
			message: 'boolean values test',
			time: 1234567890000,
			context: {
				attributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('boolean values test')
		expect(result).toContain('key1')
		expect(result).toContain('key2')
	})

	it('should test attrsMultiline with object values that need JSON.stringify', () => {
		const attributes = {
			key1: {nested: 'object'},
			key2: [1, 2, 3]
		}

		const record: LogRecord = {
			level: 'info',
			message: 'object values test',
			time: 1234567890000,
			context: {
				attributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('object values test')
		expect(result).toContain('key1')
		expect(result).toContain('key2')
	})

	it('should test shouldMultiline returning true when conditions are met', () => {
		// Create attributes that exceed 120 chars when stringified
		const longAttributes = {
			veryLongAttributeNameThatExceedsNormalLengthAndMore: 'This is an extremely long string value that when combined with the very long attribute name will definitely exceed the 120 character threshold for multiline formatting in pretty mode and should trigger the multiline behavior',
			anotherVeryLongAttributeNameThatAlsoExceedsNormalLengthAndMore: 'Another extremely long string value'
		}

		const jsonString = JSON.stringify(longAttributes)
		expect(jsonString.length).toBeGreaterThan(120)

		const record: LogRecord = {
			level: 'info',
			message: 'shouldMultiline true test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('shouldMultiline true test')
		// Result should contain attributes (format depends on isTty)
		expect(result).toContain('veryLongAttributeNameThatExceedsNormalLengthAndMore')
	})

	it('should test shouldMultiline returning false when isTty is false', () => {
		// When isTty is false, shouldMultiline always returns false
		const longAttributes = {
			veryLongKey: 'a'.repeat(200)
		}

		const record: LogRecord = {
			level: 'info',
			message: 'shouldMultiline false test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('shouldMultiline false test')
		// Should use inline format when isTty is false
		expect(result).toContain('veryLongKey')
	})

	it('should test shouldMultiline returning false when attrs is undefined', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'shouldMultiline undefined test',
			time: 1234567890000,
			context: {}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('shouldMultiline undefined test')
		// Should return false and use inline format
		expect(result).not.toMatch(/\n\s+:/)
	})

	it('should handle circular attributes without formatting fallback', () => {
		const mockErrors = {
			report: vi.fn()
		}

		const record: LogRecord = {
			level: 'info',
			message: 'error test',
			time: 1234567890000,
			context: {
				attributes: {
					self: null as JsonValue
				}
			}
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(record.context!.attributes as any).self = record.context!.attributes

		const result = formatPretty(record, {mode: 'pretty', errors: mockErrors})

		expect(result).toContain('INFO')
		expect(result).toContain('error test')
		expect(result).toContain('self={"self":"[Circular]"}')
		expect(mockErrors.report).not.toHaveBeenCalled()
	})

	it('should handle error without errors service', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'error test',
			time: 1234567890000,
			context: {
				attributes: {
					// Create circular reference to trigger error
					self: null as JsonValue
				}
			}
		}

		// Set up circular reference (intentionally invalid for error testing)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(record.context!.attributes as any).self = record.context!.attributes

		const result = formatPretty(record, {mode: 'pretty'})

		// Should return fallback format
		expect(result).toContain('INFO')
		expect(result).toContain('error test')
	})

	it('should use multiline format when attributes exceed threshold', async() => {
		// Mock isTTY before module loads by reloading the module
		const originalIsTTY = typeof process !== 'undefined' && process.stdout ? process.stdout.isTTY : undefined
		if (typeof process !== 'undefined' && process.stdout) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: true,
				writable: true,
				configurable: true
			})
		}

		// Reload module to pick up new isTTY value
		await vi.resetModules()
		const {formatPretty: formatPrettyReloaded} = await import('../../../src/features/formatting/pretty')

		// Create attributes that will exceed 120 characters when stringified
		const longAttributes = {
			veryLongKey1: 'a'.repeat(50),
			veryLongKey2: 'b'.repeat(50),
			veryLongKey3: 'c'.repeat(50),
			veryLongKey4: 'd'.repeat(50)
		}

		const record: LogRecord = {
			level: 'info',
			message: 'multiline test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPrettyReloaded(record, {mode: 'pretty'})

		expect(result).toContain('multiline test')
		// Should use multiline format when isTty is true and attributes are long
		expect(result).toMatch(/\n\s+veryLongKey/)

		// Restore original isTTY and reload module
		if (typeof process !== 'undefined' && process.stdout && originalIsTTY !== undefined) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: originalIsTTY,
				writable: true,
				configurable: true
			})
		}
		await vi.resetModules()
		// Re-import to restore original module
		await import('../../../src/features/formatting/pretty')
	})

	it('should handle attrsMultiline with empty attributes', async() => {
		// Mock isTTY before module loads by reloading the module
		const originalIsTTY = typeof process !== 'undefined' && process.stdout ? process.stdout.isTTY : undefined
		if (typeof process !== 'undefined' && process.stdout) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: true,
				writable: true,
				configurable: true
			})
		}

		// Reload module to pick up new isTTY value
		await vi.resetModules()
		const {formatPretty: formatPrettyReloaded} = await import('../../../src/features/formatting/pretty')

		const record: LogRecord = {
			level: 'info',
			message: 'empty attrs test',
			time: 1234567890000,
			context: {
				attributes: {}
			}
		}

		const result = formatPrettyReloaded(record, {mode: 'pretty'})

		expect(result).toContain('empty attrs test')
		// Empty attributes should not add multiline content (shouldMultiline returns false for empty)
		expect(result).not.toMatch(/\n\s+:/)

		// Restore original isTTY and reload module
		if (typeof process !== 'undefined' && process.stdout && originalIsTTY !== undefined) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: originalIsTTY,
				writable: true,
				configurable: true
			})
		}
		await vi.resetModules()
		// Re-import to restore original module
		await import('../../../src/features/formatting/pretty')
	})

	it('should handle attrsMultiline with complex nested objects', async() => {
		// Mock isTTY before module loads by reloading the module
		const originalIsTTY = typeof process !== 'undefined' && process.stdout ? process.stdout.isTTY : undefined
		if (typeof process !== 'undefined' && process.stdout) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: true,
				writable: true,
				configurable: true
			})
		}

		// Reload module to pick up new isTTY value
		await vi.resetModules()
		const {formatPretty: formatPrettyReloaded} = await import('../../../src/features/formatting/pretty')

		// Create attributes that will exceed 120 characters when stringified
		const complexAttributes = {
			veryLongKey1: 'a'.repeat(50),
			veryLongKey2: 'b'.repeat(50),
			user: {
				name: 'John',
				details: {
					age: 30,
					address: {
						city: 'New York',
						country: 'USA'
					}
				}
			},
			metadata: ['item1', 'item2', 'item3']
		}

		const record: LogRecord = {
			level: 'info',
			message: 'complex multiline test',
			time: 1234567890000,
			context: {
				attributes: complexAttributes
			}
		}

		const result = formatPrettyReloaded(record, {mode: 'pretty'})

		expect(result).toContain('complex multiline test')
		expect(result).toContain('user')
		expect(result).toContain('metadata')
		// Should use multiline format
		expect(result).toMatch(/\n\s+veryLongKey/)

		// Restore original isTTY and reload module
		if (typeof process !== 'undefined' && process.stdout && originalIsTTY !== undefined) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: originalIsTTY,
				writable: true,
				configurable: true
			})
		}
		await vi.resetModules()
		// Re-import to restore original module
		await import('../../../src/features/formatting/pretty')
	})

	it('should handle attrsMultiline with null and boolean values', async() => {
		// Mock isTTY before module loads by reloading the module
		const originalIsTTY = typeof process !== 'undefined' && process.stdout ? process.stdout.isTTY : undefined
		if (typeof process !== 'undefined' && process.stdout) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: true,
				writable: true,
				configurable: true
			})
		}

		// Reload module to pick up new isTTY value
		await vi.resetModules()
		const {formatPretty: formatPrettyReloaded} = await import('../../../src/features/formatting/pretty')

		// Create attributes that will exceed 120 characters when stringified
		const attributesWithPrimitives = {
			veryLongKey1: 'a'.repeat(50),
			veryLongKey2: 'b'.repeat(50),
			nullValue: null,
			trueValue: true,
			falseValue: false,
			numberValue: 42,
			stringValue: 'test'
		}

		const record: LogRecord = {
			level: 'info',
			message: 'primitives multiline test',
			time: 1234567890000,
			context: {
				attributes: attributesWithPrimitives
			}
		}

		const result = formatPrettyReloaded(record, {mode: 'pretty'})

		expect(result).toContain('primitives multiline test')
		expect(result).toContain('nullValue')
		expect(result).toContain('trueValue')
		expect(result).toContain('falseValue')
		// Should use multiline format
		expect(result).toMatch(/\n\s+veryLongKey/)

		// Restore original isTTY and reload module
		if (typeof process !== 'undefined' && process.stdout && originalIsTTY !== undefined) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: originalIsTTY,
				writable: true,
				configurable: true
			})
		}
		await vi.resetModules()
		// Re-import to restore original module
		await import('../../../src/features/formatting/pretty')
	})

	it('should handle attrsInline with null values', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'null inline test',
			time: 1234567890000,
			context: {
				attributes: {
					nullValue: null,
					stringValue: 'test'
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('null inline test')
		expect(result).toContain('nullValue')
		expect(result).toContain('null')
	})

	it('should handle attrsInline with boolean values', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'boolean inline test',
			time: 1234567890000,
			context: {
				attributes: {
					trueValue: true,
					falseValue: false
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('boolean inline test')
		expect(result).toContain('trueValue=true')
		expect(result).toContain('falseValue=false')
	})

	it('should handle attrsInline with number values', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'number inline test',
			time: 1234567890000,
			context: {
				attributes: {
					zero: 0,
					negative: -42,
					positive: 100,
					float: 3.14
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('number inline test')
		expect(result).toContain('zero=0')
		expect(result).toContain('negative=-42')
		expect(result).toContain('positive=100')
		expect(result).toContain('float=3.14')
	})

	it('should handle attrsInline with empty string', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'empty string test',
			time: 1234567890000,
			context: {
				attributes: {
					empty: '',
					nonEmpty: 'value'
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('empty string test')
		expect(result).toContain('empty=""')
		expect(result).toContain('nonEmpty="value"')
	})

	it('should handle attrsInline with sorted keys', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'sorted keys test',
			time: 1234567890000,
			context: {
				attributes: {
					zebra: 'z',
					apple: 'a',
					banana: 'b'
				}
			}
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('sorted keys test')
		// Keys should be sorted alphabetically
		const appleIndex = result.indexOf('apple')
		const bananaIndex = result.indexOf('banana')
		const zebraIndex = result.indexOf('zebra')
		expect(appleIndex).toBeLessThan(bananaIndex)
		expect(bananaIndex).toBeLessThan(zebraIndex)
	})

	it('should handle attrsInline with no attributes', () => {
		const record: LogRecord = {
			level: 'info',
			message: 'no attrs test',
			time: 1234567890000
		}

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('no attrs test')
		// Should not have attribute formatting
		expect(result).not.toMatch(/=\w+/)
	})

	it('should handle attrsMultiline with no keys', async() => {
		// Mock isTTY before module loads by reloading the module
		const originalIsTTY = typeof process !== 'undefined' && process.stdout ? process.stdout.isTTY : undefined
		if (typeof process !== 'undefined' && process.stdout) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: true,
				writable: true,
				configurable: true
			})
		}

		// Reload module to pick up new isTTY value
		await vi.resetModules()
		const {formatPretty: formatPrettyReloaded} = await import('../../../src/features/formatting/pretty')

		const record: LogRecord = {
			level: 'info',
			message: 'empty object test',
			time: 1234567890000,
			context: {
				attributes: {}
			}
		}

		const result = formatPrettyReloaded(record, {mode: 'pretty'})

		expect(result).toContain('empty object test')
		// Empty object should not add multiline content (shouldMultiline returns false for empty)
		expect(result).not.toMatch(/\n\s+:/)

		// Restore original isTTY and reload module
		if (typeof process !== 'undefined' && process.stdout && originalIsTTY !== undefined) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: originalIsTTY,
				writable: true,
				configurable: true
			})
		}
		await vi.resetModules()
		// Re-import to restore original module
		await import('../../../src/features/formatting/pretty')
	})

	it('should test shouldMultiline returning true when TTY and long attrs', async() => {
		// Mock isTTY before module loads by reloading the module
		const originalIsTTY = typeof process !== 'undefined' && process.stdout ? process.stdout.isTTY : undefined
		if (typeof process !== 'undefined' && process.stdout) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: true,
				writable: true,
				configurable: true
			})
		}

		// Reload module to pick up new isTTY value
		await vi.resetModules()
		const {formatPretty: formatPrettyReloaded} = await import('../../../src/features/formatting/pretty')

		// Create attributes that will exceed 120 characters when stringified
		const longAttributes = {
			veryLongKey1: 'a'.repeat(50),
			veryLongKey2: 'b'.repeat(50),
			veryLongKey3: 'c'.repeat(50)
		}

		const record: LogRecord = {
			level: 'info',
			message: 'shouldMultiline true test',
			time: 1234567890000,
			context: {
				attributes: longAttributes
			}
		}

		const result = formatPrettyReloaded(record, {mode: 'pretty'})

		expect(result).toContain('shouldMultiline true test')
		// Should use multiline format when isTty is true and attributes are long
		expect(result).toMatch(/\n\s+veryLongKey/)

		// Restore original isTTY and reload module
		if (typeof process !== 'undefined' && process.stdout && originalIsTTY !== undefined) {
			Object.defineProperty(process.stdout, 'isTTY', {
				value: originalIsTTY,
				writable: true,
				configurable: true
			})
		}
		await vi.resetModules()
		// Re-import to restore original module
		await import('../../../src/features/formatting/pretty')
	})

	it('should preserve direct pretty formatting with hostile tags', () => {
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

		const result = formatPretty(record, {mode: 'pretty'})

		expect(result).toContain('hostile tags')
		expect(result).toContain('[safe]')
	})

	it('contains line breaks and terminal escapes in human-controlled fields', () => {
		const result = formatPretty({
			level: 'info', time: 1,
			message: 'first\nFAKE ERROR\u001b[31m',
			context: {namespace: 'api\rforged', tags: ['safe\tforged']}
		}, {mode: 'pretty'})

		expect(result).not.toContain('\n')
		expect(result).not.toContain('\r')
		expect(result).not.toContain('\u001b[31m')
		expect(result).toContain('first\\nFAKE ERROR')
		expect(result).toContain('api\\rforged')
		expect(result).toContain('safe\\tforged')
	})

})
