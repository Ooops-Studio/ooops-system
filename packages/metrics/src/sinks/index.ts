import type {MetricsSink, MetricsSinkConfig} from './types'

/** Aggregate sink factory. Provider modules are loaded only after selection. */
export async function createMetricsSink(config: Readonly<MetricsSinkConfig>): Promise<MetricsSink> {
	if (!config || typeof config !== 'object') throw new Error('Metrics sink config must be an object')
	let provider: unknown
	try {
		const descriptor = Object.getOwnPropertyDescriptor(config, 'provider')
		provider = descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch {
		throw new Error('Metrics sink config must expose a stable provider')
	}
	if (provider === 'prometheus') {
		const {createPrometheusSink} = await import('./prometheus')
		return createPrometheusSink(config as Readonly<import('./types').PrometheusMetricsSinkConfig>)
	}
	if (provider === 'otlp') {
		const {createOtlpSink} = await import('./otlp')
		return createOtlpSink(config as Readonly<import('./types').OtlpMetricsSinkConfig>)
	}
	throw new Error(`Unsupported metrics sink provider: ${
		typeof provider === 'string' ? provider.slice(0, 64) : `<${provider === null ? 'null' : typeof provider}>`
	}`)
}

export type {
	MetricsSink,
	MetricsSinkConfig,
	OtlpMetricsSinkConfig,
	PrometheusMetricsSink,
	PrometheusMetricsSinkConfig
} from './types'
