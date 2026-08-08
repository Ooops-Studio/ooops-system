import {describe, expect, it, vi} from 'vitest'

import {createProductionMetrics} from '../../src/public/production'

describe('aggregate production metrics', () => {
	it('loads and returns only the selected Prometheus path', async() => {
		const metrics = await createProductionMetrics({transport: {kind: 'prometheus'}})
		metrics.counter('production_requests_total')
		await metrics.flush()
		expect(metrics.getPrometheusScrape().body).toContain('production_requests_total')
		await metrics.shutdown()
	})

	it('rejects missing, unsupported and accessor-backed transports asynchronously', async() => {
		await expect(createProductionMetrics({} as never)).rejects.toThrow('requires a transport')
		await expect(createProductionMetrics({transport: {kind: 'statsd'}} as never))
			.rejects.toThrow('Unsupported production metrics transport')
		const getter = vi.fn(() => 'prometheus')
		const transport = Object.defineProperty({}, 'kind', {enumerable: true, get: getter})
		await expect(createProductionMetrics({transport} as never)).rejects.toThrow('stable data fields')
		expect(getter).not.toHaveBeenCalled()
	})
})
