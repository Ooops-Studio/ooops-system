import {createPrometheusExporter} from '../features/exporters/prometheus-exporter'

import type {PrometheusMetricsSink, PrometheusMetricsSinkConfig} from './types'

export interface PrometheusScrape {
	readonly body: string
	readonly contentType: string
}

export interface PrometheusScrapeSource {
	getPrometheusScrape(format?: 'openmetrics' | 'prometheus'): PrometheusScrape
}

/** Create a Prometheus metrics sink without importing OTLP transport code. */
export function createPrometheusSink(
	config: Readonly<PrometheusMetricsSinkConfig>
): PrometheusMetricsSink {
	if (!config || typeof config !== 'object') throw new Error('Prometheus sink config must be an object')
	const descriptors = Object.getOwnPropertyDescriptors(config)
	if (Object.getPrototypeOf(config) !== Object.prototype
		|| Object.getOwnPropertySymbols(config).length > 0
		|| Object.entries(descriptors).some(([key, descriptor]) =>
			!['provider', 'maxBufferSize', 'maxBufferLines', 'logger'].includes(key)
			|| !descriptor.enumerable || !('value' in descriptor))) {
		throw new Error('Prometheus sink config must expose stable known data fields')
	}
	const values = Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
	) as Record<string, unknown>
	if (values.provider !== 'prometheus') throw new Error('Prometheus sink provider must be "prometheus"')
	const exporter = createPrometheusExporter({
		...(values.maxBufferSize !== undefined ? {maxBufferSize: values.maxBufferSize as number} : {}),
		...(values.maxBufferLines !== undefined ? {maxBufferLines: values.maxBufferLines as number} : {}),
		...(values.logger !== undefined ? {logger: values.logger as PrometheusMetricsSinkConfig['logger']} : {})
	})
	return Object.freeze({
		export: exporter.export.bind(exporter),
		flush: exporter.flush.bind(exporter),
		shutdown: exporter.shutdown.bind(exporter),
		render: exporter.render.bind(exporter),
		contentType: exporter.contentType.bind(exporter),
		getPrometheusScrape: (format?: 'openmetrics' | 'prometheus'): PrometheusScrape => ({
			body: exporter.render(format),
			contentType: exporter.contentType(format)
		})
	})
}

export type {PrometheusMetricsSink, PrometheusMetricsSinkConfig} from './types'
