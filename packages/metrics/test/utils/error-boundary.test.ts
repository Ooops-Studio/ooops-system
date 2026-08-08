import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi} from 'vitest'

import {
	createErrorBoundary,
	createSilentFailure,
	createSilentFailureWithFallback
} from '../../src/utils/error-boundary'

describe('error-boundary', () => {

	describe('createErrorBoundary', () => {

		it('should return no-op when errors port not provided', () => {

			const onError = createErrorBoundary({
				stage: 'test'
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
				stage: 'test',
				errors: mockErrors
			})

			onError(new Error('test error'))

			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should handle errors in error reporting silently', () => {

			const mockErrors: Errors = {
				report: vi.fn().mockImplementation(() => {
					throw new Error('Report failed')
				})
			}

			const onError = createErrorBoundary({
				stage: 'test',
				errors: mockErrors
			})

			expect(() => {
				onError(new Error('test error'))
			}).not.toThrow()
		})

		it('passes step and preset context through the boundary', () => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const onError = createErrorBoundary({
				stage: 'test',
				step: 'custom',
				preset: 'production',
				errors: mockErrors
			})

			onError(new Error('test error'))

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					stage: 'test',
					step: 'custom',
					preset: 'production'
				})
			)
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
				{stage: 'test', errors: mockErrors}
			)

			expect(result).toBe('success')
		})

		it('should catch errors and return undefined', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailure(
				async() => {
					throw new Error('operation failed')
				},
				{stage: 'test', errors: mockErrors}
			)

			expect(result).toBeUndefined()
			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should handle synchronous operations', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailure(
				() => {
					return 'success'
				},
				{stage: 'test', errors: mockErrors}
			)

			expect(result).toBe('success')
		})

		it('supports silent failure without an errors port', async() => {
			const result = await createSilentFailure(async() => {
				throw new Error('operation failed')
			}, {stage: 'test', step: 'custom', preset: 'testing'})

			expect(result).toBeUndefined()
		})
	})

	describe('createSilentFailureWithFallback', () => {

		it('should return operation result on success', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailureWithFallback(
				async() => {
					return 'success'
				},
				'fallback',
				{stage: 'test', errors: mockErrors}
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
				'fallback',
				{stage: 'test', errors: mockErrors}
			)

			expect(result).toBe('fallback')
			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should handle synchronous operations', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}

			const result = await createSilentFailureWithFallback(
				() => {
					return 'success'
				},
				'fallback',
				{stage: 'test', errors: mockErrors}
			)

			expect(result).toBe('success')
		})

		it('supports fallback without an errors port', async() => {
			const result = await createSilentFailureWithFallback(
				() => {
					throw new Error('operation failed')
				},
				'fallback',
				{stage: 'test', step: 'custom', preset: 'minimal'}
			)

			expect(result).toBe('fallback')
		})
	})
})
