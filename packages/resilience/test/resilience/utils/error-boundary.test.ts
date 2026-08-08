import {describe, expect, it, vi} from 'vitest'

import {
	createErrorBoundary,
	createSilentFailure
} from '../../../src/resilience/utils/error-boundary'

describe('error-boundary', () => {

	it('returns a silent no-op handler when no errors port exists', () => {

		const boundary = createErrorBoundary({
			serviceName: 'resilience',
			stage: 'retry'
		})

		expect(() => boundary(new Error('boom'))).not.toThrow()

	})

	it('normalizes and reports errors while swallowing reporter failures', async() => {

		const report = vi.fn()
		const boundary = createErrorBoundary({
			errors: {report},
			serviceName: 'resilience',
			stage: 'timeout'
		})

		boundary(new Error('boom'))
		boundary('string-error')

		expect(report).toHaveBeenNthCalledWith(1, expect.objectContaining({
			kind: 'Error',
			message: 'Resilience boundary captured an error'
		}), expect.objectContaining({
			service: 'resilience',
			stage: 'timeout',
			severity: 'error',
			error: expect.stringMatching(/^fp_/u)
		}))
		expect(report).toHaveBeenNthCalledWith(2, {
			kind: 'ResilienceOperationError',
			message: 'Resilience boundary captured an error'
		}, expect.objectContaining({error: expect.stringMatching(/^fp_/u)}))

		const throwingBoundary = createErrorBoundary({
			errors: {
				report: () => {
					throw new Error('report failed')
				}
			},
			serviceName: 'resilience',
			stage: 'bulkhead'
		})

		expect(() => throwingBoundary(new Error('boom'))).not.toThrow()

		const rejectedBoundary = createErrorBoundary({
			errors: {
				report: async() => {
					throw new Error('async report failed')
				}
			},
			serviceName: 'resilience',
			stage: 'async-report'
		})
		expect(() => rejectedBoundary(new Error('boom'))).not.toThrow()
		await Promise.resolve()

		await expect(createSilentFailure(async() => 'ok', {
			errors: {report},
			serviceName: 'resilience',
			stage: 'wrap'
		})).resolves.toBe('ok')

		await expect(createSilentFailure(async() => {
			throw new Error('silent-failure')
		}, {
			errors: {report},
			serviceName: 'resilience',
			stage: 'wrap'
		})).resolves.toBeUndefined()

	})

	it('normalizes anonymous and stackless errors without throwing', () => {

		const report = vi.fn()
		const boundary = createErrorBoundary({
			errors: {report},
			serviceName: 'resilience',
			stage: 'normalize'
		})

		const anonymous = new Error('anonymous boom')
		anonymous.name = ''
		anonymous.stack = ''

		expect(() => boundary(anonymous)).not.toThrow()
		expect(report).toHaveBeenCalledWith({
			kind: 'Error',
			message: 'Resilience boundary captured an error'
		}, expect.objectContaining({
			service: 'resilience',
			stage: 'normalize',
			severity: 'error',
			error: expect.stringMatching(/^fp_/u)
		}))

	})

	it('does not evaluate accessor-backed promise methods returned by reporters', () => {
		const catchGetter = vi.fn(() => () => undefined)
		const then = vi.fn()
		const hostile = Object.defineProperties({}, {catch: {get: catchGetter}, then: {value: then}})
		const boundary = createErrorBoundary({
			errors: {report: () => hostile} as never,
			serviceName: 'resilience',
			stage: 'hostile-return'
		})
		boundary(new Error('boom'))
		expect(catchGetter).not.toHaveBeenCalled()
		expect(then).not.toHaveBeenCalled()
	})

})
