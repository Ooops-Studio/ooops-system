/**
 * @file Tests for logging guard functions.
 */

import {describe, it, expect} from 'vitest'

import {
	isLogLevel,
	isLogAttributes,
	isLogTags,
	isLogContext,
	isLogRecord
} from '../../src/utils/guards'

describe('logging guards', () => {

	describe('isLogLevel', () => {

		it('should return true for valid log levels', () => {

			expect(isLogLevel('trace')).toBe(true)
			expect(isLogLevel('debug')).toBe(true)
			expect(isLogLevel('info')).toBe(true)
			expect(isLogLevel('warn')).toBe(true)
			expect(isLogLevel('error')).toBe(true)
			expect(isLogLevel('fatal')).toBe(true)
		})

		it('should return false for invalid log levels', () => {

			expect(isLogLevel('invalid')).toBe(false)
			expect(isLogLevel('INFO')).toBe(false)
			expect(isLogLevel('')).toBe(false)
			expect(isLogLevel(null)).toBe(false)
			expect(isLogLevel(undefined)).toBe(false)
			expect(isLogLevel(123)).toBe(false)
			expect(isLogLevel({})).toBe(false)
		})
	})

	describe('isLogAttributes', () => {

		it('should return true for valid log attributes', () => {

			expect(isLogAttributes({})).toBe(true)
			expect(isLogAttributes({key: 'value'})).toBe(true)
			expect(isLogAttributes({count: 123})).toBe(true)
			expect(isLogAttributes({active: true})).toBe(true)
			expect(isLogAttributes({nested: {key: 'value'}})).toBe(true)
			expect(isLogAttributes({items: [1, 2, 3]})).toBe(true)
			expect(isLogAttributes({mixed: {nested: {array: [1, 'two', true]}}})).toBe(true)
		})

		it('should return false for invalid log attributes', () => {

			expect(isLogAttributes(null)).toBe(false)
			expect(isLogAttributes(undefined)).toBe(false)
			expect(isLogAttributes('string')).toBe(false)
			expect(isLogAttributes(123)).toBe(false)
			expect(isLogAttributes(true)).toBe(false)
			expect(isLogAttributes([])).toBe(false)
			expect(isLogAttributes({func: () => {}})).toBe(false)
			expect(isLogAttributes({symbol: Symbol('test')})).toBe(false)
		})

		it('should handle arrays with valid JSON values', () => {

			expect(isLogAttributes({items: [1, 2, 3]})).toBe(true)
			expect(isLogAttributes({items: ['a', 'b', 'c']})).toBe(true)
			expect(isLogAttributes({items: [true, false]})).toBe(true)
			expect(isLogAttributes({items: [null]})).toBe(true)
			expect(isLogAttributes({items: [{nested: 'value'}]})).toBe(true)
		})

		it('should handle nested objects', () => {

			expect(isLogAttributes({level1: {level2: {level3: 'value'}}})).toBe(true)
			expect(isLogAttributes({user: {id: 123, name: 'test'}})).toBe(true)
		})

		it('returns false rather than throwing for cyclic, non-finite, or hostile values', () => {
			const cyclic: Record<string, unknown> = {}
			cyclic.self = cyclic
			const hostile = new Proxy({}, {
				ownKeys() {
					throw new Error('cannot enumerate')
				}
			})

			expect(() => isLogAttributes({cyclic})).not.toThrow()
			expect(isLogAttributes({cyclic})).toBe(false)
			expect(isLogAttributes({value: Number.NaN})).toBe(false)
			expect(isLogAttributes(hostile)).toBe(false)
		})

		it('does not throw for hostile contexts or records', () => {
			const hostile = new Proxy({}, {
				has() {
					throw new Error('cannot check')
				},
				get() {
					throw new Error('cannot read')
				}
			})

			expect(() => isLogContext(hostile)).not.toThrow()
			expect(() => isLogRecord(hostile)).not.toThrow()
			expect(isLogContext(hostile)).toBe(false)
			expect(isLogRecord(hostile)).toBe(false)
		})
	})

	describe('isLogTags', () => {

		it('should return true for valid log tags', () => {

			expect(isLogTags([])).toBe(true)
			expect(isLogTags(['tag1'])).toBe(true)
			expect(isLogTags(['tag1', 'tag2', 'tag3'])).toBe(true)
		})

		it('should return false for invalid log tags', () => {

			expect(isLogTags(null)).toBe(false)
			expect(isLogTags(undefined)).toBe(false)
			expect(isLogTags('string')).toBe(false)
			expect(isLogTags({})).toBe(false)
			expect(isLogTags([123])).toBe(false)
			expect(isLogTags(['tag', 123])).toBe(false)
			expect(isLogTags(['tag', null])).toBe(false)
			expect(isLogTags(['tag', {}])).toBe(false)
		})
	})

	describe('isLogContext', () => {

		it('should return true for valid log context with attributes', () => {

			expect(isLogContext({attributes: {key: 'value'}})).toBe(true)
			expect(isLogContext({attributes: {count: 123}})).toBe(true)
		})

		it('should return true for valid log context with tags', () => {

			expect(isLogContext({tags: ['tag1', 'tag2']})).toBe(true)
			expect(isLogContext({tags: []})).toBe(true)
		})

		it('should return true for valid log context with both attributes and tags', () => {

			expect(isLogContext({
				attributes: {key: 'value'},
				tags: ['tag1']
			})).toBe(true)
		})

		it('should return true for empty log context', () => {

			expect(isLogContext({})).toBe(true)
		})

		it('should return false for invalid log context', () => {

			expect(isLogContext(null)).toBe(false)
			expect(isLogContext(undefined)).toBe(false)
			expect(isLogContext('string')).toBe(false)
			expect(isLogContext(123)).toBe(false)
			expect(isLogContext([])).toBe(false)
		})

		it('should return false for context with invalid attributes', () => {

			expect(isLogContext({attributes: {func: () => {}}})).toBe(false)
			expect(isLogContext({attributes: 'not-object'})).toBe(false)
		})

		it('should return false for context with invalid tags', () => {

			expect(isLogContext({tags: [123]})).toBe(false)
			expect(isLogContext({tags: 'not-array'})).toBe(false)
		})
	})

	describe('isLogRecord', () => {

		it('should return true for valid log record', () => {

			expect(isLogRecord({
				level: 'info',
				time: Date.now(),
				message: 'test message'
			})).toBe(true)
		})

		it('should return true for log record with context', () => {

			expect(isLogRecord({
				level: 'error',
				time: Date.now(),
				message: 'error message',
				context: {
					attributes: {error: 'details'}
				}
			})).toBe(true)
		})

		it('should return false for invalid log record', () => {

			expect(isLogRecord(null)).toBe(false)
			expect(isLogRecord(undefined)).toBe(false)
			expect(isLogRecord('string')).toBe(false)
			expect(isLogRecord(123)).toBe(false)
			expect(isLogRecord([])).toBe(false)
		})

		it('should return false for record with invalid level', () => {

			expect(isLogRecord({
				level: 'invalid',
				time: Date.now(),
				message: 'test'
			})).toBe(false)
		})

		it('should return false for record with invalid time', () => {

			expect(isLogRecord({
				level: 'info',
				time: 'not-a-number',
				message: 'test'
			})).toBe(false)
		})

		it('should return false for record with invalid message', () => {

			expect(isLogRecord({
				level: 'info',
				time: Date.now(),
				message: 123
			})).toBe(false)
		})

		it('should return false for record with invalid context', () => {

			expect(isLogRecord({
				level: 'info',
				time: Date.now(),
				message: 'test',
				context: {attributes: {func: () => {}}}
			})).toBe(false)
		})

		it('should return true for record without context', () => {

			expect(isLogRecord({
				level: 'warn',
				time: Date.now(),
				message: 'warning message'
			})).toBe(true)
		})
	})
})
