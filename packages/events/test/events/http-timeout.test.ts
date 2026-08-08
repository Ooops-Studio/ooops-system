import {describe, expect, it, vi} from 'vitest'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({lookup}))

import {createHttpWebhookEventTransport} from '../../src/events/transports/http'

describe('HTTP event transport lifecycle bounds', () => {
	it('bounds delivery and shutdown while DNS resolution is physically hung', async() => {
		lookup.mockReturnValue(new Promise(() => undefined))
		const destination = createHttpWebhookEventTransport({allowedOrigins: ['https://events.example'], timeoutMs: 5})
		const delivery = destination.deliver({
			id: 'dns-timeout', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		}, {destination: 'http', target: 'https://events.example/hook'}, new AbortController().signal)
		const shutdown = destination.shutdown!()
		await expect(delivery).resolves.toMatchObject({status: 'retryable'})
		await expect(shutdown).resolves.toBeUndefined()
	})

	it('aborts a physically hung DNS lookup without waiting for its configured timeout', async() => {
		lookup.mockReturnValue(new Promise(() => undefined))
		const destination = createHttpWebhookEventTransport({allowedOrigins: ['https://events.example'], timeoutMs: 120_000})
		const controller = new AbortController()
		const delivery = destination.deliver({
			id: 'dns-abort', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		}, {destination: 'http', target: 'https://events.example/hook'}, controller.signal)
		controller.abort()
		await expect(delivery).resolves.toMatchObject({status: 'retryable'})
		await expect(destination.shutdown!()).resolves.toBeUndefined()
	})
})
