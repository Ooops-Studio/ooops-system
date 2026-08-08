import {describe, expect, it} from 'vitest'

import {createOtlpMetrics} from '../../src/public/production-otlp'
import {createPrometheusMetrics} from '../../src/public/production-prometheus'

describe('provider-specific metrics entrypoints', () => {
	it('creates a Prometheus managed handler with no embedded listener', async() => {
		const metrics = await createPrometheusMetrics()
		metrics.gauge('worker_depth', 4)
		await metrics.flush()
		expect(metrics.getPrometheusScrape().body).toContain('worker_depth 4')
		expect('ready' in metrics).toBe(false)
		await metrics.shutdown()
	})

	it('keeps strict production OTLP endpoint validation', async() => {
		await expect(createOtlpMetrics(null as never)).rejects.toThrow('options must be an object')
		await expect(createOtlpMetrics({endpoint: 'http://metrics.example.com'}))
			.rejects.toThrow('must use HTTPS')
		for (const endpoint of [
			'https://127.0.0.1/v1/metrics',
			'https://10.1.2.3/v1/metrics',
			'https://169.254.169.254/v1/metrics',
			'https://192.168.1.20/v1/metrics',
			'https://[4000::1]/v1/metrics',
			'https://[fc00::1]/v1/metrics',
			'https://[fe80::1]/v1/metrics'
		]) {
			await expect(createOtlpMetrics({endpoint})).rejects.toThrow('public network address')
		}
	})
})
