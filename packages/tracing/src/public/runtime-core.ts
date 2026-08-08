import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {SpanContext, TracingContext} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {createAsyncContextStore} from '@ooopsstudio/core/runtime/context'
import {createIdGenerator} from '@ooopsstudio/core/utils/tracing'
import type {Sampler} from '@ooopsstudio/core/utils/tracing'

import {adoptNativeAsyncResult, invokeNativeAsync} from '../core/processor-utils'
import {createTracer} from '../core/tracer'
import {detectResource} from '../features/resources/resource-detector'
import type {SpanProcessorPort} from '../types/ports'
import {captureCapability} from '../utils/capabilities'
import {reportTracingShutdownError} from '../utils/on-error'

import {registerTracingLifecycle} from './lifecycle-wiring'
import {observabilityResourceToTracingResource} from './observability'
import type {ManagedTracing} from './types'

/** Shared core assembly. Preset-specific policy belongs in the runtime wrappers. */
export interface TracingCoreRuntimeOptions {
	readonly clock: Clock
	readonly sampler: Sampler
	readonly processor: SpanProcessorPort
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
	readonly lifecycle?: LifecyclePort
	readonly resource?: ObservabilityResource
	readonly redactAttributes: (attributes: LogAttributes) => LogAttributes
	readonly limits: {maxAttributesPerSpan: number; maxEventsPerSpan: number; maxAttrBytes: number}
	readonly preset: 'development' | 'production' | 'custom'
}

export async function createTracingCoreRuntime(options: TracingCoreRuntimeOptions): Promise<ManagedTracing> {
	let tracer: ManagedTracing | undefined
	try {
		const detected = detectResource()
		const sharedResource = observabilityResourceToTracingResource(options.resource)
		const increment = captureCapability<Parameters<NonNullable<MetricsPort['increment']>>, ReturnType<NonNullable<MetricsPort['increment']>>>(options.metrics, 'increment')
		const record = captureCapability<Parameters<NonNullable<MetricsPort['record']>>, ReturnType<NonNullable<MetricsPort['record']>>>(options.metrics, 'record')
		const warn = captureCapability<Parameters<Logging['warn']>, ReturnType<Logging['warn']>>(options.logger, 'warn')
		tracer = createTracer({
			clock: options.clock,
			contextStore: createAsyncContextStore<TracingContext | SpanContext | undefined>(),
			idGen: createIdGenerator(),
			sampler: options.sampler,
			processor: options.processor,
			limits: options.limits,
			...(options.errors ? {errors: options.errors} : {}),
			...(increment || record ? {metrics: {
				increment: increment ?? (() => undefined),
				record: record ?? (() => undefined)
			}} : {}),
			...(warn ? {logger: {warn}} : {}),
			resource: {...detected, ...(sharedResource ?? {})},
			redactAttributes: options.redactAttributes
		})
		const shutdown = captureCapability<[], Promise<void>>(tracer, 'shutdown')
		let disposeLifecycle = (): void => undefined
		if (shutdown) {
			tracer.shutdown = async() => {
				await adoptNativeAsyncResult<void>(shutdown(), 'Tracing runtime shutdown', true)
				disposeLifecycle()
			}
		}
		// Register after installing the managed wrapper, so lifecycle-triggered
		// shutdown also removes both subscriptions exactly once.
		disposeLifecycle = registerTracingLifecycle(options.lifecycle, tracer, options.errors, options.preset)
		return tracer
	} catch(error) {
		try {
			// Processor ownership begins before resource/context/tracer assembly.
			// If that assembly fails, no ManagedTracing handle exists through which
			// the caller could release a resource-owning custom exporter.
			const shutdown = tracer
				? captureCapability<[], Promise<void>>(tracer, 'shutdown')
				: captureCapability<[], Promise<void>>(options.processor, 'shutdown')
			if (shutdown) await invokeNativeAsync<void>(shutdown, 'Tracing runtime cleanup', true)
		} catch(shutdownError) {
			reportTracingShutdownError(options.errors, shutdownError, {preset: options.preset})
			throw new AggregateError([error, shutdownError], 'Tracing runtime initialization and cleanup both failed')
		}
		throw error
	}
}
