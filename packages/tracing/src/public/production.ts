import {isIP} from 'node:net'

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {isPublicNetworkAddress} from '@ooopsstudio/core/utils/public-network-address'
import {createParentBasedSampler, createProbabilisticSampler} from '@ooopsstudio/core/utils/tracing'

import {
	MAX_ATTRIBUTES_PRODUCTION,
	MAX_ATTR_BYTES_PRODUCTION,
	MAX_EVENTS_PRODUCTION,
	SAMPLING_RATIO_PRODUCTION
} from '../constants'
import {createProductionTracingProcessor} from '../core/production-delivery'
import {snapshotOtlpRemoteConfig, type OtlpRemoteConfig} from '../sinks'
import {captureClock} from '../utils/capabilities'

import {snapshotProductionOptions} from './options'
import {createStandardTracingRuntime} from './standard-runtime'
import type {ManagedTracing, TracingSamplingPolicy} from './types'

export interface ProductionTracingOptions {
	readonly remote: OtlpRemoteConfig
	readonly sampling?: TracingSamplingPolicy
	readonly clock?: Clock
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
	readonly lifecycle?: LifecyclePort
	readonly resource?: ObservabilityResource
}

/** One safe OTLP destination with fixed batching and delivery protection. */
export async function createProductionTracing(options: ProductionTracingOptions): Promise<ManagedTracing> {
	if (!options) throw new Error('Production tracing requires one OTLP remote')
	const safeOptions = snapshotProductionOptions(options) as unknown as ProductionTracingOptions
	if (!safeOptions.remote) throw new Error('Production tracing requires one OTLP remote')
	const remote = snapshotOtlpRemoteConfig(safeOptions.remote)
	validateProductionTracingEndpoint(remote.endpoint)
	const clock = captureClock(safeOptions.clock ?? createSystemClock())
	const rate = safeOptions.sampling?.rate ?? SAMPLING_RATIO_PRODUCTION
	if (!Number.isFinite(rate) || rate < 0 || rate > 1 || (safeOptions.sampling && safeOptions.sampling.strategy !== 'fixed-rate')) {
		throw new Error('Production tracing sampling must be a fixed rate between 0 and 1')
	}
	return createStandardTracingRuntime({
		clock,
		sampler: createParentBasedSampler(createProbabilisticSampler({ratio: rate})),
		processor: createProductionTracingProcessor({
			remote,
			clock,
			...(safeOptions.errors ? {errors: safeOptions.errors} : {}),
			...(safeOptions.metrics ? {metrics: safeOptions.metrics} : {}),
			...(safeOptions.logger ? {logger: safeOptions.logger} : {})
		}),
		...(safeOptions.errors ? {errors: safeOptions.errors} : {}),
		...(safeOptions.metrics ? {metrics: safeOptions.metrics} : {}),
		...(safeOptions.logger ? {logger: safeOptions.logger} : {}),
		...(safeOptions.lifecycle ? {lifecycle: safeOptions.lifecycle} : {}),
		...(safeOptions.resource ? {resource: safeOptions.resource} : {}),
		limits: {
			maxAttributesPerSpan: MAX_ATTRIBUTES_PRODUCTION,
			maxEventsPerSpan: MAX_EVENTS_PRODUCTION,
			maxAttrBytes: MAX_ATTR_BYTES_PRODUCTION
		},
		preset: 'production'
	})
}

function validateProductionTracingEndpoint(endpoint: string): void {
	let url: URL
	try { url = new URL(endpoint) } catch { throw new Error('Production tracing OTLP endpoint must be a valid HTTPS URL') }
	if (url.protocol !== 'https:') throw new Error('Production tracing OTLP endpoint must use HTTPS')
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.+$/u, '')
	if ((hostname === 'localhost' || hostname.endsWith('.localhost')) ||
		(isIP(hostname) !== 0 && !isPublicNetworkAddress(hostname))) {
		throw new Error('Production tracing OTLP endpoint must use a public network address')
	}
}
