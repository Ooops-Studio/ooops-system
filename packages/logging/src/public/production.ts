import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createFormatting} from '../core/formatting'
import {createLogger} from '../core/logger'
import {cleanupLoggingConstructionFailure, constructLoggerWithCleanup} from '../core/logger-construction'
import {normalizeSampling, snapshotLoggingClock, snapshotLoggingLifecycle} from '../core/logger-helpers'
import type {Enriching, EnrichingProductionOptions} from '../types/enriching'
import type {Formatting} from '../types/formatting'
import type {ManagedLogging, MutableLevelLogging} from '../types/handler'
import type {Redacting} from '../types/redacting'
import {snapshotLogContext} from '../utils/enriching'
import {snapshotLoggingOptions} from '../utils/options'

import {buildObservabilityLogContext} from './observability'
import {createProductionEnriching} from './production-enriching'
import {createProductionRedacting} from './production-redacting'
import {createProductionTransferring} from './production-transferring'
import {
	resolveLoggingRemote,
	snapshotLoggingRemote,
	type LoggingRemoteInput
} from './remote-resolution'

export type ProductionLoggingRemote = LoggingRemoteInput

export interface ProductionLoggingOptions extends EnrichingProductionOptions {
	readonly remote?: ProductionLoggingRemote
}

export async function createProductionFormatting(): Promise<Formatting> {
	return createFormatting((await import('../features/formatting/json')).formatJson)
}

export interface CreateProductionLogging {
	(options: Readonly<ProductionLoggingOptions & {mutableLevel: true}>): Promise<MutableLevelLogging>
	(options?: Readonly<ProductionLoggingOptions & {mutableLevel?: false}>): Promise<ManagedLogging>
	(options: Readonly<ProductionLoggingOptions>): Promise<ManagedLogging | MutableLevelLogging>
}

export const createProductionLogging = (async(
	options: Readonly<ProductionLoggingOptions> = {}
) => {
	const snapshot = snapshotLoggingOptions<Readonly<ProductionLoggingOptions>>(options, [
		'clock', 'resource', 'context', 'providers', 'mutableLevel', 'sampling',
		'errors', 'selfMetrics', 'metrics', 'lifecycle', 'remote'
	], 'Production logging')
	if (snapshot.mutableLevel !== undefined && typeof snapshot.mutableLevel !== 'boolean') {
		throw new TypeError('Production logging mutableLevel must be a boolean')
	}
	const clock = snapshotLoggingClock(snapshot.clock, false) ?? createSystemClock()
	const lifecycle = snapshotLoggingLifecycle(snapshot.lifecycle)
	const selfMetrics = snapshot.selfMetrics ?? true
	if (typeof selfMetrics !== 'boolean') throw new TypeError('Production logging selfMetrics must be a boolean')
	const sampling = normalizeSampling(snapshot.sampling)
	const remoteSnapshot = snapshotLoggingRemote(snapshot.remote, 'Production logging')
	const context = snapshotLogContext(buildObservabilityLogContext(snapshot.context, snapshot.resource))
	const enrichingOptions = {...snapshot, context, resource: undefined, lifecycle}
	delete enrichingOptions.remote
	const stages: [Enriching, Redacting, Formatting] = await Promise.all([
		createProductionEnriching(enrichingOptions),
		createProductionRedacting(snapshot.errors),
		createProductionFormatting()
	])
	const remote = await resolveLoggingRemote(remoteSnapshot)
	let transferring
	try { transferring = await createProductionTransferring(clock, remote, snapshot.errors, selfMetrics, snapshot.metrics) } catch(error) {
		return await cleanupLoggingConstructionFailure(error, async() => await remote?.close?.())
	}
	return constructLoggerWithCleanup(() => createLogger(
		stages[0], stages[1], stages[2], transferring, clock, 'info', 'json', context,
		snapshot.errors, selfMetrics, snapshot.metrics, lifecycle,
		{mutableLevel: snapshot.mutableLevel, sampling}
	), transferring) as Promise<ManagedLogging | MutableLevelLogging>
}) as CreateProductionLogging
