import {createOtlpExporter} from '../features/exporters/otlp-exporter'

import type {MetricsSink, OtlpMetricsSinkConfig} from './types'

/** Create an OTLP metrics sink without importing Prometheus rendering code. */
export function createOtlpSink(config: Readonly<OtlpMetricsSinkConfig>): MetricsSink {
	if (!config || typeof config !== 'object') throw new Error('OTLP sink config must be an object')
	const descriptors = Object.getOwnPropertyDescriptors(config)
	const allowed = new Set(['provider', 'endpoint', 'headers', 'timeout', 'protocol', 'allowedHeaders', 'enableGzip', 'gzipThresholdBytes', 'logger'])
	if (Object.getPrototypeOf(config) !== Object.prototype
		|| Object.getOwnPropertySymbols(config).length > 0
		|| Object.entries(descriptors).some(([key, descriptor]) =>
			key.length > 128 || !allowed.has(key)
			|| !descriptor.enumerable || !('value' in descriptor))) {
		throw new Error('OTLP sink config must expose stable known data fields')
	}
	const values = Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
	) as Record<string, unknown>
	if (values.provider !== 'otlp') throw new Error('OTLP sink provider must be "otlp"')
	const {provider: _provider, ...options} = values
	const exporter = createOtlpExporter(options as unknown as Omit<OtlpMetricsSinkConfig, 'provider'>)
	return Object.freeze({
		export: exporter.export.bind(exporter),
		flush: exporter.flush.bind(exporter),
		shutdown: exporter.shutdown.bind(exporter)
	})
}

export type {MetricsSink, OtlpMetricsSinkConfig} from './types'
