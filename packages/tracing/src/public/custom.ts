import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {createAlwaysOnSampler, createParentBasedSampler, createProbabilisticSampler, type Sampler} from '@ooopsstudio/core/utils/tracing'

import {
	BATCH_MAX_BYTES_PRODUCTION,
	BATCH_MAX_INTERVAL_PRODUCTION,
	BATCH_MAX_SIZE_PRODUCTION,
	BREAKER_HALF_OPEN_TIMEOUT_PRODUCTION,
	BREAKER_THRESHOLD_PRODUCTION,
	RETRY_BASE_DELAY_PRODUCTION,
	RETRY_JITTER_PRODUCTION,
	RETRY_MAX_ATTEMPTS_PRODUCTION,
	RETRY_MAX_DELAY_PRODUCTION,
	RETRY_MULTIPLIER_PRODUCTION,
	TOKEN_BUCKET_BURST_PRODUCTION,
	TOKEN_BUCKET_RATE_PRODUCTION
} from '../constants'
import type {BatchingConfig} from '../core/processor-types'
import {invokeNativeAsync} from '../core/processor-utils'
import type {ResilientExporterOptions, RetryPolicy} from '../core/transferring'
import type {TraceRedactionRule} from '../features/redaction/types'
import type {SpanExporterPort} from '../types/ports'
import {captureCapability, captureClock} from '../utils/capabilities'

import {createCustomTracingRuntime} from './custom-runtime'
import {snapshotCustomOptions} from './options'
import type {ManagedTracing, TraceExporter, TracingSamplingPolicy} from './types'

export interface TracingBatchingPolicy extends BatchingConfig {}
export interface TracingRetryPolicy extends RetryPolicy {}
export interface TracingBackpressurePolicy {
	readonly tokenBucketRate: number
	readonly tokenBucketBurst: number
}
export interface TracingCircuitBreakerPolicy {
	readonly failureThreshold: number
	readonly halfOpenAfterMs: number
}

export interface CustomTracingOptions {
	readonly clock: Clock
	readonly sampling?: TracingSamplingPolicy | {readonly strategy: 'custom'; readonly sampler: Sampler}
	readonly destination:
		| {readonly provider: 'custom'; readonly exporter: TraceExporter}
		| {readonly provider: 'otlp'; readonly endpoint: string; readonly headers?: Readonly<Record<string, string>>}
	readonly delivery?: {
		readonly mode?: 'direct' | 'batched'
		readonly batching?: TracingBatchingPolicy
		readonly retry?: TracingRetryPolicy
		readonly backpressure?: TracingBackpressurePolicy
		readonly circuitBreaker?: TracingCircuitBreakerPolicy | false
	}
	readonly resource?: ObservabilityResource
	readonly redaction?: {readonly additionalRules?: readonly TraceRedactionRule[]}
	readonly limits?: {
		readonly maxAttributesPerSpan?: number
		readonly maxEventsPerSpan?: number
		readonly maxAttributeBytes?: number
	}
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
	readonly lifecycle?: LifecyclePort
}

