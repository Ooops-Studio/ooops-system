import {describe, expect, it} from 'vitest'

import {PrometheusExporter} from '../../../src/features/exporters/prometheus-exporter'
import type {MetricRecord} from '../../../src/types/metric-record'

describe('prometheus exporter coverage', () => {
	it('covers format conversion and content negotiation without an HTTP runtime', async() => {
		const exporter = new PrometheusExporter()
		const record: MetricRecord = {
			name: 'http_requests_total',
			type: 'counter',
			value: 1,
			labels: {route: '/'},
			timestamp: 1_000,
			metadata: {instrument: 'counter', temporality: 'cumulative', description: 'count'}
		}

		await exporter.export([record])
		expect(exporter.getFormatted('openmetrics')).toContain('# EOF')
		expect(exporter.getFormatted('prometheus')).toContain('http_requests_total')
		expect(exporter.getContentType()).toContain('text/plain')

		await exporter.export([{
			...record,
			name: 'trace_metric',
			exemplar: {traceId: 'trace', spanId: 'span', value: 1, timestamp: 1_000}
		}])

		expect(exporter.getContentType()).toContain('openmetrics-text')
		expect(exporter.getContentType('prometheus')).toContain('text/plain')
		expect(exporter.getContentType('openmetrics')).toContain('openmetrics-text')
		expect(exporter.getFormatted()).toContain('# EOF')
	})
})
