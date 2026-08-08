import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi, beforeEach} from 'vitest'

import {withErrorBoundary, withAsyncErrorBoundary} from '../../../src/performance/utils/error-boundary'

describe('error-boundary', () => {

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('withErrorBoundary', () => {

		it('should execute function normally when no error', () => {

			const fn = vi.fn((x: number) => x * 2) as (...args: unknown[]) => unknown
			const wrapped = withErrorBoundary(fn)

			const result = wrapped(5)
			expect(result).toBe(10)
			expect(fn).toHaveBeenCalledWith(5)
		})

		it('should catch errors and report them', () => {

			const mockErrors: Errors = {
				report: vi.fn()
			}
			const fn = vi.fn(() => {
				throw new Error('test error')
			})
			const wrapped = withErrorBoundary(fn, mockErrors)

			const result = wrapped()
			expect(result).toBeUndefined()
			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('should include context in error report', () => {

			const mockReport = vi.fn()
			const mockErrors: Errors = {
				report: mockReport
			}
			const fn = vi.fn(() => {
				throw new Error('test error')
			})
			const wrapped = withErrorBoundary(fn, mockErrors, {operation: 'test', eventName: 'test.event'})

			wrapped()
			expect(mockReport).toHaveBeenCalled()
			const callArgs = mockReport.mock.calls[0]
			expect(callArgs).toBeDefined()
			if (callArgs) {
				expect(callArgs[0]).toMatchObject({
					kind: 'Error',
					message: 'test error'
				})
				expect(callArgs[1]).toMatchObject({
					stage: 'monitor',
					step: 'test'
				})
			}
		})

		it('should silently handle errors when errors not provided', () => {
			const fn = vi.fn(() => {
				throw new Error('test error')
			})
			const wrapped = withErrorBoundary(fn)

			// When errors is not provided, should silently handle errors
			// Function should not throw
			expect(() => wrapped()).not.toThrow()
		})

		it('should include default operation context', () => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const fn = vi.fn(() => {
				throw new Error('test error')
			})
			const wrapped = withErrorBoundary(fn, mockErrors)

			wrapped()
			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					stage: 'monitor'
				})
			)
		})

		it('should not throw when errors handler is not provided', () => {

			const fn = vi.fn(() => {
				throw new Error('test error')
			})
			const wrapped = withErrorBoundary(fn)

			expect(() => wrapped()).not.toThrow()
			expect(wrapped()).toBeUndefined()
		})

		it('should preserve function arguments', () => {

			const fn = vi.fn((a: number, b: string, c: boolean) => `${a}-${b}-${c}`) as (...args: unknown[]) => unknown
			const wrapped = withErrorBoundary(fn)

			const result = wrapped(1, 'test', true)
			expect(result).toBe('1-test-true')
			expect(fn).toHaveBeenCalledWith(1, 'test', true)
		})
	})

	describe('withAsyncErrorBoundary', () => {

		it('should execute async function normally when no error', async() => {

			const fn = vi.fn(async(x: number) => x * 2) as (...args: unknown[]) => Promise<unknown>
			const wrapped = withAsyncErrorBoundary(fn)

			const result = await wrapped(5)
			expect(result).toBe(10)
			expect(fn).toHaveBeenCalledWith(5)
		})

		it('should catch async errors and report them', async() => {

			const mockErrors: Errors = {
				report: vi.fn()
			}
			const fn = vi.fn(async() => {
				throw new Error('test error')
			})
			const wrapped = withAsyncErrorBoundary(fn, mockErrors)

			const result = await wrapped()
			expect(result).toBeUndefined()
			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('also catches synchronous throws from promise-typed functions', async() => {
			const mockErrors: Errors = {report: vi.fn()}
			const fn = (() => { throw new Error('sync failure') }) as () => Promise<unknown>
			const wrapped = withAsyncErrorBoundary(fn, mockErrors)
			await expect(wrapped()).resolves.toBeUndefined()
			expect(mockErrors.report).toHaveBeenCalled()
		})

		it('does not assimilate thenables returned by promise-typed functions', async() => {
			const readThen = vi.fn(() => { throw new Error('must not assimilate') })
			const fn = (() => Object.defineProperty({}, 'then', {get: readThen})) as never
			const wrapped = withAsyncErrorBoundary(fn)

			await expect(wrapped()).resolves.toBeUndefined()
			expect(readThen).not.toHaveBeenCalled()
		})

		it('should include context in error report', async() => {

			const mockReport = vi.fn()
			const mockErrors: Errors = {
				report: mockReport
			}
			const fn = vi.fn(async() => {
				throw new Error('test error')
			})
			const wrapped = withAsyncErrorBoundary(fn, mockErrors, {operation: 'test'})

			await wrapped()
			expect(mockReport).toHaveBeenCalled()
			const callArgs = mockReport.mock.calls[0]
			expect(callArgs).toBeDefined()
			if (callArgs) {
				expect(callArgs[0]).toMatchObject({
					kind: 'Error',
					message: 'test error'
				})
				expect(callArgs[1]).toMatchObject({
					stage: 'monitor',
					step: 'test'
				})
			}
		})

		it('should silently handle errors when errors not provided', async() => {
			const fn = vi.fn(async() => {
				throw new Error('test error')
			})
			const wrapped = withAsyncErrorBoundary(fn)

			// When errors is not provided, should silently handle errors
			// Function should not throw and should return undefined
			await expect(wrapped()).resolves.toBeUndefined()
		})

		it('should include default operation context', async() => {
			const mockErrors: Errors = {
				report: vi.fn()
			}
			const fn = vi.fn(async() => {
				throw new Error('test error')
			})
			const wrapped = withAsyncErrorBoundary(fn, mockErrors)

			await wrapped()
			expect(mockErrors.report).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					stage: 'monitor'
				})
			)
		})

		it('should not throw when errors handler is not provided', async() => {

			const fn = vi.fn(async() => {
				throw new Error('test error')
			})
			const wrapped = withAsyncErrorBoundary(fn)

			await expect(wrapped()).resolves.toBeUndefined()
		})

		it('should preserve function arguments', async() => {

			const fn = vi.fn(async(a: number, b: string) => `${a}-${b}`) as (...args: unknown[]) => Promise<unknown>
			const wrapped = withAsyncErrorBoundary(fn)

			const result = await wrapped(1, 'test')
			expect(result).toBe('1-test')
			expect(fn).toHaveBeenCalledWith(1, 'test')
		})
	})
})
