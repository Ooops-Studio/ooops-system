import {lookup} from 'node:dns/promises'
import {EventEmitter} from 'node:events'
import {request} from 'node:https'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {sendPublicHttps} from '../src/sinks/public-https'

vi.mock('node:dns/promises', () => ({lookup: vi.fn()}))
vi.mock('node:https', () => ({request: vi.fn()}))

const mockedLookup = vi.mocked(lookup)
const mockedRequest = vi.mocked(request)
let responseBody = '{}'

describe('public HTTPS transport', () => {
	beforeEach(() => {
		mockedLookup.mockReset()
		mockedRequest.mockReset()
		responseBody = '{}'
		mockedRequest.mockImplementation(((_options: unknown, onResponse: (response: EventEmitter & Record<string, unknown>) => void) => {
			const outgoing = new EventEmitter() as EventEmitter & {end(body?: unknown): void}
			outgoing.end = vi.fn(() => {
				const response = new EventEmitter() as EventEmitter & Record<string, unknown>
				response.statusCode = 200
				response.statusMessage = 'OK'
				response.headers = {'content-type': 'application/json'}
				response.destroy = vi.fn((error?: Error) => { if (error) response.emit('error', error) })
				onResponse(response)
				queueMicrotask(() => {
					response.emit('data', Buffer.from(responseBody))
					response.emit('end')
				})
			})
			return outgoing
		}) as never)
	})

	const send = () => sendPublicHttps({
		endpoint: 'https://collector.example/v1/data', headers: {authorization: 'Bearer token'},
		body: '{}', signal: new AbortController().signal, maxResponseBytes: 64 * 1_024
	})

	it('rejects private and mixed DNS answers before opening a socket', async() => {
		mockedLookup.mockResolvedValueOnce([{address: '10.20.30.40', family: 4}])
		await expect(send()).rejects.toMatchObject({code: 'PUBLIC_HTTPS_NON_PUBLIC_ENDPOINT', retryable: false})
		mockedLookup.mockResolvedValueOnce([
			{address: '203.0.114.10', family: 4}, {address: '192.168.1.10', family: 4}
		])
		await expect(send()).rejects.toMatchObject({code: 'PUBLIC_HTTPS_NON_PUBLIC_ENDPOINT', retryable: false})
		expect(mockedRequest).not.toHaveBeenCalled()
	})

	it('pins TLS and Host identity to a validated public DNS answer', async() => {
		mockedLookup.mockResolvedValue([{address: '203.0.114.10', family: 4}])
		await expect(send()).resolves.toBeInstanceOf(Response)
		expect(mockedRequest.mock.calls[0]?.[0]).toMatchObject({
			hostname: '203.0.114.10', family: 4, servername: 'collector.example',
			path: '/v1/data', headers: expect.objectContaining({Host: 'collector.example'})
		})
	})

	it('bounds DNS answers and response bodies', async() => {
		mockedLookup.mockResolvedValueOnce(Array.from({length: 65}, () => ({address: '8.8.8.8', family: 4 as const})))
		await expect(send()).rejects.toMatchObject({code: 'PUBLIC_HTTPS_DNS_ANSWER_LIMIT'})
		responseBody = 'x'.repeat(65 * 1_024)
		mockedLookup.mockResolvedValueOnce([{address: '8.8.8.8', family: 4}])
		await expect(send()).rejects.toMatchObject({code: 'PUBLIC_HTTPS_RESPONSE_TOO_LARGE'})
	})
})
