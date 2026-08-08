import {describe, expect, it, vi} from 'vitest'

import {createHttpLoggingSink} from '../../../src/sinks/providers/http'

describe('http logging sink provider', () => {
	it('forwards timeout, headers, and keepalive to the shared http sink', async() => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 202,
			statusText: 'Accepted',
			text: async() => ''
		})
		globalThis.fetch = fetchMock as typeof fetch

		const sink = createHttpLoggingSink({
			provider: 'http',
			url: 'https://logs.example.com/ingest',
			headers: {'x-api-key': 'secret'},
			requestTimeoutMs: 250,
			keepalive: true
		})

		await sink.write('line1')

		expect(fetchMock).toHaveBeenCalledWith(
			'https://logs.example.com/ingest',
			expect.objectContaining({
				headers: expect.objectContaining({'x-api-key': 'secret'}),
				keepalive: true,
				signal: expect.any(AbortSignal)
			})
		)
	})

	it('omits optional transport options when they are undefined', async() => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 204,
			statusText: 'No Content',
			text: async() => ''
		})
		globalThis.fetch = fetchMock as typeof fetch

		const sink = createHttpLoggingSink({
			provider: 'http',
			url: 'https://logs.example.com/ingest'
		})

		await sink.write('line2')

		expect(fetchMock).toHaveBeenCalledWith(
			'https://logs.example.com/ingest',
			expect.objectContaining({
				headers: {'content-type': 'application/x-ndjson; charset=utf-8'},
				signal: expect.any(AbortSignal)
			})
		)
	})
})
