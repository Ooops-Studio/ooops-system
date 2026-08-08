import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi} from 'vitest'

import {createDynamicProvidersEnriching, DYNAMIC_PROVIDER_TIMEOUT_MS} from '../../../src/features/enriching/dynamic-providers'

describe('createDynamicProvidersEnriching', () => {
	it('should enrich record with dynamic providers', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('passes accumulated provider attributes to each subsequent provider', async() => {
		const enriching = createDynamicProvidersEnriching([
			() => ({requestId: 'req-123'}),
			(record) => ({requestScope: `scope:${record.context?.attributes?.requestId}`})
		])

		const result = await enriching({
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}, {})

		expect(result.context?.attributes).toMatchObject({
			requestId: 'req-123',
			requestScope: 'scope:req-123'
		})
	})

	it('should handle empty providers object', async() => {
		const enriching = createDynamicProvidersEnriching([])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result).toEqual(record)
	})

	it('should handle records without context', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with existing context', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				tags: ['tag1'],
				attributes: {
					existingAttr: 'existing-value'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes?.existingAttr).toBe('existing-value')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should continue provider enrichment when existing context is hostile', async() => {
		const provider = vi.fn((_record: LogRecord) => ({dynamic: 'value'}))
		const enriching = createDynamicProvidersEnriching([provider])
		const record = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		} as LogRecord
		Object.defineProperty(record, 'context', {
			enumerable: false,
			get() {
				throw new Error('context getter failed')
			}
		})

		const result = await enriching(record, {})

		expect(provider).toHaveBeenCalled()
		expect(result.context?.attributes?.dynamic).toBe('value')
	})

	it('should handle provider errors gracefully', async() => {
		const mockErrors: Errors = {
			report: vi.fn()
		}

		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => {
				throw new Error('Provider error')
			}
		], mockErrors)

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {errors: mockErrors})

		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(mockErrors.report).toHaveBeenCalled()
	})

	it('should handle provider errors without errors service', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => {
				throw new Error('Provider error')
			}
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result.context?.attributes?.timestamp).toBeDefined()
	})

	it('should handle different log levels', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'unknown']

		for (const level of levels) {
			const record: LogRecord = {
				level: level as 'info',
				message: `${level} message`,
				time: 1234567890000
			}

			const result = await enriching(record, {})

			expect(result.context?.attributes?.timestamp).toBeDefined()
			expect(result.context?.attributes?.randomId).toBeDefined()
		}
	})

	it('should handle different messages', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const messages = [
			'',
			'simple message',
			'message with "quotes"',
			'message with \n newlines',
			'message with \t tabs',
			'message with \\ backslashes',
			'🚀 emoji message 中文',
			'a'.repeat(1000)
		]

		for (const message of messages) {
			const record: LogRecord = {
				level: 'info',
				message,
				time: 1234567890000
			}

			const result = await enriching(record, {})

			expect(result.context?.attributes?.timestamp).toBeDefined()
			expect(result.context?.attributes?.randomId).toBeDefined()
		}
	})

	it('should handle different time values', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const times = [0, 1234567890000, Date.now(), Number.MAX_SAFE_INTEGER]

		for (const time of times) {
			const record: LogRecord = {
				level: 'info',
				message: 'test message',
				time
			}

			const result = await enriching(record, {})

			expect(result.context?.attributes?.timestamp).toBeDefined()
			expect(result.context?.attributes?.randomId).toBeDefined()
		}
	})

	it('should handle multiple consecutive calls', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result1 = await enriching(record, {})
		const result2 = await enriching(record, {})
		const result3 = await enriching(record, {})

		expect(result1.context?.attributes?.timestamp).toBeDefined()
		expect(result1.context?.attributes?.randomId).toBeDefined()
		expect(result2.context?.attributes?.timestamp).toBeDefined()
		expect(result2.context?.attributes?.randomId).toBeDefined()
		expect(result3.context?.attributes?.timestamp).toBeDefined()
		expect(result3.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with empty context', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {}
		}

		const result = await enriching(record, {})

		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with context but no attributes', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				tags: ['tag1']
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with context but no tags', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				attributes: {
					existingAttr: 'existing-value'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.attributes?.existingAttr).toBe('existing-value')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with context but no namespace', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				tags: ['tag1'],
				attributes: {
					existingAttr: 'existing-value'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes?.existingAttr).toBe('existing-value')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with all context fields', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				tags: ['tag1', 'tag2'],
				attributes: {
					existingAttr: 'existing-value',
					anotherAttr: 'another-value'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1', 'tag2'])
		expect(result.context?.attributes?.existingAttr).toBe('existing-value')
		expect(result.context?.attributes?.anotherAttr).toBe('another-value')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with complex nested attributes', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
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
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1', 'tag2'])
		expect(result.context?.attributes?.user).toEqual({
			name: 'John',
			age: 30,
			address: {
				city: 'New York',
				country: 'USA'
			}
		})
		expect(result.context?.attributes?.metadata).toEqual({
			version: '1.0.0',
			features: ['feature1', 'feature2']
		})
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with null and undefined values in attributes', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				tags: ['tag1'],
				attributes: {
					nullValue: null,
					// undefinedValue: undefined, // Cannot assign undefined to JsonValue
					emptyString: '',
					zero: 0,
					falseValue: false
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes?.nullValue).toBeNull()
		expect(result.context?.attributes?.emptyString).toBe('')
		expect(result.context?.attributes?.zero).toBe(0)
		expect(result.context?.attributes?.falseValue).toBe(false)
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with empty tags array', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				tags: [],
				attributes: {
					existingAttr: 'existing-value'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual([])
		expect(result.context?.attributes?.existingAttr).toBe('existing-value')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with special characters in namespace', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace.with.dots',
				tags: ['tag1'],
				attributes: {
					existingAttr: 'existing-value'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace.with.dots')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes?.existingAttr).toBe('existing-value')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with special characters in tags', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				tags: ['tag-with-dashes', 'tag_with_underscores', 'tag.with.dots'],
				attributes: {
					existingAttr: 'existing-value'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag-with-dashes', 'tag_with_underscores', 'tag.with.dots'])
		expect(result.context?.attributes?.existingAttr).toBe('existing-value')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with special characters in attributes', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.namespace',
				tags: ['tag1'],
				attributes: {
					'key-with-dashes': 'value1',
					'key_with_underscores': 'value2',
					'key.with.dots': 'value3',
					'key with spaces': 'value4'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.namespace')
		expect(result.context?.tags).toEqual(['tag1'])
		expect(result.context?.attributes?.['key-with-dashes']).toBe('value1')
		expect(result.context?.attributes?.['key_with_underscores']).toBe('value2')
		expect(result.context?.attributes?.['key.with.dots']).toBe('value3')
		expect(result.context?.attributes?.['key with spaces']).toBe('value4')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle records with unicode characters', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: 'test.命名空间',
				tags: ['标签1', '标签2'],
				attributes: {
					'属性1': '值1',
					'属性2': '值2',
					'emoji': '🚀 test'
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe('test.命名空间')
		expect(result.context?.tags).toEqual(['标签1', '标签2'])
		expect(result.context?.attributes?.['属性1']).toBe('值1')
		expect(result.context?.attributes?.['属性2']).toBe('值2')
		expect(result.context?.attributes?.emoji).toBe('🚀 test')
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should bound records with very long context strings', async() => {
		const longString = 'a'.repeat(10000)
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({timestamp: Date.now()}),
			(_record: LogRecord) => ({randomId: Math.random().toString(36).substring(2, 11)})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {
				namespace: longString,
				tags: [longString],
				attributes: {
					longKey: longString,
					longValue: longString
				}
			}
		}

		const result = await enriching(record, {})

		expect(result.context?.namespace).toBe(`${longString.slice(0, 1024)}[Truncated]`)
		expect(result.context?.tags).toEqual([`${longString.slice(0, 256)}[Truncated]`])
		expect(result.context?.attributes?.longKey).toBe(longString)
		expect(result.context?.attributes?.longValue).toBe(longString)
		expect(result.context?.attributes?.timestamp).toBeDefined()
		expect(result.context?.attributes?.randomId).toBeDefined()
	})

	it('should handle providers that return empty objects', async() => {
		const enriching = createDynamicProvidersEnriching([
			(_record: LogRecord) => ({}),
			(_record: LogRecord) => ({}),
			(_record: LogRecord) => ({})
		])

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		// Should return original record when providers return empty objects
		expect(result).toEqual(record)
		expect(result.context).toBeUndefined()
	})

	it('bounds stalled providers and contains their late rejection', async() => {
		vi.useFakeTimers()
		try {
			let rejectProvider!: (error: unknown) => void
			const provider = vi.fn(() => new Promise<never>((_resolve, reject) => {
				rejectProvider = reject
			}))
			const errors = {report: vi.fn()}
			const enriching = createDynamicProvidersEnriching([provider], errors as never)
			const record: LogRecord = {level: 'info', message: 'test', time: 1}
			const resultPromise = enriching(record)

			await vi.advanceTimersByTimeAsync(DYNAMIC_PROVIDER_TIMEOUT_MS + 1)
			await expect(resultPromise).resolves.toBe(record)
			expect(errors.report).toHaveBeenCalledWith(
				expect.objectContaining({message: expect.stringContaining('timed out')}),
				expect.anything()
			)

			rejectProvider(new Error('late provider failure'))
			await vi.runAllTicks()
		} finally {
			vi.useRealTimers()
		}
	})

	it('rejects hostile thenables and primitive patches without executing accessors', async() => {
		const thenGetter = vi.fn(() => Promise.resolve({secret: 'value'}))
		const hostile = Object.defineProperty({}, 'then', {enumerable: true, get: thenGetter})
		const errors = {report: vi.fn()}
		const record: LogRecord = {level: 'info', message: 'test', time: 1}
		const enriching = createDynamicProvidersEnriching([
			() => hostile as never,
			() => 'invalid' as never,
			() => ({safe: true})
		], errors as never)

		const result = await enriching(record)
		expect(result.context?.attributes).toEqual({safe: true})
		expect(thenGetter).not.toHaveBeenCalled()
		expect(errors.report).toHaveBeenCalledTimes(2)
	})
})
