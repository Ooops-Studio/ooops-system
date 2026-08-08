import {createEnriching} from '../core/enriching'
import type {Enriching, EnrichingProductionOptions} from '../types/enriching'
import {snapshotLogContext} from '../utils/enriching'
import {createEnrichingWithErrorHandling} from '../utils/enriching-factory'
import {isServer} from '../utils/environment-detection'
import {snapshotEnrichingProviders, snapshotLoggingOptions} from '../utils/options'

import {buildObservabilityLogContext} from './observability'

export async function createProductionEnriching(
	options: Readonly<EnrichingProductionOptions> = {}
): Promise<Enriching> {
	const snapshot = snapshotLoggingOptions<Readonly<EnrichingProductionOptions>>(options, [
		'clock', 'resource', 'context', 'providers', 'mutableLevel', 'sampling',
		'errors', 'selfMetrics', 'metrics', 'lifecycle'
	], 'Production logging enriching')
	const context = snapshotLogContext(buildObservabilityLogContext(snapshot.context, snapshot.resource)) ?? {}
	const providers = [...snapshotEnrichingProviders(snapshot.providers ?? [])]
	if (isServer()) providers.unshift((await import('../features/enriching/dynamic-providers/server')).createServerDynamicProvider())
	const base = createEnriching(context, snapshot.errors)
	const dynamic = providers.length > 0
		? (await import('../features/enriching/dynamic-providers')).createDynamicProvidersEnriching(
			providers, snapshot.errors, snapshot.selfMetrics, snapshot.metrics
		) : undefined
	return createEnrichingWithErrorHandling(async(record, enrichingOptions) => {
		const enriched = await base(record, enrichingOptions)
		return dynamic ? await dynamic(enriched, enrichingOptions) : enriched
	}, {stage: 'enriching', step: 'production'})
}
