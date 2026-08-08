import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createLoggingSink} from '../src/sinks'
import {snapshotExternalLoggingSink} from '../src/sinks/external'

describe('logging sinks', () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('creates an HTTP logging sink from provider config', async() => {
		fetchMock.mockResolvedValue({ok: true})

		const sink = await createLoggingSink({
			provider: 'http',
			url: 'https://logs.example.com/ingest'
		})

		await sink.write('{"message":"hello"}')

		expect(fetchMock).toHaveBeenCalledWith(
			'https://logs.example.com/ingest',
			expect.objectContaining({method: 'POST'})
		)
	})

	it('creates a Loki logging sink from provider config', async() => {
		fetchMock.mockResolvedValue({ok: true})

		const sink = await createLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com'
		})

		await sink.write('{"time":1,"level":"info","message":"hello","attributes":{"app":"test"}}')

		expect(fetchMock).toHaveBeenCalledWith(
			'https://logs.example.com/loki/api/v1/push',
			expect.objectContaining({method: 'POST'})
		)
	})

	it('rejects empty provider urls', async() => {
		await expect(createLoggingSink({
			provider: 'http',
			url: '   '
		})).rejects.toThrow('createLoggingSink: http url is required')

		await expect(createLoggingSink({
			provider: 'loki',
			url: '   '
		})).rejects.toThrow('createLoggingSink: loki url is required')

	})

	it('rejects unsafe sink configuration before creating a transport', async() => {
		await expect(createLoggingSink(undefined as never)).rejects.toThrow('configuration must be an object')
		await expect(createLoggingSink({provider: 'other'} as never)).rejects.toThrow('unsupported provider')
		await expect(createLoggingSink({provider: 'http', url: 42} as never)).rejects.toThrow('url must be a string')
		await expect(createLoggingSink({
			provider: 'http',
			url: 'ftp://logs.example.com',
			requestTimeoutMs: 1_000
		})).rejects.toThrow('must use http or https')
		await expect(createLoggingSink({
			provider: 'http',
			url: 'https://logs.example.com',
			requestTimeoutMs: Number.NaN
		})).rejects.toThrow('logging.http.requestTimeoutMs')
		await expect(createLoggingSink({
			provider: 'http',
			url: 'https://logs.example.com',
			requestTimeoutMs: 2_147_483_648
		})).rejects.toThrow('2147483647')
		await expect(createLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com',
			headers: {authorization: 42 as never}
		})).rejects.toThrow('logging headers')
		await expect(createLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com',
			defaultLabels: {'': 'value'}
		})).rejects.toThrow('logging.loki.defaultLabels')
		await expect(createLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com',
			defaultLabels: {app: 42 as never}
		})).rejects.toThrow('logging.loki.defaultLabels')
		await expect(createLoggingSink({
			provider: 'http',
			url: 'https://logs.example.com',
			keepalive: 'yes' as never
		})).rejects.toThrow('keepalive must be a boolean')
		await expect(createLoggingSink({
			provider: 'http', url: 'https://logs.example.com', extra: true
		} as never)).rejects.toThrow('invalid or unexpected fields')
		await expect(createLoggingSink({
			provider: 'http', url: 'https://logs.example.com', headers: {'x-test': 'ok\r\ninjected: yes'}
		})).rejects.toThrow('logging headers')
		await expect(createLoggingSink({
			provider: 'http', url: 'https://user:password@logs.example.com'
		})).rejects.toThrow('must not contain embedded credentials')
		await expect(createLoggingSink({
			provider: 'http', url: 'https://logs.example.com', headers: {'Content-Type': 'text/plain'}
		})).rejects.toThrow('must not override content-type')
	})

	it('forbids redirects so remote credentials cannot be forwarded to another origin', async() => {
		fetchMock.mockResolvedValue({ok: true})
		const http = await createLoggingSink({
			provider: 'http', url: 'https://logs.example.com/http', headers: {authorization: 'secret'}
		})
		const loki = await createLoggingSink({
			provider: 'loki', url: 'https://logs.example.com', headers: {'x-api-key': 'secret'}
		})

		await http.write('line')
		await loki.write('line')

		expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({redirect: 'error'}))
		expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({redirect: 'error'}))
	})

	it('does not execute sink configuration accessors or leak malformed URL secrets', async() => {
		const providerGetter = vi.fn(() => 'http')
		const hostile = Object.defineProperty({url: 'https://logs.example.com'}, 'provider', {
			enumerable: true, get: providerGetter
		})
		await expect(createLoggingSink(hostile as never)).rejects.toThrow('unsupported provider')
		expect(providerGetter).not.toHaveBeenCalled()

		const headerGetter = vi.fn(() => 'secret')
		const headers = Object.defineProperty({}, 'authorization', {
			enumerable: true, get: headerGetter
		})
		await expect(createLoggingSink({
			provider: 'http', url: 'https://logs.example.com', headers: headers as never
		})).rejects.toThrow('logging headers')
		expect(headerGetter).not.toHaveBeenCalled()

		const secret = 'super-secret-password'
		const error = await createLoggingSink({
			provider: 'http', url: `not-a-url://${secret}`
		}).catch((reason: unknown) => reason)
		expect(String(error)).not.toContain(secret)
	})

	it('accepts validated Loki labels and timeout configuration', async() => {
		fetchMock.mockResolvedValue({ok: true})
		const sink = await createLoggingSink({
			provider: 'loki',
			url: 'https://logs.example.com',
			requestTimeoutMs: 1_000,
			defaultLabels: {app: 'api'}
		})
		await expect(sink.write('plain line')).resolves.toBeUndefined()
	})

	it('snapshots transport headers and Loki labels at construction', async() => {
		fetchMock.mockResolvedValue({ok: true})
		const headers = {authorization: 'original'}
		const labels = {app: 'original'}
		const http = await createLoggingSink({
			provider: 'http', url: 'https://logs.example.com/http', headers
		})
		const loki = await createLoggingSink({
			provider: 'loki', url: 'https://logs.example.com', headers, defaultLabels: labels
		})
		headers.authorization = 'mutated'
		labels.app = 'mutated'

		await http.write('line')
		await loki.write('{"time":1,"level":"info","message":"hello"}')

		expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
			headers: expect.objectContaining({authorization: 'original'})
		}))
		const lokiRequest = fetchMock.mock.calls[1]?.[1] as {headers?: unknown; body?: unknown}
		expect(lokiRequest.headers).toEqual(expect.objectContaining({authorization: 'original'}))
		expect(String(lokiRequest.body)).toContain('original')
		expect(String(lokiRequest.body)).not.toContain('mutated')
	})

	it('validates and binds every external sink method', async() => {
		expect(() => snapshotExternalLoggingSink(null)).toThrow('must be an object')
		expect(() => snapshotExternalLoggingSink({write: vi.fn(), close: 1})).toThrow('close must be a function')
		const source = {
			writes: 0,
			write() { this.writes += 1 },
			writeBatch(lines: readonly string[]) { this.writes += lines.length },
			flush: vi.fn(),
			close: vi.fn()
		}
		const sink = snapshotExternalLoggingSink(source)
		await sink.write('one')
		await sink.writeBatch?.(['two', 'three'])
		await sink.flush?.()
		await sink.close?.()
		expect(source.writes).toBe(3)
		expect(source.flush).toHaveBeenCalledOnce()
		expect(source.close).toHaveBeenCalledOnce()
	})

	it('marks an external write rejection without an explicit outcome as ambiguous', async() => {
		const sink = snapshotExternalLoggingSink({
			write: vi.fn().mockRejectedValue(new Error('connection lost after send'))
		})

		await expect(sink.write('possibly accepted')).rejects.toMatchObject({
			code: 'DELIVERY_WRITE_AMBIGUOUS',
			nonRetryable: true,
			ambiguousDelivery: true
		})
	})
})
