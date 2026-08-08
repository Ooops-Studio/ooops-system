import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi} from 'vitest'

import {createBaseContextEnriching} from '../../../src/features/enriching/base-context'
import * as enrichingUtils from '../../../src/utils/enriching'

describe('createBaseContextEnriching', () => {
	it('should add base context to record', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1', 'tag2'],
			attributes: {
				userId: '123',
				action: 'login'
			}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1', 'tag2'])
		expect(result.context?.attributes).toEqual({
			userId: '123',
			action: 'login'
		})
	})

	it('should merge with existing context', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'base.namespace',
			tags: ['base-tag'],
			attributes: {
				baseAttr: 'base-value'
			}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'existing.namespace',
				tags: ['existing-tag'],
				attributes: {
					existingAttr: 'existing-value'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('existing.namespace')
		expect(result.context?.tags).toEqual(['existing-tag', 'base-tag'])
		expect(result.context?.attributes).toEqual({
			baseAttr: 'base-value',
			existingAttr: 'existing-value'
		})
	})

	it('should handle partial base context', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace'
			// No tags or attributes
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toBeUndefined()
		expect(result.context?.attributes).toBeUndefined()
	})

	it('should handle empty base context', async() => {
		const enriching = createBaseContextEnriching({})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context).toEqual({})
	})

	it('should handle records without context', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({key: 'value'})
	})

	it('should handle records with empty context', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({key: 'value'})
	})

	it('should handle records with partial context', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'existing.namespace'
				// No tags or attributes
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('existing.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({key: 'value'})
	})

	it('should handle errors gracefully', async() => {
		const mockErrors: Errors = {
			report: vi.fn()
		}

		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {errors: mockErrors})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({key: 'value'})
		expect(mockErrors.report).not.toHaveBeenCalled()
	})

	it('should handle errors without errors service', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({key: 'value'})
	})

	it('should handle complex nested attributes', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1', 'tag2'],
			attributes: {
				user: {
					name: 'John',
					age: 30,
					address: {
						city: 'New York',
						country: 'USA'
					}
				},
				metadata: {
					version: '1.0.0',
					features: ['feature1', 'feature2']
				}
			}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1', 'tag2'])
		expect(result.context?.attributes).toEqual({
			user: {
				name: 'John',
				age: 30,
				address: {
					city: 'New York',
					country: 'USA'
				}
			},
			metadata: {
				version: '1.0.0',
				features: ['feature1', 'feature2']
			}
		})
	})

	it('should handle null and undefined values in attributes', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {
				nullValue: null,
				// undefinedValue: undefined, // Cannot assign undefined to JsonValue
				emptyString: '',
				zero: 0,
				falseValue: false
			}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({
			nullValue: null,
			emptyString: '',
			zero: 0,
			falseValue: false
		})
	})

	it('should handle empty tags array', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: [],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toBeUndefined()
		expect(result.context?.attributes).toEqual({key: 'value'})
	})

	it('should handle special characters in namespace', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace.with.dots',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace.with.dots')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({key: 'value'})
	})

	it('should handle special characters in tags', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag-with-dashes', 'tag_with_underscores', 'tag.with.dots'],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag-with-dashes', 'tag_with_underscores', 'tag.with.dots'])
		expect(result.context?.attributes).toEqual({key: 'value'})
	})

	it('should handle special characters in attributes', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {
				'key-with-dashes': 'value1',
				'key_with_underscores': 'value2',
				'key.with.dots': 'value3',
				'key with spaces': 'value4'
			}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({
			'key-with-dashes': 'value1',
			'key_with_underscores': 'value2',
			'key.with.dots': 'value3',
			'key with spaces': 'value4'
		})
	})

	it('should handle unicode characters', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.命名空间',
			tags: ['标签1', '标签2'],
			attributes: {
				'属性1': '值1',
				'属性2': '值2',
				'emoji': '🚀 test'
			}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.命名空间')
		expect(result.context?.tags).toEqual(['标签1', '标签2'])
		expect(result.context?.attributes).toEqual({
			'属性1': '值1',
			'属性2': '值2',
			'emoji': '🚀 test'
		})
	})

	it('should bound very long context strings', async() => {
		const longString = 'a'.repeat(10000)
		const enriching = createBaseContextEnriching({
			namespace: longString,
			tags: [longString],
			attributes: {
				longKey: longString,
				longValue: longString
			}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe(`${longString.slice(0, 1_024)}[Truncated]`)
		expect(result.context?.tags).toEqual([`${longString.slice(0, 256)}[Truncated]`])
		expect(result.context?.attributes).toEqual({
			longKey: longString,
			longValue: longString
		})
	})

	it('should handle multiple consecutive calls', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const record1: LogRecord = {
			level: 'info',
			message: 'test message 1',
			time: 1234567890000
		}

		const record2: LogRecord = {
			level: 'warn',
			message: 'test message 2',
			time: 1234567890001
		}

		const result1 = await enriching(record1, {})
		const result2 = await enriching(record2, {})

		expect(result1.context?.namespace).toBe('test.namespace')
		expect(result1.context?.tags).toEqual(['tag1'])
		expect(result1.context?.attributes).toEqual({key: 'value'})

		expect(result2.context?.namespace).toBe('test.namespace')
		expect(result2.context?.tags).toEqual(['tag1'])
		expect(result2.context?.attributes).toEqual({key: 'value'})
	})

	it('should handle different log levels', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'unknown']

		for (const level of levels) {
			const record: LogRecord = {
				level: level as 'info',
				message: `${level} message`,
				time: 1234567890000
			}

			const result = await enriching(record, {})

			expect(result.context?.namespace).toBe('test.namespace')
			expect(result.context?.tags).toEqual(['tag1'])
			expect(result.context?.attributes).toEqual({key: 'value'})
		}
	})

	it('should handle records with different time values', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const times = [0, 1234567890000, Date.now(), Number.MAX_SAFE_INTEGER]

		for (const time of times) {
			const record: LogRecord = {
				level: 'info',
				message: 'test message',
				time
			}

			const result = await enriching(record, {})

			expect(result.context?.namespace).toBe('test.namespace')
			expect(result.context?.tags).toEqual(['tag1'])
			expect(result.context?.attributes).toEqual({key: 'value'})
		}
	})

	it('should handle records with different message values', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const messages = [
			'',
			'simple message',
			'message with "quotes"',
			'message with \n newlines',
			'message with \t tabs',
			'message with \\ backslashes',
			'🚀 emoji message 中文',
			'a'.repeat(10000)
		]

		for (const message of messages) {
			const record: LogRecord = {
				level: 'info',
				message,
				time: 1234567890000
			}

			const result = await enriching(record, {})

			expect(result.context?.namespace).toBe('test.namespace')
			expect(result.context?.tags).toEqual(['tag1'])
			expect(result.context?.attributes).toEqual({key: 'value'})
		}
	})

	it('should preserve enrichment when legacy attribute merge helper is mocked to throw', async() => {
		const mockErrors: Errors = {
			report: vi.fn()
		}

		const originalMergeAttributes = enrichingUtils.mergeAttributes
		vi.spyOn(enrichingUtils, 'mergeAttributes').mockImplementation(() => {
			throw new Error('Merge attributes failed')
		})

		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		}, mockErrors)

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				attributes: {existingKey: 'existingValue'}
			}
		}

		const result = await enriching(record, {errors: mockErrors})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({
			key: 'value',
			existingKey: 'existingValue'
		})
		expect(mockErrors.report).not.toHaveBeenCalled()

		vi.spyOn(enrichingUtils, 'mergeAttributes').mockImplementation(originalMergeAttributes)
	})

	it('should handle errors in mergeTags and return original record', async() => {
		const mockErrors: Errors = {
			report: vi.fn()
		}

		// Mock mergeTags to throw an error
		const originalMergeTags = enrichingUtils.mergeTags
		vi.spyOn(enrichingUtils, 'mergeTags').mockImplementation(() => {
			throw new Error('Merge tags failed')
		})

		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		}, mockErrors)

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				tags: ['existingTag']
			}
		}

		const result = await enriching(record, {errors: mockErrors})

		// Should return original record when error occurs
		expect(result).toEqual(record)
		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'Merge tags failed'
			}),
			expect.objectContaining({
				stage: 'enriching',
				step: 'base-context'
			})
		)

		// Restore original function
		vi.spyOn(enrichingUtils, 'mergeTags').mockImplementation(originalMergeTags)
	})

	it('should preserve enrichment without errors service when legacy attribute merge helper is mocked to throw', async() => {
		const originalMergeAttributes = enrichingUtils.mergeAttributes
		vi.spyOn(enrichingUtils, 'mergeAttributes').mockImplementation(() => {
			throw new Error('Merge attributes failed')
		})

		const enriching = createBaseContextEnriching({
			namespace: 'test.namespace',
			tags: ['tag1'],
			attributes: {key: 'value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				attributes: {existingKey: 'existingValue'}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes).toEqual({
			key: 'value',
			existingKey: 'existingValue'
		})

		vi.spyOn(enrichingUtils, 'mergeAttributes').mockImplementation(originalMergeAttributes)
	})

	it('should use override context from options when provided', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'base.namespace',
			tags: ['base-tag'],
			attributes: {baseAttr: 'base-value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {
			context: {
				namespace: 'override.namespace',
				tags: ['override-tag'],
				attributes: {overrideAttr: 'override-value'}
			}
		})

		expect(result.context?.namespace).toBe('override.namespace')
		expect(result.context?.tags).toContain('override-tag')
		expect(result.context?.attributes?.overrideAttr).toBe('override-value')
	})

	it('should merge override context with base context', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'base.namespace',
			tags: ['base-tag'],
			attributes: {baseAttr: 'base-value', sharedAttr: 'base-shared'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {
			context: {
				namespace: 'override.namespace',
				tags: ['override-tag'],
				attributes: {overrideAttr: 'override-value', sharedAttr: 'override-shared'}
			}
		})

		expect(result.context?.namespace).toBe('override.namespace')
		expect(result.context?.tags).toContain('override-tag')
		expect(result.context?.attributes?.baseAttr).toBe('base-value')
		expect(result.context?.attributes?.overrideAttr).toBe('override-value')
		expect(result.context?.attributes?.sharedAttr).toBe('override-shared')
	})

	it('should use base namespace when override has no namespace', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'base.namespace',
			tags: ['base-tag'],
			attributes: {baseAttr: 'base-value'}
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {
			context: {
				tags: ['override-tag'],
				attributes: {overrideAttr: 'override-value'}
			}
		})

		expect(result.context?.namespace).toBe('base.namespace')
		expect(result.context?.tags).toContain('override-tag')
		expect(result.context?.attributes?.overrideAttr).toBe('override-value')
	})

	it('should use override attributes when base has no attributes', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'base.namespace',
			tags: ['base-tag']
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {
			context: {
				attributes: {overrideAttr: 'override-value'}
			}
		})

		expect(result.context?.attributes?.overrideAttr).toBe('override-value')
	})

	it('should merge tags from override and base', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'base.namespace',
			tags: ['base-tag1', 'base-tag2']
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {
			context: {
				tags: ['override-tag1', 'override-tag2']
			}
		})

		expect(result.context?.tags).toContain('base-tag1')
		expect(result.context?.tags).toContain('base-tag2')
		expect(result.context?.tags).toContain('override-tag1')
		expect(result.context?.tags).toContain('override-tag2')
	})

	it('should preserve base metadata when existing context has hostile fields', async() => {
		const enriching = createBaseContextEnriching({
			namespace: 'base.namespace',
			tags: ['base-tag'],
			attributes: {baseAttr: 'base-value'}
		})
		const hostileContext = new Proxy({tags: ['record-tag']}, {
			get(target, property, receiver) {
				if (property === 'attributes') throw new Error('attributes getter failed')
				return Reflect.get(target, property, receiver)
			}
		})
		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: hostileContext as never
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('base.namespace')
		expect(result.context?.attributes).toEqual({
			baseAttr: 'base-value'
		})
		expect(result.context?.tags).toEqual(['record-tag', 'base-tag'])
	})
})
