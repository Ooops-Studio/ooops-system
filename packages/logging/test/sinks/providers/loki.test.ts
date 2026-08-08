import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createLoggingSink} from '../../../src/sinks'
import {createLokiLoggingSink} from '../../../src/sinks/providers/loki'

const ORIGINAL_FETCH = globalThis.fetch

describe('loki logging sink', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH
	})

	it('validates required provider configuration', async() => {
		await expect(createLoggingSink({provider: 'loki', url: ''})).rejects.toThrow(
			'createLoggingSink: loki url is required'
		)
	})

	it('posts Loki push payloads with grouped low-cardinality labels', async() => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 204,
			statusText: 'No Content',
			text: async() => ''
		})
		globalThis.fetch = fetchMock as typeof fetch

		const sink = createLokiLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com',
			headers: {'X-Scope-OrgID': 'flop'},
			defaultLabels: {deployment: 'prod'}
		})

		await sink.writeBatch?.([
			JSON.stringify({
				time: 1710000000000,
				level: 'info',
				message: 'http.request_completed',
				namespace: 'http',
				attributes: {
					app: 'flop',
					hostKind: 'studio',
					runtime: 'server',
					service: 'studio-app',
					requestId: 'req-1'
				}
			}),
			JSON.stringify({
				time: 1710000001000,
				level: 'info',
				message: 'http.request_completed',
				namespace: 'http',
				attributes: {
					app: 'flop',
					hostKind: 'studio',
					runtime: 'server',
					service: 'studio-app',
					requestId: 'req-2'
				}
			})
		])

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledWith(
			'https://logs.example.com/loki/api/v1/push',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'content-type': 'application/json',
					'X-Scope-OrgID': 'flop'
				})
			})
		)

		const request = fetchMock.mock.calls[0]?.[1] as {body?: string}
		const body = JSON.parse(String(request.body)) as {
			streams: Array<{stream: Record<string, string>, values: Array<[string, string]>}>
		}
		expect(body.streams).toHaveLength(1)
		expect(body.streams[0]?.stream).toEqual({
			app: 'flop',
			deployment: 'prod',
			hostKind: 'studio',
			level: 'info',
			namespace: 'http',
			runtime: 'server',
			service: 'studio-app'
		})
		expect(body.streams[0]?.values).toHaveLength(2)
		expect(body.streams[0]?.values[0]?.[0]).toBe('1710000000000000000')
		expect(body.streams[0]?.values[0]?.[1]).toContain('req-1')
	})

	it('unrefs request timeout timers when the runtime supports it', async() => {
		const originalSetTimeout: typeof setTimeout = globalThis.setTimeout
		const unref = vi.fn()
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler, timeout, ...args) => {
			const handle = originalSetTimeout(handler, timeout, ...args)
			;(handle as {unref?: () => void}).unref = unref
			return handle
		}) as typeof setTimeout)
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 204,
			statusText: 'No Content',
			text: async() => ''
		}) as typeof fetch
		try {
			const sink = createLokiLoggingSink({
				provider: 'loki',
				url: 'https://logs.example.com',
				requestTimeoutMs: 1000
			})

			await sink.write('plain log line')

			expect(unref).toHaveBeenCalled()
		} finally {
			setTimeoutSpy.mockRestore()
		}
	})

	it('fails clearly when Loki rejects the batch', async() => {
		const text = vi.fn(async() => 'bad credentials')
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
			text
		}) as typeof fetch

		const sink = createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})

		await expect(sink.write('plain log line')).rejects.toThrow(
			'Loki log delivery failed for https://logs.example.com: 401 Unauthorized - [response body omitted]'
		)
		await expect(sink.write('plain log line')).rejects.toMatchObject({
			code: 'LOKI_UNAUTHORIZED',
			retryable: false,
			statusCode: 401,
			knownNoDelivery: true
		})
		expect(text).not.toHaveBeenCalled()
	})

	it('treats Loki 5xx responses as ambiguous delivery', async() => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false, status: 503, statusText: 'Unavailable', text: async() => ''
		}) as typeof fetch
		const sink = createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})
		const failure = await sink.write('line').catch((error: unknown) => error)
		expect(failure).toMatchObject({
			code: 'LOKI_SERVER_ERROR', retryable: true, nonRetryable: true, ambiguousDelivery: true
		})
		expect(failure).not.toHaveProperty('knownNoDelivery')
	})

	it('sanitizes secret-bearing Loki URLs in errors while posting to the raw endpoint', async() => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			statusText: 'Bad Request',
			text: async() => 'bad'
		})
		globalThis.fetch = fetchMock as typeof fetch

		const sink = createLokiLoggingSink({
			provider: 'loki',
			url: 'https://user:pass@logs.example.com/custom?token=secret#frag'
		})

		await expect(sink.write('plain log line')).rejects.toMatchObject({
			message: 'Loki log delivery failed for https://logs.example.com: 400 Bad Request - [response body omitted]',
			code: 'LOKI_BAD_REQUEST',
			retryable: false,
			statusCode: 400,
			knownNoDelivery: true
		})
		expect(fetchMock).toHaveBeenCalledWith(
			'https://user:pass@logs.example.com/custom/loki/api/v1/push?token=secret',
			expect.any(Object)
		)
	})

	it('normalizes URLs, labels, plain lines, and body-read failures', async() => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			statusText: '',
			text: async() => {
				throw new Error('body read failed')
			}
		}) as typeof fetch

		const sink = createLokiLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com/custom/',
			defaultLabels: {
				'9invalid-key': 'value',
				blank: '   ',
				boolish: true
			}
		})

		await expect(sink.writeBatch?.([
			'plain line',
			JSON.stringify({
				time: 1710000002000,
				level: 'warn',
				namespace: 'ns',
				attributes: {
					app: 'flop',
					hostKind: 'studio-web',
					runtime: 'node',
					service: 123
				}
			})
		])).rejects.toThrow(
			'Loki log delivery failed for https://logs.example.com: 429'
		)
		await expect(sink.write('plain line')).rejects.toMatchObject({
			code: 'LOKI_RATE_LIMITED',
			retryable: true,
			statusCode: 429,
			knownNoDelivery: true
		})

		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://logs.example.com/custom/loki/api/v1/push',
			expect.any(Object)
		)
		const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body)) as {
			streams: Array<{stream: Record<string, string>, values: Array<[string, string]>}>
		}
		expect(body.streams.length).toBe(2)
		expect(body.streams.some((stream) => stream.stream._9invalid_key === 'value')).toBe(true)
		expect(body.streams.some((stream) => stream.stream.boolish === 'true')).toBe(true)
	})

	it('normalizes privacy-sensitive label values before stream grouping', async() => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 204,
			statusText: 'No Content',
			text: async() => ''
		})
		globalThis.fetch = fetchMock as typeof fetch

		const sink = createLokiLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com',
			defaultLabels: {
				tenant: 'acme-private-workspace-123',
				owner: 'user@example.com',
				callback: 'https://example.com/private?token=secret',
				token: 'short-secret',
				authorization: 'Basic dXNlcjpwYXNz',
				serviceAuth: 'service-auth-secret',
				passw0rd: 'leet-label-secret',
				'passwоrd': 'confusable-label-secret'
			}
		})

		await sink.write(JSON.stringify({
			time: 1710000003000,
			level: 'info',
			namespace: 'http',
			attributes: {
				app: 'flop',
				service: 'studio-app',
				hostKind: 'studio',
				runtime: 'server'
			}
		}))

		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			streams: Array<{stream: Record<string, string>}>
		}
		const labels = body.streams[0]?.stream ?? {}
		const encoded = JSON.stringify(labels)

		expect(labels.service).toBe('studio-app')
		expect(labels.runtime).toBe('server')
		expect(labels.owner).toBe('email')
		expect(labels.callback).toBe('url')
		expect(labels.token).toBe('redacted')
		expect(labels.authorization).toBe('redacted')
		expect(labels.serviceAuth).toBe('redacted')
		expect(labels.passw0rd).toBe('redacted')
		expect(labels.tenant).toBe('id')
		expect(encoded).not.toContain('user@example.com')
		expect(encoded).not.toContain('token=secret')
		expect(encoded).not.toContain('acme-private-workspace-123')
		expect(encoded).not.toContain('short-secret')
		expect(encoded).not.toContain('dXNlcjpwYXNz')
		expect(encoded).not.toContain('service-auth-secret')
		expect(encoded).not.toContain('leet-label-secret')
		expect(encoded).not.toContain('confusable-label-secret')
	})

	it('classifies a 408 response as known non-delivery that can be retried safely', async() => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false, status: 408, statusText: 'Request Timeout'
		}) as typeof fetch
		const sink = createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})

		await expect(sink.write('line')).rejects.toMatchObject({
			code: 'LOKI_REQUEST_TIMEOUT', retryable: true, statusCode: 408, knownNoDelivery: true
		})
	})

	it('redacts sensitive values embedded in label names', async() => {
		const fetchMock = vi.fn().mockResolvedValue({ok: true, status: 204, statusText: 'No Content'})
		globalThis.fetch = fetchMock as typeof fetch
		const sink = createLokiLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com',
			defaultLabels: {
				'password=loki-label-key-secret': 'safe',
				'token_customer-loki-label-key-secret': 'safe',
				'user_id_24680': 'safe',
				'owner@example.com': 'safe'
			}
		})

		await sink.write('{"time":1,"level":"info","message":"safe"}')
		const body = String(fetchMock.mock.calls[0]?.[1]?.body)

		expect(body).not.toContain('loki-label-key-secret')
		expect(body).not.toContain('24680')
		expect(body).not.toContain('owner@example.com')
		expect(body).toContain('_redacted_key_')
	})

	it('wraps transport failures and honors abort/keepalive options', async() => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
		globalThis.fetch = fetchMock as typeof fetch

		const sink = createLokiLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com/loki/api/v1/push',
			requestTimeoutMs: 250,
			keepalive: true
		})
		const controller = new AbortController()

		await expect(sink.write('plain line', {signal: controller.signal})).rejects.toThrow(
			'Loki log delivery failed for https://logs.example.com: network down'
		)

		expect(fetchMock).toHaveBeenCalledWith(
			'https://logs.example.com/loki/api/v1/push',
			expect.objectContaining({
				keepalive: true,
				signal: expect.any(AbortSignal)
			})
		)
	})

	it('does not start a request for an already-aborted signal', async() => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as typeof fetch
		const sink = createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})
		const controller = new AbortController()
		controller.abort()

		await expect(sink.write('plain line', {signal: controller.signal})).rejects.toMatchObject({
			code: 'LOKI_ABORTED',
			retryable: false
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not trust fetch rejections that imitate internal Loki errors', async() => {
		const forged = Object.assign(new Error('authorization=private'), {
			code: 'LOKI_BAD_REQUEST',
			retryable: false,
			knownNoDelivery: true
		})
		globalThis.fetch = vi.fn().mockRejectedValue(forged) as typeof fetch
		const sink = createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})

		await expect(sink.write('line')).rejects.toMatchObject({
			code: 'LOKI_NETWORK',
			retryable: true,
			nonRetryable: true,
			ambiguousDelivery: true
		})
		await expect(sink.write('line')).rejects.not.toBe(forged)
	})

	it('flush and close are safe no-ops', async() => {
		const sink = createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})
		await expect(sink.flush?.()).resolves.toBeUndefined()
		await expect(sink.close?.()).resolves.toBeUndefined()
	})
})
