import {describe, expect, it, vi} from 'vitest'

import {classifyFetchFailure, classifyHttpStatus, createPerformanceExportError, getPerformanceExportErrorMetadata, isPerformanceExportError} from '../../../src/performance/core/export-errors'

describe('performance export errors', () => {
	it('creates and identifies typed export errors with optional fields', () => {
		const cause = new Error('cause')
		const error = createPerformanceExportError('failed', {retryable: false, code: 'bad', statusCode: 400, cause})
		expect(isPerformanceExportError(error)).toBe(true)
		expect(error).toMatchObject({message: 'failed', retryable: false, code: 'bad', statusCode: 400, cause})
		expect(isPerformanceExportError(new Error('plain'))).toBe(false)
		expect(createPerformanceExportError('falsy cause', {
			retryable: true, code: 'test', cause: 0
		})).toHaveProperty('cause', 0)
		const getter = vi.fn(() => true)
		const hostile = Object.defineProperty(new Error('hostile'), 'retryable', {get: getter})
		expect(isPerformanceExportError(hostile)).toBe(false)
		expect(getter).not.toHaveBeenCalled()
		const getPrototypeOf = vi.fn(() => { throw new Error('prototype trap') })
		const proxy = new Proxy({}, {getPrototypeOf})
		expect(getPerformanceExportErrorMetadata(proxy)).toBeUndefined()
		expect(getPrototypeOf).not.toHaveBeenCalled()
		const inheritedTrap = vi.fn(() => { throw new Error('prototype trap') })
		const inheritedProxy = Object.create(new Proxy({}, {getPrototypeOf: inheritedTrap}))
		expect(getPerformanceExportErrorMetadata(inheritedProxy)).toBeUndefined()
		expect(inheritedTrap).not.toHaveBeenCalled()
	})

	it.each([
		[429, true, 'http_rate_limited'],
		[500, true, 'http_server_error'],
		[400, false, 'http_client_error'],
		[200, false, 'http_unexpected_status']
	])('classifies HTTP status %s', (status, retryable, code) => {
		expect(classifyHttpStatus(status)).toEqual({retryable, code})
	})

	it('classifies typed, abort, Error, and unknown fetch failures', () => {
		const typed = createPerformanceExportError('typed', {retryable: false, code: 'typed'})
		expect(classifyFetchFailure(typed)).toBe(typed)
		const abort = new DOMException('', 'AbortError')
		expect(classifyFetchFailure(abort)).toMatchObject({retryable: true, code: 'fetch_aborted'})
		expect(classifyFetchFailure(new Error('offline'))).toMatchObject({message: 'offline', code: 'fetch_failed'})
		expect(classifyFetchFailure('offline')).toMatchObject({message: 'offline', code: 'fetch_failed'})
		const coercion = vi.fn(() => 'secret diagnostic')
		const hostile = Object.create(null) as {toString?: () => string}
		Object.defineProperty(hostile, 'toString', {value: coercion})
		expect(classifyFetchFailure(hostile)).toMatchObject({message: 'Performance export failed', code: 'fetch_failed'})
		expect(coercion).not.toHaveBeenCalled()
		const getPrototypeOf = vi.fn(() => { throw new Error('prototype trap') })
		const proxy = new Proxy({}, {getPrototypeOf})
		expect(classifyFetchFailure(proxy)).toMatchObject({message: 'Performance export failed', code: 'fetch_failed'})
		expect(getPrototypeOf).not.toHaveBeenCalled()
		const inheritedTrap = vi.fn(() => { throw new Error('prototype trap') })
		const inheritedProxy = Object.create(new Proxy({}, {getPrototypeOf: inheritedTrap}))
		expect(classifyFetchFailure(inheritedProxy)).toMatchObject({message: 'Performance export failed', code: 'fetch_failed'})
		expect(inheritedTrap).not.toHaveBeenCalled()
	})
})
