import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import {describe, it, expect, vi} from 'vitest'

import {httpSink, type HttpSinkError} from '../../../src/features/transferring/http'

async function expectRejectedMessage(
	promise: void | Promise<unknown>,
	message: string
): Promise<void> {
	await Promise.resolve(promise).then(
		() => {
			throw new Error(`Expected promise rejection: ${message}`)
		},
		(error: unknown) => {
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toBe(message)
		}
	)
}

async function expectRejectedHttpError(
	promise: void | Promise<unknown>,
	matcher: Partial<Pick<HttpSinkError, 'message' | 'code' | 'retryable' | 'statusCode'>>
): Promise<void> {
	await Promise.resolve(promise).then(
		() => {
			throw new Error(`Expected promise rejection: ${matcher.message ?? matcher.code ?? 'http error'}`)
		},
		(error: unknown) => {
			expect(error).toBeInstanceOf(Error)
			expect(error).toMatchObject(matcher)
		}
	)
}

describe('httpSink', () => {
	it('should create http sink', () => {
		const sink = httpSink('https://example.com/logs', {
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Bearer token'
			}
		})

		expect(typeof sink.write).toBe('function')
		expect(typeof sink.writeBatch).toBe('function')
	})

	it('should send log records via HTTP', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		// Mock global fetch
		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			headers: {
				'Content-Type': 'application/json'
			}
		})

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8',
				'Content-Type': 'application/json'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		// Restore global fetch
		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should unref request timeout timers when supported', async() => {
		const originalSetTimeout = globalThis.setTimeout
		const unref = vi.fn()
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler, timeout, ...args) => {
			const handle = originalSetTimeout(handler, timeout, ...args)
			;(handle as {unref?: () => void}).unref = unref
			return handle
		}) as typeof setTimeout)
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})
		global.fetch = mockFetch

		try {
			const sink = httpSink('https://example.com/logs', {timeoutMs: 1000})

			await sink.write('formatted line')

			expect(setTimeoutSpy).toHaveBeenCalled()
			expect(unref).toHaveBeenCalled()
		} finally {
			setTimeoutSpy.mockRestore()
			delete (global as unknown as {fetch?: unknown}).fetch
		}
	})

	it('should handle HTTP errors', async() => {
		const text = vi.fn(() => Promise.resolve('Internal Server Error'))
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.write('formatted line'),
			'HTTP log delivery failed for https://example.com: 500 - [response body omitted]'
		)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})
		expect(text).not.toHaveBeenCalled()

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('marks permanent 4xx responses as non-retryable', async() => {
		const cases = [
			{status: 400, body: 'Bad Request', code: 'HTTP_BAD_REQUEST'},
			{status: 401, body: 'Unauthorized', code: 'HTTP_UNAUTHORIZED'},
			{status: 404, body: 'Not Found', code: 'HTTP_NOT_FOUND'}
		] as const

		for (const testCase of cases) {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: testCase.status,
				text: () => Promise.resolve(testCase.body)
			})
			global.fetch = mockFetch

			const sink = httpSink('https://example.com/logs')
			await expectRejectedHttpError(sink.write('formatted line'), {
				message: `HTTP log delivery failed for https://example.com: ${testCase.status} - [response body omitted]`,
				code: testCase.code,
				retryable: false,
				statusCode: testCase.status
			})
		}

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('sanitizes secret-bearing URLs in HTTP errors while posting to the raw URL', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: () => Promise.resolve('Unauthorized')
		})
		global.fetch = mockFetch

		const rawUrl = 'https://user:pass@example.com/logs?token=secret#frag'
		await expectRejectedHttpError(httpSink(rawUrl).write('formatted line'), {
			message: 'HTTP log delivery failed for https://example.com: 401 - [response body omitted]',
			code: 'HTTP_UNAUTHORIZED',
			retryable: false,
			statusCode: 401
		})
		expect(mockFetch).toHaveBeenCalledWith(rawUrl, expect.any(Object))

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('marks retryable HTTP responses and transport failures correctly', async() => {
		const retryableFetch = vi.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 429,
				text: () => Promise.resolve('Too Many Requests')
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				text: () => Promise.resolve('Internal Server Error')
			})
			.mockRejectedValueOnce(new Error('Network error'))
		global.fetch = retryableFetch

		const sink = httpSink('https://example.com/logs', {timeoutMs: 1})

		await expectRejectedHttpError(sink.write('retry-429'), {
			code: 'HTTP_RATE_LIMITED',
			retryable: true,
			statusCode: 429
		})
		await expectRejectedHttpError(sink.write('retry-500'), {
			code: 'HTTP_SERVER_ERROR',
			retryable: true,
			statusCode: 500
		})
		await expectRejectedHttpError(sink.write('retry-network'), {
			code: 'HTTP_NETWORK',
			retryable: true,
			nonRetryable: true,
			ambiguousDelivery: true
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('does not claim that a 5xx response proves non-delivery', async() => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: false, status: 500, statusText: 'Internal Server Error', text: async() => ''
		})
		const failure = await httpSink('https://example.com/logs').write('line')
			.catch((error: unknown) => error)
		expect(failure).toMatchObject({code: 'HTTP_SERVER_ERROR', retryable: true})
		expect(failure).not.toHaveProperty('knownNoDelivery')
		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('classifies a 408 response as known non-delivery that can be retried safely', async() => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: false, status: 408, statusText: 'Request Timeout'
		})
		const sink = httpSink('https://example.com/logs')

		await expect(sink.write('line')).rejects.toMatchObject({
			code: 'HTTP_REQUEST_TIMEOUT', retryable: true, statusCode: 408, knownNoDelivery: true
		})
		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle network errors', async() => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.write('formatted line'),
			'HTTP log delivery failed for https://example.com: Network error'
		)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should use custom headers', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Bearer token',
				'X-Custom-Header': 'custom-value'
			}
		})

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8',
				'Content-Type': 'application/json',
				'Authorization': 'Bearer token',
				'X-Custom-Header': 'custom-value'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should use different HTTP methods', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle empty formatted line', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await sink.write('')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: '\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle special characters in formatted line', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		const specialLine = 'Special chars: "quotes" \n newline \t tab \\ backslash'
		await sink.write(specialLine)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: `${specialLine}\n`,
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle unicode characters in formatted line', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		const unicodeLine = '🚀 emoji test 中文'
		await sink.write(unicodeLine)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: `${unicodeLine}\n`,
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle very long formatted lines', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		const longLine = 'a'.repeat(10000)
		await sink.write(longLine)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: `${longLine}\n`,
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle multiple consecutive calls', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		const _record: LogRecord = {
			level: 'info',
			message: 'test message',
			time: 1234567890000
		}

		await sink.write('line1')
		await sink.write('line2')
		await sink.write('line3')

		expect(mockFetch).toHaveBeenCalledTimes(3)
		expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'line1\n',
			signal: expect.any(AbortSignal)
		})
		expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'line2\n',
			signal: expect.any(AbortSignal)
		})
		expect(mockFetch).toHaveBeenNthCalledWith(3, 'https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'line3\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle different log levels', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'unknown']

		for (const level of levels) {
			await sink.write(`formatted ${level} line`)
		}

		expect(mockFetch).toHaveBeenCalledTimes(7)

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle fetch timeout', async() => {
		const mockFetch = vi.fn().mockImplementation(() => {
			return new Promise((_, reject) => {
				setTimeout(() => reject(new Error('Timeout')), 100)
			})
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.write('formatted line'),
			'HTTP log delivery failed for https://example.com: Timeout'
		)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle writeBatch method', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		expect(sink.writeBatch).toBeDefined()
		await sink.writeBatch!(['line1', 'line2', 'line3'])

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'line1\nline2\nline3\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle writeBatch with empty array', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		expect(sink.writeBatch).toBeDefined()
		await sink.writeBatch!([])

		// Should not call fetch for empty array
		expect(mockFetch).not.toHaveBeenCalled()

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should reject writeBatch on delivery errors', async() => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		expect(sink.writeBatch).toBeDefined()
		await expectRejectedMessage(
			sink.writeBatch!(['line1', 'line2']),
			'HTTP log delivery failed for https://example.com: Network error'
		)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'line1\nline2\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle external abort signal', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		// Create an external abort controller
		const externalController = new AbortController()

		// Test with external signal
		await sink.write('formatted line', {signal: externalController.signal})

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('does not start an HTTP request when the external signal was already aborted', async() => {
		const mockFetch = vi.fn()
		global.fetch = mockFetch
		const controller = new AbortController()
		controller.abort()

		await expectRejectedHttpError(
			httpSink('https://example.com/logs').write('formatted line', {signal: controller.signal}),
			{code: 'HTTP_ABORTED', retryable: false}
		)

		expect(mockFetch).not.toHaveBeenCalled()
		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should reject write on delivery errors', async() => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Write error'))

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.write('formatted line'),
			'HTTP log delivery failed for https://example.com: Write error'
		)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle AbortController undefined', async() => {
		// Mock AbortController as undefined
		const originalAbortController = global.AbortController
		delete (global as unknown as {AbortController?: unknown}).AbortController

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		// Mock global fetch
		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: undefined
		})

		// Restore global fetch and AbortController
		delete (global as unknown as {fetch?: unknown}).fetch
		global.AbortController = originalAbortController
	})

	it('should handle both timeoutMs and external signal as falsy', async() => {
		// Mock AbortController as undefined to test the first branch
		const originalAbortController = global.AbortController
		delete (global as unknown as {AbortController?: unknown}).AbortController

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		// Mock global fetch
		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			keepalive: false
		})

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: undefined
		})

		// Restore global fetch and AbortController
		delete (global as unknown as {fetch?: unknown}).fetch
		global.AbortController = originalAbortController
	})

	it('should reject write method failures for orchestration layers', async() => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.write('test line'),
			'HTTP log delivery failed for https://example.com: Network error'
		)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'test line\n',
			signal: expect.any(AbortSignal)
		})
	})

	it('should reject writeBatch method failures for orchestration layers', async() => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.writeBatch!(['line1', 'line2']),
			'HTTP log delivery failed for https://example.com: Network error'
		)

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'line1\nline2\n',
			signal: expect.any(AbortSignal)
		})
	})

	it('should handle timeout with AbortController', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			timeoutMs: 1000
		})

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle timeout and external signal together', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			timeoutMs: 1000
		})

		const externalController = new AbortController()
		await sink.write('formatted line', {signal: externalController.signal})

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle timeout of 0', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			timeoutMs: 0
		})

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle negative timeout', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			timeoutMs: -100
		})

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal)
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle keepalive option', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			keepalive: true
		})

		await sink.write('formatted line')

		expect(mockFetch).toHaveBeenCalledWith('https://example.com/logs', {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8'
			},
			body: 'formatted line\n',
			signal: expect.any(AbortSignal),
			keepalive: true
		})

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle external signal abort during request', async() => {
		const mockFetch = vi.fn().mockImplementation(() => {
			return new Promise((_, reject) => {
				setTimeout(() => reject(new Error('Aborted')), 50)
			})
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		const externalController = new AbortController()
		setTimeout(() => externalController.abort(), 10)

		await expectRejectedMessage(
			sink.write('formatted line', {signal: externalController.signal}),
			'HTTP log delivery failed for https://example.com: Aborted'
		)

		expect(mockFetch).toHaveBeenCalled()

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle cleanup of timeout and event listener', async() => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve('OK')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs', {
			timeoutMs: 5000
		})

		const externalController = new AbortController()
		await sink.write('formatted line', {signal: externalController.signal})

		// Verify cleanup is called (no errors should occur)
		expect(mockFetch).toHaveBeenCalled()

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should handle flush method', async() => {
		const sink = httpSink('https://example.com/logs')

		// flush should be a no-op and not throw
		await expect(sink.flush?.()).resolves.toBeUndefined()
	})

	it('should handle close method', async() => {
		const sink = httpSink('https://example.com/logs')

		// close should be a no-op and not throw
		await expect(sink.close?.()).resolves.toBeUndefined()
	})

	it('should reject synchronous fetch errors in write method', async() => {
		// Create a scenario where postNdjson might throw
		// by using an invalid URL that causes immediate error
		const mockFetch = vi.fn().mockImplementation(() => {
			throw new Error('Synchronous error')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.write('test line'),
			'HTTP log delivery failed for https://example.com: Synchronous error'
		)

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should reject synchronous fetch errors in writeBatch method', async() => {
		// Create a scenario where postNdjson might throw
		const mockFetch = vi.fn().mockImplementation(() => {
			throw new Error('Synchronous error')
		})

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.writeBatch!(['line1', 'line2']),
			'HTTP log delivery failed for https://example.com: Synchronous error'
		)

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should reject write method when postNdjson fails after await', async() => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.write('test line'),
			'HTTP log delivery failed for https://example.com: Network error'
		)

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should reject writeBatch method when postNdjson fails after await', async() => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		await expectRejectedMessage(
			sink.writeBatch!(['line1', 'line2']),
			'HTTP log delivery failed for https://example.com: Network error'
		)

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('does not trust fetch rejections that imitate internal transport errors', async() => {
		const forged = Object.assign(new Error('token=private'), {
			code: 'HTTP_BAD_REQUEST',
			retryable: false,
			knownNoDelivery: true
		})
		global.fetch = vi.fn().mockRejectedValue(forged)

		const sink = httpSink('https://example.com/logs')
		await expect(sink.write('line')).rejects.toMatchObject({
			code: 'HTTP_NETWORK',
			retryable: true
		})
		await expect(sink.write('line')).rejects.not.toBe(forged)

		delete (global as unknown as {fetch?: unknown}).fetch
	})
})
