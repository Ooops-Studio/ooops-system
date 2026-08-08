import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi, beforeEach} from 'vitest'

import {createStageOnError} from '../../src/utils/on-error'

describe('on-error utils', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('createStageOnError', () => {
		it('should return no-op function when no errors service provided', () => {
			const onError = createStageOnError()
			expect(() => onError(new Error('test'))).not.toThrow()
		})

		it('should call errors.report when errors service is provided', () => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const onError = createStageOnError(mockErrors)

			const error = new Error('test error')
			onError(error)

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: 'Error',
					message: 'test error'
				}),
				{
					source: 'logging',
					stage: 'logging'
				}
			)
		})

		it('should merge fixed context with extra context', () => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const fixedContext: LogAttributes = {service: 'test', stage: 'enriching'}
			const onError = createStageOnError(mockErrors, fixedContext)

			const error = new Error('test error')
			const extraContext: LogAttributes = {userId: '123', action: 'log'}
			onError(error, extraContext)

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: 'Error',
					message: 'test error'
				}),
				{
					service: 'test',
					source: 'logging',
					stage: 'enriching',
					userId: '123',
					action: 'log'
				}
			)
		})

		it('should handle extra context overriding fixed context', () => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const fixedContext: LogAttributes = {service: 'test', stage: 'enriching'}
			const onError = createStageOnError(mockErrors, fixedContext)

			const error = new Error('test error')
			const extraContext: LogAttributes = {stage: 'formatting', userId: '123'}
			onError(error, extraContext)

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: 'Error',
					message: 'test error'
				}),
				{
					service: 'test',
					source: 'logging',
					stage: 'formatting', // Should be overridden
					userId: '123'
				}
			)
		})

		it('should handle errors in error reporting silently', () => {
			const mockErrors: Errors = {
				report: vi.fn().mockImplementation(() => {
					throw new Error('Report failed')
				})
			}
			const onError = createStageOnError(mockErrors)

			// Should not throw even if errors.report throws
			expect(() => onError(new Error('test error'))).not.toThrow()
		})

		it('should normalize different error types', () => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const onError = createStageOnError(mockErrors)

			// Test with string error
			onError('string error')
			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: 'UnknownError',
					message: 'string error'
				}),
				{
					source: 'logging',
					stage: 'logging'
				}
			)

			// Test with object error
			const objectError = {message: 'object error', name: 'CustomError'}
			onError(objectError)
			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: 'CustomError',
					message: 'object error'
				}),
				{
					source: 'logging',
					stage: 'logging'
				}
			)

			// Test with Error instance
			const errorInstance = new Error('instance error')
			onError(errorInstance)
			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: 'Error',
					message: 'instance error'
				}),
				{
					source: 'logging',
					stage: 'logging'
				}
			)
		})

		it('should handle undefined extra context', () => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const fixedContext: LogAttributes = {service: 'test'}
			const onError = createStageOnError(mockErrors, fixedContext)

			const error = new Error('test error')
			onError(error, undefined)

			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: 'Error',
					message: 'test error'
				}),
				{
					source: 'logging',
					stage: 'logging',
					service: 'test'
				}
			)
		})

		it('suppresses active recursion but permits a later repeated incident', () => {
			let onError!: ReturnType<typeof createStageOnError>
			const error = new Error('test error')
			const mockErrors: Errors = {
				report: vi.fn(() => { onError(error) })
			}
			onError = createStageOnError(mockErrors)

			onError(error)
			expect(mockErrors.report).toHaveBeenCalledTimes(1)

			vi.mocked(mockErrors.report).mockImplementation(() => undefined)
			onError(error)
			expect(mockErrors.report).toHaveBeenCalledTimes(2)
		})

		it('does not let one Errors port suppress a distinct Errors port', () => {
			const first = {report: vi.fn()}
			const second = {report: vi.fn()}
			const error = new Error('shared error')

			createStageOnError(first)(error)
			createStageOnError(second)(error)

			expect(first.report).toHaveBeenCalledOnce()
			expect(second.report).toHaveBeenCalledOnce()
		})

		it('contains hostile diagnostic metadata getters', () => {
			const errors = {report: vi.fn()}
			const getter = vi.fn(() => { throw new Error('hostile getter') })
			const extra = Object.defineProperty({}, 'secret', {
				enumerable: true,
				get: getter
			})

			expect(() => createStageOnError(errors)(new Error('failure'), extra)).not.toThrow()
			expect(errors.report).toHaveBeenCalledWith(expect.any(Object), {
				source: 'logging', stage: 'logging'
			})
			expect(getter).not.toHaveBeenCalled()
		})

		it('redacts secret-bearing failures before crossing the Errors port', () => {
			const report = vi.fn()
			const onError = createStageOnError({report})

			onError(new Error(
				'password=observer-secret callback=https://user:pass@example.com/path?token=url-secret'
			))

			const normalized = report.mock.calls[0]?.[0]
			const serialized = JSON.stringify(normalized)
			expect(serialized).not.toContain('observer-secret')
			expect(serialized).not.toContain('url-secret')
			expect(normalized).toMatchObject({kind: 'Error', message: expect.stringContaining('[REDACTED]')})
			expect(normalized).not.toHaveProperty('stack')
		})

		it('contains an invalid runtime Errors dependency', () => {
			const onError = createStageOnError('invalid' as never)
			expect(() => onError(new Error('failure'))).not.toThrow()
		})

		it('should silently handle errors when errors service not provided', () => {
			const onError = createStageOnError()

			const error = new Error('test error')
			// Should not throw when no errors service is provided
			expect(() => onError(error, {stage: 'enriching'})).not.toThrow()
		})

		it('should handle non-object errors', () => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const onError = createStageOnError(mockErrors)

			// Non-object errors should still be reported (no recursion guard)
			onError('string error')
			onError('string error') // Should be called twice

			expect(mockErrors.report).toHaveBeenCalledTimes(2)
		})

		it('should handle null errors', () => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const onError = createStageOnError(mockErrors)

			// Null should be handled gracefully
			expect(() => onError(null)).not.toThrow()
		})

		it('should silently handle errors when errors service not provided (no registry lookup)', () => {
			const onError = createStageOnError()

			const error = new Error('test error')
			// Should not throw when no errors service is provided
			expect(() => onError(error, {stage: 'enriching'})).not.toThrow()
		})
	})
})
