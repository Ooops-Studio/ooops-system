/**
 * @file Tests for EnrichedError class to ensure all fields are preserved when rethrowing.
 */

import type {EnrichedError as EnrichedErrorInterface} from '@ooopsstudio/core/contracts/errors'
import {describe, expect, it} from 'vitest'

import {EnrichedError} from '../../src/utils/enriched-error-class'

describe('EnrichedError', () => {
	it('preserves all enriched fields when rethrowing', () => {
		const original: EnrichedErrorInterface = {
			kind: 'TypeError',
			message: 'Test error message',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1234567890,
			id: 'error-id-123',
			correlationId: 'correlation-id-456',
			traceId: 'trace-id-789',
			source: 'test-source',
			code: 'TEST_ERROR',
			stack: 'Error: Test error message\n    at test.ts:1:1',
			cause: new Error('Original cause'),
			context: {
				userId: 'user-123',
				requestId: 'req-456'
			},
			data: {
				additional: 'data'
			}
		}

		const enrichedError = new EnrichedError(original)

		// Verify all fields are preserved
		expect(enrichedError.kind).toBe(original.kind)
		expect(enrichedError.message).toBe(original.message)
		expect(enrichedError.severity).toBe(original.severity)
		expect(enrichedError.category).toBe(original.category)
		expect(enrichedError.timestamp).toBe(original.timestamp)
		expect(enrichedError.id).toBe(original.id)
		expect(enrichedError.correlationId).toBe(original.correlationId)
		expect(enrichedError.traceId).toBe(original.traceId)
		expect(enrichedError.source).toBe(original.source)
		expect(enrichedError.code).toBe(original.code)
		expect(enrichedError.stack).toBe(original.stack)
		expect(enrichedError.cause).toBe(original.cause)
		expect(enrichedError.context).toEqual(original.context)
		expect(enrichedError.data).toEqual(original.data)
		expect(enrichedError.name).toBe(original.kind)
	})

	it('preserves stack when provided', () => {
		const original: EnrichedErrorInterface = {
			kind: 'Error',
			message: 'Test',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1234567890,
			stack: 'Custom stack trace'
		}

		const enrichedError = new EnrichedError(original)
		expect(enrichedError.stack).toBe('Custom stack trace')
	})

	it('preserves cause when provided', () => {
		const cause = new Error('Root cause')
		const original: EnrichedErrorInterface = {
			kind: 'Error',
			message: 'Test',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1234567890,
			cause
		}

		const enrichedError = new EnrichedError(original)
		expect(enrichedError.cause).toBe(cause)
	})

	it('handles optional fields correctly', () => {
		const original: EnrichedErrorInterface = {
			kind: 'Error',
			message: 'Test',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1234567890
			// No optional fields
		}

		const enrichedError = new EnrichedError(original)

		expect(enrichedError.id).toBeUndefined()
		expect(enrichedError.correlationId).toBeUndefined()
		expect(enrichedError.traceId).toBeUndefined()
		expect(enrichedError.source).toBeUndefined()
		expect(enrichedError.code).toBeUndefined()
		expect(enrichedError.context).toBeUndefined()
		expect(enrichedError.data).toBeUndefined()
		expect(enrichedError.cause).toBeUndefined()
	})

	it('sets error name to match kind', () => {
		const original: EnrichedErrorInterface = {
			kind: 'CustomError',
			message: 'Test',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1234567890
		}

		const enrichedError = new EnrichedError(original)
		expect(enrichedError.name).toBe('CustomError')
	})

	it('can be thrown and caught', () => {
		const original: EnrichedErrorInterface = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1234567890,
			correlationId: 'test-correlation'
		}

		const enrichedError = new EnrichedError(original)

		expect(() => {
			throw enrichedError
		}).toThrow('Test error')

		try {
			throw enrichedError
		} catch(caught) {
			expect(caught).toBeInstanceOf(EnrichedError)
			expect(caught).toBeInstanceOf(Error)
			if (caught instanceof EnrichedError) {
				expect(caught.correlationId).toBe('test-correlation')
			}
		}
	})

	it('preserves nested context and data objects', () => {
		const original: EnrichedErrorInterface = {
			kind: 'Error',
			message: 'Test',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1234567890,
			context: {
				nested: {
					value: 'test'
				},
				array: [1, 2, 3]
			},
			data: {
				metadata: {
					version: '1.0'
				}
			}
		}

		const enrichedError = new EnrichedError(original)
		expect(enrichedError.context).toEqual(original.context)
		expect(enrichedError.data).toEqual(original.data)
	})
})
