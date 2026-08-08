/**
 * @file Tests for performance error reporter utility.
 */

import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi, beforeEach} from 'vitest'

import {createPerformanceOnError} from '../../../src/performance/utils/on-error'

describe('createPerformanceOnError', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('should return no-op function when no errors service provided', () => {
		const onError = createPerformanceOnError()
		expect(() => onError(new Error('test'))).not.toThrow()
	})

	it('should call errors.report when errors service is provided', () => {
		const mockErrors: Errors = {
			report: vi.fn()
		}
		const onError = createPerformanceOnError(mockErrors)

		const error = new Error('test error')
		onError(error)

		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'test error'
			}),
			expect.any(Object) // Context may be empty or have stage
		)
	})

	it('bounds unresolved error reports and resumes after settlement', async() => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => { release = resolve })
		const report = vi.fn(() => pending)
		const onError = createPerformanceOnError({report} as never)

		for (let index = 0; index < 1_000; index += 1) onError(new Error(`failure-${index}`))
		expect(report).toHaveBeenCalledOnce()

		release()
		await pending
		await Promise.resolve()
		onError(new Error('after-settlement'))
		expect(report).toHaveBeenCalledTimes(2)
	})

	it('blocks synchronous reporter re-entry before invoking external code', () => {
		let onError!: ReturnType<typeof createPerformanceOnError>
		const report = vi.fn(() => onError(new Error('recursive failure')))
		onError = createPerformanceOnError({report} as never)

		expect(() => onError(new Error('initial failure'))).not.toThrow()
		expect(report).toHaveBeenCalledOnce()
	})

	it('should merge fixed context with extra context', () => {
		const mockErrors: Errors = {
			report: vi.fn()
		}
		const fixedContext = {operation: 'monitor', component: 'gc-monitor'}
		const onError = createPerformanceOnError(mockErrors, fixedContext)

		const error = new Error('test error')
		const extraContext = {monitor: 'event-loop', threshold: '100ms'}
		onError(error, extraContext)

		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'test error'
			}),
			{
				source: 'performance',
				stage: 'performance',
				operation: 'monitor',
				component: 'gc-monitor',
				monitor: 'event-loop',
				threshold: '100ms'
			}
		)
	})

	it('should handle extra context overriding fixed context', () => {
		const mockErrors: Errors = {
			report: vi.fn()
		}
		const fixedContext = {operation: 'monitor', component: 'gc-monitor'}
		const onError = createPerformanceOnError(mockErrors, fixedContext)

		const error = new Error('test error')
		const extraContext = {operation: 'module-load', component: 'resource-monitor'}
		onError(error, extraContext)

		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'test error'
			}),
			{
				source: 'performance',
				stage: 'performance',
				operation: 'module-load', // Should be overridden
				component: 'resource-monitor' // Should be overridden
			}
		)
	})

	it('should handle errors in error reporting silently', () => {
		const mockErrors: Errors = {
			report: vi.fn().mockImplementation(() => {
				throw new Error('Report failed')
			})
		}
		const onError = createPerformanceOnError(mockErrors)

		// Should not throw even if errors.report throws
		expect(() => onError(new Error('test error'))).not.toThrow()
	})

	it('should normalize different error types', () => {
		const mockErrors: Errors = {
			report: vi.fn()
		}
		const onError = createPerformanceOnError(mockErrors)

		// Test with string error
		onError('string error')
		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'UnknownError',
				message: 'string error'
			}),
			expect.any(Object)
		)

		// Test with object error
		const objectError = {message: 'object error', name: 'CustomError'}
		onError(objectError)
		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'CustomError',
				message: 'object error'
			}),
			expect.any(Object)
		)

		// Test with Error instance
		const errorInstance = new Error('instance error')
		onError(errorInstance)
		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'instance error'
			}),
			expect.any(Object)
		)
	})

	it('should handle undefined extra context', () => {
		const mockErrors: Errors = {
			report: vi.fn()
		}
		const fixedContext = {operation: 'measure'}
		const onError = createPerformanceOnError(mockErrors, fixedContext)

		const error = new Error('test error')
		onError(error, undefined)

		expect(mockErrors.report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'test error'
			}),
			{source: 'performance', stage: 'performance', operation: 'measure'}
		)
	})

	it('should report a reused error again after synchronous ownership is released', () => {
		const mockErrors: Errors = {
			report: vi.fn()
		}
		const onError = createPerformanceOnError(mockErrors)

		const error = new Error('test error')

		// First call should report
		onError(error)
		expect(mockErrors.report).toHaveBeenCalledTimes(1)

		// A later incident may legitimately reuse the same Error instance. Only
		// synchronous re-entry while report() owns it is suppressed by core.
		onError(error)
		expect(mockErrors.report).toHaveBeenCalledTimes(2)
	})

	it('should silently handle errors when errors service not provided (no registry lookup)', () => {
		const onError = createPerformanceOnError()

		const error = new Error('test error')
		// Should not throw when no errors service is provided
		expect(() => onError(error, {operation: 'module-load'})).not.toThrow()
	})
})
