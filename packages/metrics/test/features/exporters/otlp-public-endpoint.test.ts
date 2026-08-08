import {lookup} from 'node:dns/promises'
import {EventEmitter} from 'node:events'
import {request} from 'node:https'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {OtlpExporter} from '../../../src/features/exporters/otlp-exporter'

vi.mock('node:dns/promises', () => ({lookup: vi.fn()}))
vi.mock('node:https', () => ({request: vi.fn()}))

const mockedLookup = vi.mocked(lookup)
const mockedRequest = vi.mocked(request)
let responseStatus = 200
let responseHeaders: Record<string, string> = {}
let responseBody = ''
let requestFailuresRemaining = 0
const fetchMock = vi.fn().mockResolvedValue({
	ok: true,
	status: 200,
	headers: {get: vi.fn().mockReturnValue(null)},
	body: null
} as unknown as Response)

const record = {name: 'requests', type: 'counter' as const, value: 1, labels: {}, timestamp: 1}

describe('production OTLP public endpoint enforcement', () => {
	beforeEach(() => {
		mockedLookup.mockReset()
		mockedRequest.mockReset()
		responseStatus = 200
		responseHeaders = {}
		responseBody = ''
		requestFailuresRemaining = 0
		mockedRequest.mockImplementation(((
			_options: unknown,
			onResponse: (response: EventEmitter & Record<string, unknown>) => void
		) => {
			const outgoing = new EventEmitter() as EventEmitter & {end(body?: unknown): void}
			outgoing.end = vi.fn(() => {
				if (requestFailuresRemaining > 0) {
					requestFailuresRemaining -= 1
					queueMicrotask(() => outgoing.emit('error', new Error('connect failed')))
					return
				}
				const response = new EventEmitter() as EventEmitter & Record<string, unknown>
				response.statusCode = responseStatus
				response.statusMessage = responseStatus === 200 ? 'OK' : 'Redirect'
				response.headers = responseHeaders
				response.resume = vi.fn()
				response.destroy = vi.fn((error?: Error) => {
					if (error) response.emit('error', error)
				})
				onResponse(response)
				queueMicrotask(() => {
					if (responseBody) response.emit('data', Buffer.from(responseBody))
					response.emit('end')
				})
			})
			return outgoing
		}) as never)
		fetchMock.mockClear()
		vi.stubGlobal('fetch', fetchMock)
	})

	it('rejects a hostname when DNS resolves it to a private address', async() => {
		mockedLookup.mockResolvedValue([{address: '10.20.30.40', family: 4}])
		const exporter = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})

		await expect(exporter.export([record])).rejects.toMatchObject({
			code: 'otlp_non_public_endpoint',
			retryable: false
		})
		expect(fetchMock).not.toHaveBeenCalled()
		expect(mockedRequest).not.toHaveBeenCalled()
	})

	it('allows a hostname only when every resolved address is public', async() => {
		mockedLookup.mockResolvedValue([
			{address: '203.0.114.10', family: 4},
			{address: '2001:4860:4860::8888', family: 6}
		])
		const exporter = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})

		await expect(exporter.export([record])).resolves.toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(mockedRequest).toHaveBeenCalledOnce()
		expect(mockedRequest.mock.calls[0]?.[0]).toMatchObject({
			hostname: '203.0.114.10',
			family: 4,
			servername: 'metrics.example.com',
			path: '/v1/metrics',
			headers: expect.objectContaining({Host: 'metrics.example.com'})
		})
	})

	it('observes partial success on the DNS-pinned production transport', async() => {
		mockedLookup.mockResolvedValue([{address: '203.0.114.10', family: 4}])
		responseBody = JSON.stringify({partialSuccess: {rejectedDataPoints: '1'}})
		const onError = vi.fn()
		const exporter = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true,
			onError
		})

		await expect(exporter.export([record])).resolves.toBeUndefined()
		expect(mockedRequest).toHaveBeenCalledOnce()
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({code: 'otlp_partial_success'}),
			expect.objectContaining({rejectedDataPoints: '1'})
		)
	})

	it('rejects mixed public and private DNS answers before opening a socket', async() => {
		mockedLookup.mockResolvedValue([
			{address: '203.0.114.10', family: 4},
			{address: '192.168.1.10', family: 4}
		])
		const exporter = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})

		await expect(exporter.export([record])).rejects.toMatchObject({
			code: 'otlp_non_public_endpoint', retryable: false
		})
		expect(mockedRequest).not.toHaveBeenCalled()
	})

	it('bounds and deduplicates DNS failover addresses before opening a socket', async() => {
		mockedLookup.mockResolvedValue(Array.from({length: 17}, (_, index) => ({
			address: `8.8.8.${index + 1}`,
			family: 4 as const
		})))
		const bounded = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})

		await expect(bounded.export([record])).rejects.toMatchObject({
			code: 'otlp_dns_answer_limit', retryable: false
		})
		expect(mockedRequest).not.toHaveBeenCalled()

		mockedLookup.mockResolvedValue(Array.from({length: 32}, () => ({
			address: '8.8.8.8', family: 4 as const
		})))
		await expect(bounded.export([record])).resolves.toBeUndefined()
		expect(mockedRequest).toHaveBeenCalledOnce()

		mockedRequest.mockClear()
		mockedLookup.mockResolvedValue(Array.from({length: 65}, () => ({
			address: '8.8.8.8', family: 4 as const
		})))
		await expect(bounded.export([record])).rejects.toMatchObject({
			code: 'otlp_dns_answer_limit', retryable: false
		})
		expect(mockedRequest).not.toHaveBeenCalled()
	})

	it('rejects DNS answers outside IPv6 global unicast before opening a socket', async() => {
		mockedLookup.mockResolvedValue([{address: '4000::1', family: 6}])
		const exporter = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})

		await expect(exporter.export([record])).rejects.toMatchObject({
			code: 'otlp_non_public_endpoint', retryable: false
		})
		expect(mockedRequest).not.toHaveBeenCalled()
	})

	it('does not follow redirects from a validated public endpoint', async() => {
		mockedLookup.mockResolvedValue([{address: '203.0.114.10', family: 4}])
		responseStatus = 302
		responseHeaders = {location: 'https://192.168.1.10/v1/metrics'}
		const exporter = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})

		await expect(exporter.export([record])).rejects.toMatchObject({
			statusCode: 302, code: 'http_302', retryable: false
		})
		expect(mockedRequest).toHaveBeenCalledOnce()
	})

	it('tries the next validated public address after a connection failure', async() => {
		mockedLookup.mockResolvedValue([
			{address: '203.0.114.10', family: 4},
			{address: '2001:4860:4860::8888', family: 6}
		])
		requestFailuresRemaining = 1
		const exporter = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})

		await expect(exporter.export([record])).resolves.toBeUndefined()
		expect(mockedRequest).toHaveBeenCalledTimes(2)
		expect(mockedRequest.mock.calls.map((call) => call[0])).toEqual([
			expect.objectContaining({hostname: '203.0.114.10', family: 4}),
			expect.objectContaining({hostname: '2001:4860:4860::8888', family: 6})
		])
	})

	it('does not resend an acknowledged request after a non-retryable response violation', async() => {
		mockedLookup.mockResolvedValue([
			{address: '203.0.114.10', family: 4},
			{address: '2001:4860:4860::8888', family: 6}
		])
		responseBody = 'x'.repeat(65_537)
		const exporter = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})

		await expect(exporter.export([record])).rejects.toMatchObject({
			code: 'otlp_response_too_large', retryable: false
		})
		expect(mockedRequest).toHaveBeenCalledOnce()
	})

	it('rejects empty DNS answers and insecure strict endpoints', async() => {
		mockedLookup.mockResolvedValue([])
		const empty = new OtlpExporter({
			endpoint: 'https://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})
		await expect(empty.export([record])).rejects.toMatchObject({code: 'otlp_non_public_endpoint'})

		const insecure = new OtlpExporter({
			endpoint: 'http://metrics.example.com/v1/metrics',
			requirePublicEndpoint: true
		})
		await expect(insecure.export([record])).rejects.toMatchObject({
			code: 'otlp_insecure_endpoint', retryable: false
		})
		expect(mockedRequest).not.toHaveBeenCalled()
	})
})
