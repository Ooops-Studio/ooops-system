import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi, beforeEach} from 'vitest'

import {createMetricsOnError} from '../../src/utils/on-error'

describe('on-error', () => {

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('createMetricsOnError', () => {

		it('should call errors.report when errors port provided', () => {

			const mockErrors: Errors = {
				report: vi.fn().mockResolvedValue(undefined)
			}

			const onError = createMetricsOnError(mockErrors, {stage: 'test'})

			onError(new Error('test error'), {operation: 'test'})

			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should include fixed context in error report', () => {

			const mockErrors: Errors = {
				report: vi.fn().mockResolvedValue(undefined)
			}

			const onError = createMetricsOnError(mockErrors, {
				stage: 'test',
				preset: 'production'
			})

			onError(new Error('test error'))

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					stage: 'test',
					preset: 'production'
				})
			)
		})

		it('should merge fixed context with extra context', () => {

			const mockErrors: Errors = {
				report: vi.fn().mockResolvedValue(undefined)
			}

			const onError = createMetricsOnError(mockErrors, {stage: 'test'})

			onError(new Error('test error'), {operation: 'export'})

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					stage: 'test',
					operation: 'export'
				})
			)
		})

		it('should handle errors in error reporting silently', () => {

			const mockErrors: Errors = {
				report: vi.fn().mockRejectedValue(new Error('Report failed'))
			}

			const onError = createMetricsOnError(mockErrors, {stage: 'test'})

			expect(() => {
				onError(new Error('test error'))
			}).not.toThrow()
		})

		it('should skip reporting when error is reported twice (recursion guard)', () => {

			const mockErrors: Errors = {
				report: vi.fn().mockResolvedValue(undefined)
			}

			const onError = createMetricsOnError(mockErrors, {stage: 'test'})

			const error = new Error('test error')

			// First call should report
			onError(error)
			expect(mockErrors.report).toHaveBeenCalledTimes(1)

			// Second call should be skipped (recursion guard via WeakSet)
			onError(error)
			expect(mockErrors.report).toHaveBeenCalledTimes(1)
		})

		it('should handle undefined errors port gracefully', () => {

			const onError = createMetricsOnError(undefined, {stage: 'test'})

			expect(() => {
				onError(new Error('test error'))
			}).not.toThrow()
		})

		it('should silently handle errors when no errors port provided (no registry lookup)', () => {
			const onError = createMetricsOnError(undefined, {stage: 'test'})

			expect(() => {
				onError(new Error('test error'), {operation: 'export'})
			}).not.toThrow()
		})

		it('supports missing fixed context', () => {
			const mockErrors: Errors = {
				report: vi.fn().mockResolvedValue(undefined)
			}

			const onError = createMetricsOnError(mockErrors)

			onError(new Error('test error'))

			expect(mockErrors.report).toHaveBeenCalled()
			const [errorPayload, context] = vi.mocked(mockErrors.report).mock.calls[0] ?? []
			expect(errorPayload).toMatchObject({message: 'test error'})
			expect(context).toEqual({source: 'metrics', stage: 'metrics'})
		})
	})
})
