import {
	createPrometheusManagedMetricsFacade
} from '../core/managed-facade'
import {createPrometheusSink} from '../sinks/prometheus'
import {capturePrometheusScrapeCapability} from '../utils/prometheus-scrape-capability'

import {
	createProductionMetricsHandler,
	snapshotProductionOptions,
	type ProductionMetricsBaseOptions
} from './production-common'
import type {PrometheusManagedMetrics} from './types'

export type PrometheusMetricsHandlerPort = PrometheusManagedMetrics

export type PrometheusMetricsOptions = ProductionMetricsBaseOptions

export async function createPrometheusMetrics(
	options: PrometheusMetricsOptions = {}
): Promise<PrometheusMetricsHandlerPort> {
	if (!options || typeof options !== 'object') throw new Error('Production Prometheus metrics options must be an object')
	const stable = snapshotProductionOptions(options) as unknown as PrometheusMetricsOptions
	const prometheus = createPrometheusSink({
		provider: 'prometheus',
		...(stable.logger ? {logger: stable.logger} : {})
	})
	const scrape = capturePrometheusScrapeCapability(prometheus)
	if (!scrape) throw new Error('Production Prometheus sink does not expose a stable scrape capability')
	const handler = await createProductionMetricsHandler(prometheus, stable)
	return createPrometheusManagedMetricsFacade(handler, scrape)
}
