import {afterEach, describe, expect, it, vi} from 'vitest'

import {createSentryErrorSink} from '../../../src/sentry'

describe('createSentryErrorSink', () => {
	it('rejects oversized DSNs before URL parsing or retention', () => {
		expect(() => createSentryErrorSink({
			dsn: `https://public@example.com/${'x'.repeat(4_096)}`
		})).toThrow('invalid Sentry DSN')
	})
	afterEach(() => vi.unstubAllGlobals())

	it('validates the DSN', () => {
		expect(() => createSentryErrorSink(null as never)).toThrow('invalid configuration')
		expect(() => createSentryErrorSink({dsn: 'not-a-dsn'})).toThrow('invalid Sentry DSN')
		expect(() => createSentryErrorSink({dsn: 'http://public@example.ingest.sentry.io/42'})).toThrow('invalid Sentry DSN')
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 0
		})).toThrow('requestTimeoutMs')
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: Number.NaN
		})).toThrow('requestTimeoutMs')
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', typo: true
		} as never)).toThrow('invalid configuration')
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', tags: 'invalid'
		} as never)).toThrow('tags must be an object')
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', environment: ''
		})).toThrow('environment')
		const getter = vi.fn(() => 'production')
		const accessorConfig = {dsn: 'https://public@example.ingest.sentry.io/42'} as Record<string, unknown>
		Object.defineProperty(accessorConfig, 'environment', {enumerable: true, get: getter})
		expect(() => createSentryErrorSink(accessorConfig as never)).toThrow('invalid configuration')
		expect(getter).not.toHaveBeenCalled()
	})

	it('sends a redacted envelope once', async() => {
		const fetch = vi.fn().mockResolvedValue({ok: true, status: 200})
		vi.stubGlobal('fetch', fetch)
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})

		await sink.capture({
			kind: 'Error',
			message: 'token=secret-value',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1,
			context: {email: 'person@example.com'}
		})

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain('secret-value')
		expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain('person@example.com')
	})

	it('does not follow late mutation of the global transport capabilities', async() => {
		const initialFetch = vi.fn().mockResolvedValue({ok: true, status: 200})
		const replacementFetch = vi.fn().mockResolvedValue({ok: true, status: 200})
		const InitialAbortController = globalThis.AbortController
		vi.stubGlobal('fetch', initialFetch)
		const sink = createSentryErrorSink({dsn: 'https://public@example.com/1'})
		vi.stubGlobal('fetch', replacementFetch)
		vi.stubGlobal('AbortController', class {
			constructor() { throw new Error('late replacement must not run') }
		})

		await expect(sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})).resolves.toBeUndefined()
		expect(initialFetch).toHaveBeenCalledOnce()
		expect(replacementFetch).not.toHaveBeenCalled()
		expect(InitialAbortController).toBeTypeOf('function')
	})

	it('supports self-materializing runtime capability accessors', async() => {
		const InitialAbortController = globalThis.AbortController
		const fetch = vi.fn().mockResolvedValue({ok: true, status: 200})
		vi.stubGlobal('fetch', fetch)
		Object.defineProperty(globalThis, 'AbortController', {
			configurable: true,
			get() {
				Object.defineProperty(globalThis, 'AbortController', {
					configurable: true, writable: true, value: InitialAbortController
				})
				return InitialAbortController
			}
		})
		try {
			const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
			await expect(sink.capture({
				kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
			})).resolves.toBeUndefined()
			expect(fetch).toHaveBeenCalledOnce()
		} finally {
			Object.defineProperty(globalThis, 'AbortController', {
				configurable: true, writable: true, value: InitialAbortController
			})
		}
	})

	it('unrefs the request timeout when the runtime supports it', async() => {
		const originalSetTimeout = globalThis.setTimeout
		const unref = vi.fn()
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler, timeout, ...args) => {
			const handle = originalSetTimeout(handler, timeout, ...args)
			;(handle as {unref?: () => void}).unref = unref
			return handle
		}) as typeof setTimeout)
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200}))

		try {
			const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
			await sink.capture({kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1})
			expect(unref).toHaveBeenCalledTimes(1)
		} finally {
			setTimeoutSpy.mockRestore()
		}
	})

	it('does not expose retry metadata for failed delivery', async() => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			ok: false, status: 503, statusText: 'remote token=response-secret'
		}))
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
		const failure = await sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		}).catch((error) => error)

		expect(failure).toMatchObject({statusCode: 503, code: 'SENTRY_RESPONSE_ERROR'})
		expect(failure.message).toBe('Sentry error sink failed with status 503')
		expect(failure.message).not.toContain('response-secret')
		expect(failure).not.toHaveProperty('retryable')
	})

	it('wraps network failures without leaking diagnostics', async() => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('token=network-secret')))
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
		await expect(sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})).rejects.toMatchObject({code: 'SENTRY_NETWORK_ERROR', message: 'Sentry error sink network failure'})
	})

	it('sanitizes AbortController construction failures', async() => {
		vi.stubGlobal('AbortController', class {
			constructor() { throw new Error('token=controller-secret') }
		})
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
		await expect(sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})).rejects.toMatchObject({
			code: 'SENTRY_NETWORK_ERROR', message: 'Sentry error sink network failure'
		})
	})

	it('sanitizes hostile AbortSignal access failures', async() => {
		vi.stubGlobal('AbortController', class {
			get signal(): never { throw new Error('token=signal-secret') }
		})
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
		await expect(sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})).rejects.toMatchObject({
			code: 'SENTRY_NETWORK_ERROR', message: 'Sentry error sink network failure'
		})
	})

	it('safely wraps hostile non-Error fetch rejections', async() => {
		const rejection = new Proxy({}, {
			getPrototypeOf() { throw new Error('prototype trap must not escape') }
		})
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(rejection))
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
		await expect(sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})).rejects.toMatchObject({code: 'SENTRY_NETWORK_ERROR', message: 'Sentry error sink network failure'})
	})

	it('does not stringify hostile response status values', async() => {
		const stringify = vi.fn(() => 'status token=response-secret')
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			ok: false, status: {toString: stringify}
		}))
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
		await expect(sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})).rejects.toMatchObject({
			code: 'SENTRY_RESPONSE_ERROR', statusCode: 0,
			message: 'Sentry error sink received an invalid response'
		})
		expect(stringify).not.toHaveBeenCalled()
	})

	it('rejects malformed fetch responses that claim success', async() => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 0}))
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})

		await expect(sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})).rejects.toMatchObject({
			code: 'SENTRY_RESPONSE_ERROR', statusCode: 0,
			message: 'Sentry error sink received an invalid response'
		})
	})

	it('reports request timeouts distinctly', async() => {
		vi.useFakeTimers()
		vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {
			// Deliberately ignore AbortSignal: the explicit deadline must still win.
		})))
		try {
			const sink = createSentryErrorSink({
				dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 1
			})
			const capture = sink.capture({
				kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
			})
			const expectation = expect(capture).rejects.toMatchObject({code: 'SENTRY_REQUEST_TIMEOUT'})
			await vi.advanceTimersByTimeAsync(1)
			await expectation
		} finally {
			vi.useRealTimers()
		}
	})

	it('disposes response bodies that arrive after the request deadline', async() => {
		vi.useFakeTimers()
		let resolveRequest!: (response: Response) => void
		const cancel = vi.fn(async() => undefined)
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
			resolveRequest = resolve
		})))
		try {
			const sink = createSentryErrorSink({
				dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 1
			})
			const capture = sink.capture({
				kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
			})
			await vi.advanceTimersByTimeAsync(1)
			await expect(capture).rejects.toMatchObject({code: 'SENTRY_REQUEST_TIMEOUT'})

			resolveRequest({ok: true, status: 202, body: {cancel}} as never)
			await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
		} finally {
			vi.useRealTimers()
		}
	})

	it('detaches timed-out raw requests so flush and close remain bounded', async() => {
		vi.useFakeTimers()
		vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
		try {
			const sink = createSentryErrorSink({
				dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 1
			})
			const capture = sink.capture({
				kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
			})
			await vi.advanceTimersByTimeAsync(1)
			await expect(capture).rejects.toMatchObject({code: 'SENTRY_REQUEST_TIMEOUT'})

			await expect(sink.flush?.()).resolves.toBeUndefined()
			await expect(sink.close?.()).resolves.toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it('drains in-flight captures and closes admission idempotently', async() => {
		let resolveFetch!: (response: {ok: true; status: 200}) => void
		vi.stubGlobal('fetch', vi.fn(() => new Promise<{ok: true; status: 200}>((resolve) => {
			resolveFetch = resolve
		})))
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
		const capture = sink.capture({
			kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})
		const flush = sink.flush?.()
		const close = sink.close?.()
		await expect(sink.capture({
			kind: 'Error', message: 'late', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})).rejects.toMatchObject({code: 'SENTRY_SINK_CLOSED'})
		resolveFetch({ok: true, status: 200})
		await Promise.all([capture, flush, close])
		await expect(sink.close?.()).resolves.toBeUndefined()
	})

	it('flush snapshots captures accepted before the flush call', async() => {
		const resolvers: Array<(response: {ok: true; status: 200}) => void> = []
		vi.stubGlobal('fetch', vi.fn(() => new Promise<{ok: true; status: 200}>((resolve) => {
			resolvers.push(resolve)
		})))
		const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
		const first = sink.capture({
			kind: 'Error', message: 'first', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})
		const flush = sink.flush?.()
		const second = sink.capture({
			kind: 'Error', message: 'second', severity: 'error', category: 'UNKNOWN', timestamp: 1
		})

		await Promise.resolve()
		resolvers[0]?.({ok: true, status: 200})
		await expect(flush).resolves.toBeUndefined()
		resolvers[1]?.({ok: true, status: 200})
		await Promise.all([first, second])
		await sink.close?.()
	})
})
