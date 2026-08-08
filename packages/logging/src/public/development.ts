import type {Errors} from '@ooopsstudio/core/ports/errors'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createEnriching} from '../core/enriching'
import {createFormatting} from '../core/formatting'
import {createLogger} from '../core/logger'
import {constructLoggerWithCleanup} from '../core/logger-construction'
import {normalizeSampling, snapshotLoggingClock, snapshotLoggingLifecycle} from '../core/logger-helpers'
import {createRedacting} from '../core/redacting'
import {createTransferring} from '../core/transferring'
import {consoleSink} from '../features/transferring/console'
import type {Enriching, EnrichingDevelopmentOptions} from '../types/enriching'
import type {Formatting} from '../types/formatting'
import type {ManagedLogging, MutableLevelLogging} from '../types/handler'
import type {Redacting} from '../types/redacting'
import type {TransferringHandle} from '../types/transferring'
import {snapshotLogContext} from '../utils/enriching'
import {createEnrichingWithErrorHandling} from '../utils/enriching-factory'
import {snapshotEnrichingProviders, snapshotLoggingOptions} from '../utils/options'
import {SAFE_DEFAULT_REDACTING_POLICY} from '../utils/redaction-policy'

import {buildObservabilityLogContext} from './observability'

export type DevelopmentLoggingOptions = EnrichingDevelopmentOptions

export async function createDevelopmentEnriching(
	options: Readonly<DevelopmentLoggingOptions> = {}
): Promise<Enriching> {
	const snapshot = snapshotLoggingOptions<Readonly<DevelopmentLoggingOptions>>(options, [
		'clock', 'resource', 'context', 'providers', 'mutableLevel', 'sampling',
		'errors', 'selfMetrics', 'metrics', 'lifecycle'
	], 'Development logging enriching')
	const context = snapshotLogContext(buildObservabilityLogContext(snapshot.context, snapshot.resource)) ?? {}
	const providers = snapshotEnrichingProviders(snapshot.providers ?? [])
	const base = createEnriching(context, snapshot.errors)
	const dynamic = providers.length > 0
		? (await import('../features/enriching/dynamic-providers')).createDynamicProvidersEnriching(
			providers, snapshot.errors, snapshot.selfMetrics, snapshot.metrics
		) : undefined
	return createEnrichingWithErrorHandling(async(record, enrichingOptions) => {
		const enriched = await base(record, enrichingOptions)
		return dynamic ? await dynamic(enriched, enrichingOptions) : enriched
	}, {stage: 'enriching', step: 'development'})
}

export async function createDevelopmentRedacting(errors?: Errors): Promise<Redacting> {
	return createRedacting({
		policy: SAFE_DEFAULT_REDACTING_POLICY,
		budgets: {maxDepth: 8, maxStringBytes: 8_192, maxArrayLength: 1_000, maxObjectEntries: 1_000},
		...(errors ? {errors} : {})
	})
}

export async function createDevelopmentFormatting(): Promise<Formatting> {
	return createFormatting((await import('../features/formatting/pretty')).formatPretty)
}

export async function createDevelopmentTransferring(
	clock: NonNullable<DevelopmentLoggingOptions['clock']>,
	errors?: Errors,
	selfMetrics?: boolean,
	metrics?: DevelopmentLoggingOptions['metrics']
): Promise<TransferringHandle> {
	return createTransferring({sink: consoleSink(), clock,
		...(errors ? {errors} : {}),
		...(selfMetrics !== undefined ? {selfMetrics} : {}),
		...(metrics ? {metrics} : {})})
}

export interface CreateDevelopmentLogging {
	(options: Readonly<DevelopmentLoggingOptions & {mutableLevel: true}>): Promise<MutableLevelLogging>
	(options?: Readonly<DevelopmentLoggingOptions & {mutableLevel?: false}>): Promise<ManagedLogging>
	(options: Readonly<DevelopmentLoggingOptions>): Promise<ManagedLogging | MutableLevelLogging>
}

export const createDevelopmentLogging = (async(
	options: Readonly<DevelopmentLoggingOptions> = {}
) => {
	const snapshot = snapshotLoggingOptions<Readonly<DevelopmentLoggingOptions>>(options, [
		'clock', 'resource', 'context', 'providers', 'mutableLevel', 'sampling',
		'errors', 'selfMetrics', 'metrics', 'lifecycle'
	], 'Development logging')
	if (snapshot.mutableLevel !== undefined && typeof snapshot.mutableLevel !== 'boolean') {
		throw new TypeError('Development logging mutableLevel must be a boolean')
	}
	const clock = snapshotLoggingClock(snapshot.clock, false) ?? createSystemClock()
	const lifecycle = snapshotLoggingLifecycle(snapshot.lifecycle)
	const selfMetrics = snapshot.selfMetrics ?? true
	if (typeof selfMetrics !== 'boolean') throw new TypeError('Development logging selfMetrics must be a boolean')
	const sampling = normalizeSampling(snapshot.sampling)
	const context = snapshotLogContext(buildObservabilityLogContext(snapshot.context, snapshot.resource))
	const enrichingOptions = {...snapshot, context, resource: undefined, lifecycle}
	const [enriching, redacting, formatting, transferring] = await Promise.all([
		createDevelopmentEnriching(enrichingOptions),
		createDevelopmentRedacting(snapshot.errors),
		createDevelopmentFormatting(),
		createDevelopmentTransferring(clock, snapshot.errors, selfMetrics, snapshot.metrics)
	])
	return constructLoggerWithCleanup(() => createLogger(
		enriching, redacting, formatting, transferring, clock, 'debug', 'pretty',
		context, snapshot.errors, selfMetrics, snapshot.metrics, lifecycle,
		{mutableLevel: snapshot.mutableLevel, sampling}
	), transferring) as Promise<ManagedLogging | MutableLevelLogging>
}) as CreateDevelopmentLogging