export async function createCustomTracing(options: CustomTracingOptions): Promise<ManagedTracing> {
	if (!options) throw new Error('Custom tracing options are required')
	const safe = snapshotCustomOptions(options) as unknown as CustomTracingOptions
	const clock = captureClock(safe.clock)
	const sampler = createSampling(safe.sampling)
	const destination = safe.destination
	if (!destination) throw new Error('Custom tracing requires exactly one destination')
	validateDestination(destination)
	const mode = safe.delivery?.mode ?? (destination.provider === 'otlp' ? 'batched' : 'direct')
	if (mode !== 'direct' && mode !== 'batched') {
		throw new Error('Custom tracing delivery mode must be "direct" or "batched"')
	}
	if (mode === 'direct' && (safe.delivery?.batching || safe.delivery?.backpressure)) {
		throw new Error('Direct tracing delivery does not accept batching or backpressure options')
	}
	const batching = mode === 'batched' ? Object.freeze({
		maxBatch: safe.delivery?.batching?.maxBatch ?? BATCH_MAX_SIZE_PRODUCTION,
		maxIntervalMs: safe.delivery?.batching?.maxIntervalMs ?? BATCH_MAX_INTERVAL_PRODUCTION,
		maxBytes: safe.delivery?.batching?.maxBytes ?? BATCH_MAX_BYTES_PRODUCTION
	}) : undefined
	const resilience = createResilience(safe.delivery, mode === 'batched')
	const exporter = destination.provider === 'custom'
		? adaptCustomExporter(destination.exporter)
		: (await import('../sinks')).createOtlpRemoteExporter(Object.freeze({
			endpoint: destination.endpoint,
			...(destination.headers ? {headers: destination.headers} : {})
		}), clock)
	const processor = await createCustomProcessor({
		mode,
		clock,
		exporter,
		...(batching ? {batching} : {}),
		...(resilience ? {resilience} : {}),
		...(safe.errors ? {errors: safe.errors} : {}),
		...(safe.metrics ? {metrics: safe.metrics} : {}),
		...(safe.logger ? {logger: safe.logger} : {})
	})
	return createCustomTracingRuntime({
		clock,
		sampler,
		processor,
		...(safe.errors ? {errors: safe.errors} : {}),
		...(safe.metrics ? {metrics: safe.metrics} : {}),
		...(safe.logger ? {logger: safe.logger} : {}),
		...(safe.lifecycle ? {lifecycle: safe.lifecycle} : {}),
		...(safe.resource ? {resource: safe.resource} : {}),
		...(safe.redaction?.additionalRules ? {redactionRules: safe.redaction.additionalRules} : {}),
		limits: {
			maxAttributesPerSpan: clampInteger(safe.limits?.maxAttributesPerSpan, 128, 128),
			maxEventsPerSpan: clampInteger(safe.limits?.maxEventsPerSpan, 64, 64),
			maxAttrBytes: clampInteger(safe.limits?.maxAttributeBytes, 8_192, 8_192)
		}
	})
}

function createSampling(policy: CustomTracingOptions['sampling']): Sampler {
	if (!policy) return createParentBasedSampler(createAlwaysOnSampler())
	if (policy.strategy === 'custom') {
		if ('rate' in policy && policy.rate !== undefined) {
			throw new Error('Custom tracing sampling must configure either a sampler or a fixed rate, not both')
		}
		const decide = captureCapability<Parameters<Sampler['decide']>, ReturnType<Sampler['decide']>>(policy.sampler, 'decide')
		if (!decide) throw new Error('Custom tracing sampler must provide decide()')
		return createParentBasedSampler(Object.freeze({decide}))
	}
	if (policy.strategy !== 'fixed-rate') throw new Error('Unknown custom tracing sampling strategy')
	if ('sampler' in policy && policy.sampler !== undefined) {
		throw new Error('Fixed-rate tracing sampling must not also configure a custom sampler')
	}
	if (!Number.isFinite(policy.rate) || policy.rate < 0 || policy.rate > 1) throw new Error('Tracing sampling rate must be between 0 and 1')
	return createParentBasedSampler(createProbabilisticSampler({ratio: policy.rate}))
}

function validateDestination(destination: CustomTracingOptions['destination']): void {
	if (destination.provider === 'custom') {
		if (!destination.exporter || 'endpoint' in destination || 'headers' in destination) {
			throw new Error('Custom tracing destination must contain only a custom exporter')
		}
		return
	}
	if (destination.provider === 'otlp') {
		if (typeof destination.endpoint !== 'string' || 'exporter' in destination) {
			throw new Error('OTLP tracing destination must contain only endpoint and optional headers')
		}
		return
	}
	throw new Error('Unknown custom tracing destination provider')
}

