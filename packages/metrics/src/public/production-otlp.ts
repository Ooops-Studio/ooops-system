import {createManagedMetricsFacade} from '../core/managed-facade'
import {createOtlpExporter} from '../features/exporters/otlp-exporter'
import {createMetricsOnError} from '../utils/on-error'

import {
	createProductionMetricsHandler,
	snapshotProductionOptions,
	validateProductionOtlpEndpoint,
	validateProductionOtlpHeaders,
	type ProductionMetricsBaseOptions
} from './production-common'
import type {ManagedMetrics} from './types'

export interface OtlpMetricsOptions extends ProductionMetricsBaseOptions {
	readonly endpoint: string
	readonly headers?: Record<string, string>
}

export async function createOtlpMetrics(
	options: OtlpMetricsOptions
): Promise<ManagedMetrics> {
	if (!options || typeof options !== 'object') throw new Error('Production OTLP metrics options must be an object')
	const stable = snapshotProductionOptions(options, new Set(['endpoint', 'headers']), 'Production OTLP metrics options') as unknown as OtlpMetricsOptions
	validateProductionOtlpEndpoint(stable.endpoint)
	const headers = validateProductionOtlpHeaders(stable.headers)
	const onError = stable.errors
		? createMetricsOnError(stable.errors, {stage: 'metrics', exporter: 'otlp'})
		: undefined
	const handler = await createProductionMetricsHandler(createOtlpExporter({
		endpoint: stable.endpoint,
		headers,
		protocol: 'http',
		requirePublicEndpoint: true,
		...(onError ? {onError} : {}),
		...(stable.logger ? {logger: stable.logger} : {})
	}), stable)
	return createManagedMetricsFacade(handler)
}
