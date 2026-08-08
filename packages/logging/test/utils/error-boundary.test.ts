/**
 * @file Tests for logging error boundary utilities.
 */

import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi} from 'vitest'

import {
	createErrorBoundary,
	createSilentFailure,
	createSilentFailureWithFallback
} from '../../src/utils/error-boundary'

describe('logging error-boundary', () => {

	describe('createErrorBoundary', () => {

		it('should return no-op when errors port not provided', () => {

			const onError = createErrorBoundary({
				stage: 'enriching'
			})

			expect(() => {
				onError(new Error('test error'))
			}).not.toThrow()
		})

		it('should call errors.report when errors port provided', () => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const onError = createErrorBoundary({
				stage: 'transferring',
				errors: mockErrors
			})

			onError(new Error('test error'))

			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should include stage in error context', () => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const onError = createErrorBoundary({
				stage: 'formatting',
				errors: mockErrors
			})

			onError(new Error('test error'))

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					stage: 'formatting'
				})
			)
		})

		it('should include step in error context when provided', () => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const onError = createErrorBoundary({
				stage: 'enriching',
				step: 'custom',
				errors: mockErrors
			})

			onError(new Error('test error'))

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					stage: 'enriching',
					step: 'custom'
				})
			)
		})

		it('should include preset in error context when provided', () => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const onError = createErrorBoundary({
				stage: 'transferring',
				preset: 'production',
				errors: mockErrors
			})

			onError(new Error('test error'))

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					stage: 'transferring',
					preset: 'production'
				})
			)
		})

		it('should handle errors in error reporting silently', () => {

			const mockErrors: Errors = {
				report: vi.fn().mockImplementation(() => {
					throw new Error('Report failed')
				})
			}

			const onError = createErrorBoundary({
				stage: 'enriching',
				errors: mockErrors
			})

			expect(() => {
				onError(new Error('test error'))
			}).not.toThrow()
		})
	})

	describe('createSilentFailure', () => {

		it('should execute operation and return result', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailure(
				async() => {
					return 'success'
				},
				{stage: 'transferring', errors: mockErrors}
			)

			expect(result).toBe('success')
		})

		it('should execute synchronous operation and return result', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailure(
				() => {
					return 'sync-success'
				},
				{stage: 'formatting', errors: mockErrors}
			)

			expect(result).toBe('sync-success')
		})

		it('should catch errors and return undefined', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailure(
				async() => {
					throw new Error('operation failed')
				},
				{stage: 'enriching', errors: mockErrors}
			)

			expect(result).toBeUndefined()
			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should catch synchronous errors and return undefined', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailure(
				() => {
					throw new Error('sync operation failed')
				},
				{stage: 'transferring', errors: mockErrors}
			)

			expect(result).toBeUndefined()
			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should work without errors port', async() => {

			const result = await createSilentFailure(
				async() => {
					throw new Error('operation failed')
				},
				{stage: 'formatting'}
			)

			expect(result).toBeUndefined()
		})

		it('should include context in error report', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			await createSilentFailure(
				async() => {
					throw new Error('operation failed')
				},
				{stage: 'enriching', step: 'custom', preset: 'production', errors: mockErrors}
			)

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					stage: 'enriching',
					step: 'custom',
					preset: 'production'
				})
			)
		})
	})

	describe('createSilentFailureWithFallback', () => {

		it('should execute operation and return result', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailureWithFallback(
				async() => {
					return 'success'
				},
				'fallback',
				{stage: 'transferring', errors: mockErrors}
			)

			expect(result).toBe('success')
		})

		it('should return fallback on error', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailureWithFallback(
				async() => {
					throw new Error('operation failed')
				},
				'fallback-value',
				{stage: 'enriching', errors: mockErrors}
			)

			expect(result).toBe('fallback-value')
			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should return object fallback on error', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const fallback = {default: 'value'}
			const result = await createSilentFailureWithFallback(
				async() => {
					throw new Error('operation failed')
				},
				fallback,
				{stage: 'formatting', errors: mockErrors}
			)

			expect(result).toBe(fallback)
		})

		it('should work without errors port', async() => {

			const result = await createSilentFailureWithFallback(
				async() => {
					throw new Error('operation failed')
				},
				'fallback',
				{stage: 'transferring'}
			)

			expect(result).toBe('fallback')
		})

		it('should include context in error report', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			await createSilentFailureWithFallback(
				async() => {
					throw new Error('operation failed')
				},
				'fallback',
				{stage: 'enriching', step: 'custom', preset: 'development', errors: mockErrors}
			)

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					stage: 'enriching',
					step: 'custom',
					preset: 'development'
				})
			)
		})
	})
})