function adaptCustomExporter(exporter: TraceExporter): SpanExporterPort {
	const exportBatch = captureCapability<Parameters<TraceExporter['export']>, ReturnType<TraceExporter['export']>>(exporter, 'export')
	const flush = captureCapability<[], Promise<void>>(exporter, 'flush')
	const shutdown = captureCapability<[], Promise<void>>(exporter, 'shutdown')
	if (!exportBatch) throw new Error('Custom tracing exporter must provide export()')
	return Object.freeze({
		export: async(batch: readonly SpanRecord[]) => {
			const result = await invokeNativeAsync<Awaited<ReturnType<TraceExporter['export']>>>(
				() => exportBatch(batch), 'Custom tracing exporter export'
			)
			return result === undefined ? {status: 'success' as const, acceptedCount: batch.length} : result
		},
		...(flush ? {flush: () => invokeNativeAsync<void>(flush, 'Custom tracing exporter flush', true)} : {}),
		shutdown: async() => {
			if (shutdown) await invokeNativeAsync<void>(shutdown, 'Custom tracing exporter shutdown', true)
		}
	})
}

function createResilience(delivery: CustomTracingOptions['delivery'], boundedDefaults: boolean) {
	if (delivery?.circuitBreaker !== undefined && delivery.circuitBreaker !== false && (
		!delivery.circuitBreaker || typeof delivery.circuitBreaker !== 'object' || Array.isArray(delivery.circuitBreaker)
	)) throw new Error('Tracing circuitBreaker must be false or a policy object')
	if (!boundedDefaults && !delivery?.retry && delivery?.circuitBreaker === false && !delivery.backpressure) return undefined
	if (!boundedDefaults && !delivery?.retry && !delivery?.backpressure && delivery?.circuitBreaker === undefined) return undefined
	const circuit = delivery?.circuitBreaker === false ? undefined : delivery?.circuitBreaker
	const retryPolicy = delivery?.retry ?? (boundedDefaults ? {
		maxAttempts: RETRY_MAX_ATTEMPTS_PRODUCTION,
		baseDelayMs: RETRY_BASE_DELAY_PRODUCTION,
		multiplier: RETRY_MULTIPLIER_PRODUCTION,
		maxDelayMs: RETRY_MAX_DELAY_PRODUCTION,
		jitter: RETRY_JITTER_PRODUCTION,
		attemptTimeoutMs: 10_000
	} : undefined)
	const backpressure = delivery?.backpressure ?? (boundedDefaults ? {
		tokenBucketRate: TOKEN_BUCKET_RATE_PRODUCTION,
		tokenBucketBurst: TOKEN_BUCKET_BURST_PRODUCTION
	} : undefined)
	const breaker = circuit ?? (boundedDefaults && delivery?.circuitBreaker !== false ? {
		failureThreshold: BREAKER_THRESHOLD_PRODUCTION,
		halfOpenAfterMs: BREAKER_HALF_OPEN_TIMEOUT_PRODUCTION
	} : undefined)
	return Object.freeze({
		...(retryPolicy ? {retryPolicy} : {}),
		...(backpressure ? {
			tokenBucketRate: backpressure.tokenBucketRate,
			tokenBucketBurst: backpressure.tokenBucketBurst
		} : {}),
		...(breaker ? {
			breakerThreshold: breaker.failureThreshold,
			breakerHalfOpenTimeout: breaker.halfOpenAfterMs
		} : {})
	})
}

type DeliveryResilience = Pick<ResilientExporterOptions,
	'retryPolicy' | 'tokenBucketRate' | 'tokenBucketBurst' | 'breakerThreshold' | 'breakerHalfOpenTimeout'>

async function createCustomProcessor(options: {
	readonly mode: 'direct' | 'batched'
	readonly clock: Clock
	readonly exporter: SpanExporterPort
	readonly batching?: BatchingConfig
	readonly resilience?: DeliveryResilience
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
}) {
	if (options.mode === 'direct' && !options.resilience) {
		const {SimpleProcessor} = await import('../core/simple-processor')
		return new SimpleProcessor(options.exporter)
	}
	if (options.mode === 'direct') {
		const {createCustomDirectTracingProcessor} = await import('../core/custom-direct-delivery')
		return createCustomDirectTracingProcessor({...options, resilience: options.resilience!})
	}
	const {createCustomBatchedTracingProcessor} = await import('../core/custom-batched-delivery')
	return createCustomBatchedTracingProcessor({
		...options,
		batching: options.batching!,
		resilience: options.resilience!
	})
}

function clampInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || value < 0) throw new Error('Tracing limits must be non-negative safe integers')
	return Math.min(value, maximum)
}
