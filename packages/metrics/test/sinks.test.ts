import {describe, expect, it} from 'vitest'

import {createMetricsSink} from '../src/sinks'
import {createPrometheusSink} from '../src/sinks/prometheus'

describe('metrics sinks', () => {
	it('creates provider-specific Prometheus output', async() => {
		const sink = createPrometheusSink({provider: 'prometheus'})
		await sink.export([{
			name: 'requests_total', type: 'counter', value: 1,
			labels: {}, timestamp: Date.now()
		}])
		expect(sink.getPrometheusScrape().body).toContain('requests_total')
	})

	it('uses an async aggregate factory and rejects unsupported providers', async() => {
		const sink = await createMetricsSink({provider: 'prometheus'})
		expect(typeof sink.export).toBe('function')
		await expect(createMetricsSink(null as never)).rejects.toThrow('config must be an object')
		await expect(createMetricsSink({provider: 'statsd'} as never)).rejects.toThrow('Unsupported')
	})

	it('does not accept enabled flags', () => {
		expect(() => createPrometheusSink({provider: 'prometheus', enabled: false} as never))
			.toThrow('stable known data fields')
	})

	it('does not accept Prometheus exports after shutdown', async() => {
		const sink = createPrometheusSink({provider: 'prometheus'})
		await sink.shutdown()
		await expect(sink.export([{
			name: 'late_metric', type: 'counter', value: 1, labels: {}, timestamp: 1
		}])).rejects.toMatchObject({code: 'prometheus_exporter_closed', retryable: false})
	})
})
