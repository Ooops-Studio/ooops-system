import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createProductionTracing} from '../src/public/production'
import {createPublicHttpsTransport} from '../src/sinks/public-https'

vi.mock('../src/sinks/public-https', () => ({
	createPublicHttpsTransport: vi.fn(() => vi.fn(async() => new Response('{}', {status: 200})))
}))

describe('production tracing public endpoint transport', () => {
	it('uses the DNS-pinned public transport instead of ambient fetch', async() => {
		const ambientFetch = vi.fn()
		vi.stubGlobal('fetch', ambientFetch)
		const tracer = await createProductionTracing({
			remote: {endpoint: 'https://collector.example/v1/traces'},
			sampling: {strategy: 'fixed-rate', rate: 1},
			clock: createFixedClock(1)
		})
		await tracer.inSpan('public-endpoint', async() => undefined)
		await tracer.forceFlush()
		await tracer.shutdown()

		expect(createPublicHttpsTransport).toHaveBeenCalledWith('https://collector.example/v1/traces', 64 * 1_024)
		expect(ambientFetch).not.toHaveBeenCalled()
	})
})
