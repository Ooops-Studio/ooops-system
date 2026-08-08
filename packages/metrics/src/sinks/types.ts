import type {OtlpExporterOptions} from '../features/exporters/otlp-exporter'
import type {PrometheusExporterOptions} from '../features/exporters/prometheus-exporter'
import type {MetricExporterPort} from '../types/exporter'

export const METRICS_SINK_TYPES_RUNTIME = true

export type MetricsSink = Pick<MetricExporterPort, 'export' | 'flush' | 'shutdown'>

export interface OtlpMetricsSinkConfig extends Omit<OtlpExporterOptions, 'onError'> {
	readonly provider: 'otlp'
}

export interface PrometheusMetricsSinkConfig extends Omit<PrometheusExporterOptions, 'onError'> {
	readonly provider: 'prometheus'
}

export type MetricsSinkConfig =
	| OtlpMetricsSinkConfig
	| PrometheusMetricsSinkConfig

export interface PrometheusMetricsSink extends MetricsSink {
	render(format?: 'openmetrics' | 'prometheus'): string
	contentType(format?: 'openmetrics' | 'prometheus'): string
	getPrometheusScrape(format?: 'openmetrics' | 'prometheus'): {
		body: string
		contentType: string
	}
}
