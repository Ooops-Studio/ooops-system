/**
 * @file Tests for on-error utilities.
 */

import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi} from 'vitest'

import {createTracingOnError, reportTracingFlushError, reportTracingShutdownError} from '../../src/utils/on-error'

describe('createTracingOnError', () => {

	it('should create an error handler with errors port', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const onError = createTracingOnError(mockErrors, {stage: 'test'})

		const error = new Error('Test error')
		onError(error)

		expect(mockErrors.report).toHaveBeenCalled()
	})

	it('should create an error handler without errors port', () => {

		const onError = createTracingOnError(undefined, {stage: 'test'})

		// Should not throw
		onError(new Error('Test error'))
	})

	it('should include preset in context', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const onError = createTracingOnError(mockErrors, {stage: 'test', preset: 'development'})

		const error = new Error('Test error')
		onError(error)

		expect(mockErrors.report).toHaveBeenCalled()
	})

	it('should handle extra attributes', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const onError = createTracingOnError(mockErrors, {stage: 'test'})

		const error = new Error('Test error')
		onError(error, {extra: 'data'})

		expect(mockErrors.report).toHaveBeenCalled()
	})

	it('should handle non-Error objects', () => {

		const mockErrors: Errors = {
			report: vi.fn()
		}

		const onError = createTracingOnError(mockErrors, {stage: 'test'})

		onError('String error')
		onError({message: 'Object error'})
		onError(null)

		expect(mockErrors.report).toHaveBeenCalled()
	})

	it('reports shutdown and flush errors with optional extra context', () => {
		const errors: Errors = {report: vi.fn()}
		reportTracingShutdownError(errors, new Error('shutdown'), {preset: 'test'})
		reportTracingFlushError(errors, new Error('flush'))
		expect(errors.report).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({operation: 'shutdown', preset: 'test'}))
		expect(errors.report).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({operation: 'flush'}))
	})
})
