import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'

import type {ResiliencePolicyDefinition} from '@ooopsstudio/core/contracts/resilience'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createProductionResilience} from '../../../src/resilience/public/production'

const openServers = new Set<ReturnType<typeof createServer>>()

afterEach(async() => {
	await Promise.all([...openServers].map(async(server) => await new Promise<void>((resolve) => server.close(() => resolve()))))
	openServers.clear()
})

function policy(): ResiliencePolicyDefinition {
	return {
		name: 'integration.http', operationKind: 'external.http', timeout: {defaultMs: 2_000},
		retry: {classifier: 'http', maxAttempts: 4, maxTotalTimeMs: 1_500, initialDelayMs: 5, maxDelayMs: 100, multiplier: 2, jitter: 'none'},
		circuitBreaker: {failureRatioThreshold: 0.5, failureCountThreshold: 2, timeWindowMs: 1_000, halfOpenAfterMs: 10, halfOpenMaxAttempts: 1},
		bulkhead: {maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 100}
	}
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
	const server = createServer(handler)
	openServers.add(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function request(url: string, signal: AbortSignal): Promise<string> {
	const response = await fetch(url, {signal})
	if (!response.ok) throw Object.assign(new Error('remote request failed'), {status: response.status, headers: response.headers})
	return await response.text()
}

describe('resilience real HTTP integration', () => {
	it('honors numeric Retry-After and recovers without reporting a final error', async() => {
		let requests = 0
		const url = await listen((_request, response) => {
			requests++
			if (requests === 1) { response.writeHead(429, {'retry-after': '0.01'}); response.end('slow down'); return }
			response.end('ok')
		})
		const report = vi.fn()
		const runtime = createProductionResilience({policies: [policy()], errors: {report}})
		await expect(runtime.execute({operation: 'http.retry-after', policy: 'integration.http', context: {resource: 'remote.test'}}, async(signal) => await request(url, signal))).resolves.toBe('ok')
		expect(requests).toBe(2)
		expect(runtime.getStatus().retriedTotal).toBe(1)
		expect(report).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('clamps HTTP-date Retry-After and performs partial recovery within the policy deadline', async() => {
		let requests = 0
		const url = await listen((_request, response) => {
			requests++
			if (requests === 1) { response.writeHead(429, {'retry-after': new Date(Date.now() + 60_000).toUTCString()}); response.end('unavailable'); return }
			response.end('recovered')
		})
		const runtime = createProductionResilience({policies: [policy()]})
		const startedAt = Date.now()
		await expect(runtime.execute({operation: 'http.date-retry', policy: 'integration.http', context: {resource: 'remote.date'}}, async(signal) => await request(url, signal))).resolves.toBe('recovered')
		expect(Date.now() - startedAt).toBeLessThan(1_000)
		expect(requests).toBe(2)
		await runtime.shutdown()
	})

	it('bounds a saturated bulkhead and rejects the queued overflow deterministically', async() => {
		const runtime = createProductionResilience({policies: [policy()]})
		let release!: () => void
		const first = runtime.execute({operation: 'hold', policy: 'integration.http', context: {resource: 'remote.busy'}}, async() => await new Promise<string>((resolve) => { release = () => resolve('done') }))
		await vi.waitFor(() => expect(runtime.getStatus().activeOperations).toBe(1))
		const second = runtime.execute({operation: 'queued', policy: 'integration.http', context: {resource: 'remote.busy'}}, async() => 'queued')
		await vi.waitFor(() => expect(runtime.getStatus().queuedOperations).toBe(1))
		await expect(runtime.execute({operation: 'overflow', policy: 'integration.http', context: {resource: 'remote.busy'}}, async() => 'never')).rejects.toMatchObject({code: 'RESILIENCE_BULKHEAD_OVERFLOW'})
		release()
		await expect(Promise.all([first, second])).resolves.toEqual(['done', 'queued'])
		await runtime.shutdown()
	})
})
