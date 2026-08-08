import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi, beforeEach} from 'vitest'

import {createFormatting} from '../../src/core/formatting'

describe('createFormatting', () => {
	let mockErrors: Errors

	beforeEach(() => {
		mockErrors = {
			report: vi.fn()
		}
	})

	it('should format record using provided formatter', () => {
		const mockFormatter = vi.fn().mockReturnValue('formatted line')
		const formatting = createFormatting(mockFormatter)

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		const result = formatting(record, {mode: 'json'})

		expect(mockFormatter).toHaveBeenCalledWith(record, {mode: 'json'})
		expect(result).toBe('formatted line')
	})

	it('should format records successfully', () => {
		const mockFormatter = vi.fn().mockReturnValue('formatted output')
		const formatting = createFormatting(mockFormatter)

		const record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000,
			context: {attributes: {service: 'test'}}
		}

		const options = {errors: mockErrors, mode: 'json' as const}

		const result = formatting(record, options)

		expect(result).toBe('formatted output')
		expect(mockFormatter).toHaveBeenCalledWith(record, options)
	})

	it('should handle formatting errors and return fallback', () => {
		const mockFormatter = vi.fn().mockImplementation(() => {
			throw new Error('Formatting failed')
		})
		const formatting = createFormatting(mockFormatter)

		const record: LogRecord = {
			level: 'error',
			message: 'test error',
			time: 1234567890000,
			context: {attributes: {service: 'test'}}
		}

		const options = {errors: mockErrors, mode: 'json' as const}

		const result = formatting(record, options)

		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'Formatting failed'
			}),
			expect.objectContaining({
				stage: 'formatting',
				step: 'createFormatting'
			})
		)

		// Should return fallback JSON
		const parsed = JSON.parse(result)
		expect(parsed.level).toBe('error')
		expect(parsed.message).toBe('test error')
		expect(parsed.timestamp).toBe(1234567890000)
		expect(parsed.context).toEqual({attributes: {service: 'test'}})
		expect(parsed.error).toBe('Formatting failed')
	})

	it('should return a safe fallback when formatting fails with hostile context', () => {
		const mockFormatter = vi.fn().mockImplementation(() => {
			throw new Error('Formatting failed')
		})
		const formatting = createFormatting(mockFormatter)
		const circular: Record<string, unknown> = {name: 'cycle'}
		circular.self = circular
		const hostileObject: Record<string, unknown> = {safe: 'ok'}
		Object.defineProperty(hostileObject, 'secret', {
			enumerable: true,
			get() {
				throw new Error('getter failed')
			}
		})

		const record: LogRecord = {
			level: 'error',
			message: 'test error',
			time: 1234567890000,
			context: {
				attributes: {
					big: 10n,
					circular,
					hostileObject
				} as never
			}
		}

		const result = formatting(record, {errors: mockErrors, mode: 'json'})
		const parsed = JSON.parse(result)

		expect(parsed.level).toBe('error')
		expect(parsed.message).toBe('test error')
		expect(parsed.context.attributes.big).toBe('10')
		expect(parsed.context.attributes.circular).toEqual({
			name: 'cycle',
			self: '[Circular]'
		})
		expect(parsed.context.attributes.hostileObject).toEqual({
			safe: 'ok',
			secret: '[Unserializable]'
		})
		expect(parsed.error).toBe('Formatting failed')
	})

	it('should handle formatting errors without errors handler', () => {
		const mockFormatter = vi.fn().mockImplementation(() => {
			throw new Error('Formatting failed')
		})
		const formatting = createFormatting(mockFormatter)

		const record: LogRecord = {
			level: 'warn',
			message: 'test warning',
			time: 1234567890000,
			context: {attributes: {service: 'test'}}
		}

		const options = {mode: 'json' as const} // No errors handler

		const result = formatting(record, options)

		// Should still return fallback JSON even without errors handler
		const parsed = JSON.parse(result)
		expect(parsed.level).toBe('warn')
		expect(parsed.message).toBe('test warning')
		expect(parsed.timestamp).toBe(1234567890000)
		expect(parsed.context).toEqual({attributes: {service: 'test'}})
		expect(parsed.error).toBe('Formatting failed')
	})

	it('uses the minimal fallback when record access throws', () => {
		const formatting = createFormatting(() => { throw new Error('formatter failed') })
		const record = new Proxy({} as LogRecord, {
			get() { throw new Error('hostile record') }
		})

		const parsed = JSON.parse(formatting(record, {mode: 'json'}))
		expect(parsed).toMatchObject({
			level: '[unavailable]',
			message: '[formatting-error]',
			timestamp: 0
		})
	})

	it('does not coerce malformed record fields in the fallback', () => {
		const stringify = vi.fn(() => 'leaked')
		const formatting = createFormatting(() => { throw new Error('formatter failed') })
		const parsed = JSON.parse(formatting({
			level: {toString: stringify},
			message: {toString: stringify},
			time: Number.NaN
		} as never, {mode: 'json'}))

		expect(parsed).toMatchObject({
			level: '[unavailable]',
			message: '[formatting-error]',
			originalMessage: '[unavailable]',
			timestamp: 0
		})
		expect(stringify).not.toHaveBeenCalled()
	})
})
