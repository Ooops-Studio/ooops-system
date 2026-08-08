import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {
	TracingContext,
	SpanContext
} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {
	SpanOptions,
	TracingSpan
} from '@ooopsstudio/core/ports/tracing'
import {
	createNativePromise,
	observeNativePromiseSettlement,
	raceNativePromises
} from '@ooopsstudio/core/runtime/async/native-promise'
import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {pushNativeArray} from '@ooopsstudio/core/runtime/collections/native-collections'
import type {AsyncContextStore} from '@ooopsstudio/core/runtime/context'
import {isPlainObject} from '@ooopsstudio/core/utils/guards'
import type {IdGenerator} from '@ooopsstudio/core/utils/tracing'
import type {Sampler} from '@ooopsstudio/core/utils/tracing'

import type {ManagedTracing} from '../public/types'
import type {SpanProcessorPort} from '../types/ports'
import {captureCapability, captureClock} from '../utils/capabilities'
import {validateTracerOptions} from '../utils/config-validation'
import {createTracingOnError} from '../utils/on-error'

import {adoptNativeAsyncResult, captureTimerOwnership, clearTimerSafely, invokeNativeAsync} from './processor-utils'
import type {TimerOwnership} from './processor-utils'
import {isSafeSpanText, snapshotSpanAttributes, snapshotSpanContext} from './span-recorder-safety'
import {TelemetryManager} from './telemetry'
import {createTracerAdmission} from './tracer-admission'
import {createTracerObservability} from './tracer-observability'
import {createTracerPropagation} from './tracer-propagation'
import {createTracerSpanTools} from './tracer-span-tools'
const VALID_SPAN_KINDS = new Set(['internal', 'server', 'client', 'producer', 'consumer'])
export interface TracerOptions {
	clock: Clock
	contextStore: AsyncContextStore<TracingContext | SpanContext | undefined>
	idGen: IdGenerator
	sampler: Sampler
	processor: SpanProcessorPort
	errors?: Errors
	metrics?: {
		increment(name: string, tags?: Record<string, string>, count?: number): void
		record(name: string, value: number, tags?: Record<string, string>): void
	}
	logger?: {
		warn(message: string, attributes?: LogAttributes): void
	}
	limits?: {
		maxAttributesPerSpan?: number
		maxEventsPerSpan?: number
		maxAttrBytes?: number
	}
	redactAttributes?: (attrs: LogAttributes) => LogAttributes
	resource?: LogAttributes
}
export function createTracer(options: TracerOptions): ManagedTracing {
	validateTracerOptions(options)
	const timers = captureTimerOwnership()
	const {
		clock: rawClock,
		contextStore: rawContextStore,
		idGen: rawIdGen,
		sampler: rawSampler,
		processor: rawProcessor,
		errors: rawErrors,
		metrics: rawMetrics,
		logger: rawLogger,
		limits = {},
		redactAttributes,
		resource: rawResource
	} = options
	const clock = captureClock(rawClock)
	const contextGet = captureCapability<[], TracingContext | SpanContext | undefined>(rawContextStore, 'get')
	const contextRun = captureCapability<Parameters<typeof rawContextStore.run>, ReturnType<typeof rawContextStore.run>>(
		rawContextStore,
		'run'
	)
	const nextTraceId = captureCapability<[], string>(rawIdGen, 'nextTraceId')
	const nextSpanId = captureCapability<[], string>(rawIdGen, 'nextSpanId')
	const decide = captureCapability<Parameters<Sampler['decide']>, ReturnType<Sampler['decide']>>(rawSampler, 'decide')
	const processorOnEnd = captureCapability<Parameters<SpanProcessorPort['onEnd']>, ReturnType<SpanProcessorPort['onEnd']>>(rawProcessor, 'onEnd')
	const processorFlush = captureCapability<[], Promise<void>>(rawProcessor, 'flush')
	const processorShutdown = captureCapability<[], Promise<void>>(rawProcessor, 'shutdown')
	const processorGetQueueSize = captureCapability<[], number>(rawProcessor, 'getQueueSize')
	const processorSetObserver = captureCapability<Parameters<NonNullable<SpanProcessorPort['setObserver']>>, void>(rawProcessor, 'setObserver')
	if (!contextGet || !contextRun || !nextTraceId || !nextSpanId || !decide || !processorOnEnd || !processorFlush || !processorShutdown) {
		throw new Error('Tracing runtime capabilities must be data methods')
	}
	const contextStore = Object.freeze({get: contextGet, run: contextRun}) as AsyncContextStore<TracingContext | SpanContext | undefined>
	const idGen = Object.freeze({nextTraceId, nextSpanId})
	const sampler = Object.freeze({decide})
	const processor = Object.freeze({
		onEnd: processorOnEnd,
		flush: processorFlush,
		shutdown: processorShutdown,
		...(processorGetQueueSize ? {getQueueSize: processorGetQueueSize} : {}),
		...(processorSetObserver ? {setObserver: processorSetObserver} : {})
	}) as SpanProcessorPort
	const report = captureCapability<Parameters<Errors['report']>, ReturnType<Errors['report']>>(rawErrors, 'report')
	const errors = report ? Object.freeze({report}) as Errors : undefined
	const increment = captureCapability<[string, Record<string, string>?, number?], void>(rawMetrics, 'increment')
	const record = captureCapability<[string, number, Record<string, string>?], void>(rawMetrics, 'record')
	const metrics = increment || record ? Object.freeze({
		increment: increment ?? (() => undefined),
		record: record ?? (() => undefined)
	}) : undefined
	const warn = captureCapability<[string, LogAttributes?], void>(rawLogger, 'warn')
	const logger = warn ? Object.freeze({warn}) : undefined
	const resource = rawResource ? snapshotSpanAttributes(rawResource, 64, 16_000) : undefined
	const maxAttributes = limits.maxAttributesPerSpan ?? 64
	const maxEvents = limits.maxEventsPerSpan ?? 32
	const maxAttrBytes = limits.maxAttrBytes ?? 4_000
	const snapshotOptions = (value: unknown): SpanOptions => {
		try {
			if (!isPlainObject(value)) throw new TypeError()
			const allowed = new Set(['parent', 'kind', 'attributes', 'startTime'])
			const result: Record<string, unknown> = {}
			let scanned = 0
			for (const key in value) {
				if (++scanned > allowed.size) throw new TypeError()
				if (key.length > 64) throw new TypeError()
				if (!Object.hasOwn(value, key)) continue
				const descriptor = Object.getOwnPropertyDescriptor(value, key)
				if (!descriptor?.enumerable || !allowed.has(key) || !('value' in descriptor)) throw new TypeError()
				result[key] = key === 'attributes' && descriptor.value
					? snapshotSpanAttributes(descriptor.value as LogAttributes, maxAttributes, maxAttrBytes)
					: descriptor.value
			}
			return Object.freeze(result) as SpanOptions
		} catch { throw new TypeError('Tracing span options must be a closed plain data object') }
	}
	const prepareSpan = (name: string, rawOptions: unknown): SpanOptions => {
		if (!isSafeSpanText(name, 256)) throw new Error('Span name must be 1-256 characters without control characters')
		const prepared = snapshotOptions(rawOptions)
		if (prepared.kind !== undefined && !VALID_SPAN_KINDS.has(prepared.kind)) {
			throw new Error('Tracing span kind must be internal, server, client, producer, or consumer')
		}
		if (prepared.startTime !== undefined && (
			typeof prepared.startTime !== 'number' || !Number.isFinite(prepared.startTime) || prepared.startTime < 0 ||
			!Number.isSafeInteger(Math.trunc(prepared.startTime))
		)) throw new Error('Tracing span startTime must be a finite non-negative safe epoch timestamp')
		return prepared
	}
	const telemetry = new TelemetryManager(metrics)
	const reportInternalError = createTracingOnError(errors, {stage: 'tracing'})
	let runtimeState: 'running' | 'draining' | 'closed' = 'running'
	let shutdownPromise: Promise<void> | undefined
	let activeDrainAbandoned = false
	let processorFinalized = false
	let processorFlushAttempt: Promise<void> | undefined
	let processorFinalizationAttempt: Promise<void> | undefined
	const ownedContexts = new WeakSet<object>()
	const admission = createTracerAdmission({
		sampler,
		isShutdownRequested: () => runtimeState !== 'running',
		reportInternalError
	})
	try { isolateUnexpectedThenable(processor.setObserver?.({
		onExported: (count) => telemetry.recordSpansExported(count),
		onDropped: (count, _error, metricsReported) => {
			telemetry.recordSpansDropped(count, 'processor', !metricsReported)
		},
		onExportFailure: (error) => telemetry.recordExportFailure(error),
		onPartialDelivery: (error) => telemetry.recordPartialDelivery(error),
		onRetry: () => telemetry.recordRetry(),
		onSinkState: (state) => telemetry.setSinkState(state)
	})) } catch(error) { reportInternalError(error, {operation: 'processor-observer'}) }
	const createRecorderOptions = (startTime?: number) => ({
		clock,
		maxAttributes,
		maxEvents,
		maxAttrBytes,
		...(startTime !== undefined ? {startTime} : {}),
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(errors ? {errors} : {}),
		...(redactAttributes ? {redactAttributes} : {})
	})
	const getActiveContext = (): TracingContext | undefined => {
		try {
			const current = contextStore.get() as TracingContext | SpanContext | undefined
			if (!current || typeof current !== 'object') return undefined
			if (ownedContexts.has(current)) return current as TracingContext
			const directContext = snapshotSpanContext(current as SpanContext)
			if (directContext) return {spanContext: directContext}
			const spanDescriptor = Object.getOwnPropertyDescriptor(current, 'spanContext')
			const baggageDescriptor = Object.getOwnPropertyDescriptor(current, 'baggage')
			if ((spanDescriptor && !('value' in spanDescriptor)) || (baggageDescriptor && !('value' in baggageDescriptor))) return undefined
			const spanContext = spanDescriptor && 'value' in spanDescriptor
				? snapshotSpanContext(spanDescriptor.value as SpanContext) : undefined
			if (spanDescriptor && !spanContext) return undefined
			return {
				...(spanContext ? {spanContext} : {}),
				...(baggageDescriptor && 'value' in baggageDescriptor && baggageDescriptor.value && typeof baggageDescriptor.value === 'object'
					? {baggage: baggageDescriptor.value as LogAttributes} : {})
			}
		} catch(error) {
			reportInternalError(error, {operation: 'active-context'})
			return undefined
		}
	}
	const getActiveSpanContext = (): SpanContext | undefined => {
		return getActiveContext()?.spanContext
	}
	const spanTools = createTracerSpanTools({
		clock,
		idGen,
		processor,
		telemetry,
		getActiveSpanContext,
		createRecorderOptions,
		...(logger ? {logger} : {}),
		...(resource ? {resource} : {}),
		onProcessorError: (error) => reportInternalError(error, {operation: 'processor-on-end'}),
		onSpanStarted: (kind) => telemetry.spanStarted(kind),
		onSpanEnded: () => telemetry.spanEnded()
	})
	telemetry.setQueueReader(() => processor.getQueueSize?.() ?? 0)
	const shouldDropSpan = admission.shouldDropSpan
	const {
		createSpanContext, resolveParentContext, createNoOpSpan, createRecordingSpan,
		createTemporaryRecorder, createCorrelatedRecorder, submitRecord,
		deleteActiveSpan, getActiveSpan, setActiveSpan, activateSpan, deactivateSpan
	} = spanTools
	const propagation = createTracerPropagation({
		contextStore,
		getActiveContext,
		markContextOwned: (context) => { ownedContexts.add(context) },
		...(errors ? {errors} : {}),
		...(redactAttributes ? {redactAttributes} : {})
	})
	const getCurrentActiveSpan = (): TracingSpan | undefined => {
		const context = getActiveContext()
		return context?.spanContext ? getActiveSpan(context.spanContext) : undefined
	}
	const observability = createTracerObservability({
		getActiveSpan: getCurrentActiveSpan,
		getActiveSpanContext,
		createTemporaryRecorder,
		createCorrelatedRecorder,
		submitRecord,
		recordSpanProcessed: () => telemetry.recordSpanProcessed(),
		canCreateDetachedRecord: () => runtimeState === 'running',
		reportInternalError,
		maxAttributes,
		maxAttrBytes
	})
	const tracing: ManagedTracing = {
		currentTraceId: () => {
			return getActiveSpanContext()?.traceId
		},
		...observability,
		getActiveSpan: () => {
			return getCurrentActiveSpan()
		},
		inSpan: async(name, fn, options = {}) => {
			options = prepareSpan(name, options)
			const explicitParent = options.parent !== undefined
			const parent = explicitParent ? options.parent : getActiveSpanContext() ?? null
			const parentCtx = resolveParentContext(parent)
			const context = createSpanContext(parentCtx ?? null)
			const drop = shouldDropSpan(options.kind ?? 'internal', parentCtx, name, options.attributes)
			if (drop) {
				/* v8 ignore next -- defensive branch not constructible through the public tracing API */
				context.traceFlags = (context.traceFlags ?? 0) & ~0x1 // Clear sampled bit
			} else {
				context.traceFlags = (context.traceFlags ?? 0) | 0x1
			}
			const activeContext = getActiveContext()
			const mayInheritAmbientBaggage = !explicitParent || (
				parentCtx !== undefined && activeContext?.spanContext?.traceId === parentCtx.traceId
			)
			const inheritedBaggage = mayInheritAmbientBaggage && activeContext?.baggage
				? propagation.getBaggage() : undefined
			const nextContext: TracingContext = {
				spanContext: context,
				/* v8 ignore next -- defensive branch not constructible through the public tracing API */
				...(inheritedBaggage && Object.keys(inheritedBaggage).length > 0 ? {baggage: inheritedBaggage} : {})
			}
			ownedContexts.add(nextContext)
			if (drop) {
				telemetry.recordSpansDropped(1, 'sampling-or-lifecycle')
			}
			const contextResult = contextStore.run(nextContext, async() => {
				if (drop) {
					const noOpSpan = createNoOpSpan(context)
					setActiveSpan(context, noOpSpan)
					try {
						return await fn(noOpSpan)
					} finally {
						deleteActiveSpan(context)
					}
				}
				const span = createRecordingSpan(name, options.kind ?? 'internal', context, parentCtx, options)
				setActiveSpan(context, span)
				try {
					const result = await fn(span)
					try { span.end() } catch(error) {
						deleteActiveSpan(context)
						reportInternalError(error, {operation: 'end-span'})
					}
					return result
				} catch(error) {
					try {
						if (!('hasRecordedException' in span) || !(span as TracingSpan & {hasRecordedException(): boolean}).hasRecordedException()) {
							span.recordException(error)
						}
					} catch(internalError) { reportInternalError(internalError, {operation: 'record-span-exception'}) }
					try { span.end() } catch(internalError) {
						deleteActiveSpan(context)
						reportInternalError(internalError, {operation: 'end-span'})
					}
					throw error
				}
			})
			return await adoptNativeAsyncResult(contextResult, 'Tracing context store run')
		},
		startSpan: (name, options = {}) => {
			options = prepareSpan(name, options)
			const parent = options.parent !== undefined ? options.parent : getActiveSpanContext() ?? null
			const parentCtx = resolveParentContext(parent)
			const context = createSpanContext(parentCtx ?? null)
			const drop = shouldDropSpan(options.kind ?? 'internal', parentCtx, name, options.attributes)
			if (drop) {
				/* v8 ignore next -- defensive branch not constructible through the public tracing API */
				context.traceFlags = (context.traceFlags ?? 0) & ~0x1 // Clear sampled bit
				telemetry.recordSpansDropped(1, 'sampling-or-lifecycle')
				const noOpSpan = createNoOpSpan(context)
				setActiveSpan(context, noOpSpan)
				return noOpSpan
			}
			context.traceFlags = (context.traceFlags ?? 0) | 0x1
			const span = createRecordingSpan(name, options.kind ?? 'internal', context, parentCtx, options)
			setActiveSpan(context, span)
			return span
		},
		withSpan: async(span, fn) => {
			const context = resolveParentContext(span)
			if (!context) throw new Error('Unable to activate a span without a valid context')
			activateSpan(context, span)
			try {
				const activeContext = getActiveContext()
				const inheritedBaggage = activeContext?.baggage && activeContext.spanContext?.traceId === context.traceId
					? propagation.getBaggage() : undefined
				const nextContext: TracingContext = {
					spanContext: context,
					/* v8 ignore next -- defensive branch not constructible through the public tracing API */
					...(inheritedBaggage && Object.keys(inheritedBaggage).length > 0 ? {baggage: inheritedBaggage} : {})
				}
				ownedContexts.add(nextContext)
				const result = await adoptNativeAsyncResult<Awaited<ReturnType<typeof fn>>>(
					contextStore.run(nextContext, async() => await fn()),
					'Tracing context store run'
				)
				deactivateSpan(context, span)
				return result
			} catch(error) {
				deactivateSpan(context, span)
				throw error
			}
		},
		injectHeaders: propagation.injectHeaders,
		extractHeaders: propagation.extractHeaders,
		withExtractedHeaders: propagation.withExtractedHeaders,
		getBaggage: propagation.getBaggage,
		setBaggage: propagation.setBaggage,
		clearBaggage: propagation.clearBaggage,
		getStatus: () => telemetry.getStatus(),
		forceFlush: async() => {
			if (runtimeState === 'closed') return
			if (runtimeState === 'draining') {
				if (shutdownPromise) return shutdownPromise
				throw new Error('Tracing forceFlush is unavailable after shutdown admission closes')
			}
			while (processorFlushAttempt) {
				const activeAttempt = processorFlushAttempt
				await withBoundedWait(activeAttempt, 10_000, 'Tracing forceFlush timed out', timers)
			}
			// Admission may have closed while this caller was queued behind an
			// earlier flush. Do not start new processor work during finalization.
			if (runtimeState !== 'running') {
				if (shutdownPromise) return shutdownPromise
				throw new Error('Tracing forceFlush is unavailable after shutdown admission closes')
			}
			const pending = invokeNativeAsync<void>(() => processor.flush(), 'Tracing processor flush', true)
			processorFlushAttempt = pending
			observeNativePromiseSettlement(pending,
				() => { if (processorFlushAttempt === pending) processorFlushAttempt = undefined },
				() => { if (processorFlushAttempt === pending) processorFlushAttempt = undefined }
			)
			await withBoundedWait(pending, 10_000, 'Tracing forceFlush timed out', timers)
		},
		shutdown: async() => {
			if (runtimeState === 'closed') return
			runtimeState = 'draining'
			telemetry.setRuntimeState('draining')
			if (!shutdownPromise) {
				shutdownPromise = (async() => {
					const failures: unknown[] = []
					if (!activeDrainAbandoned && !processorFinalized) {
						try {
							await withBoundedWait(
								telemetry.waitForIdle(), 10_000, 'Tracing active span drain timed out', timers
							)
						} catch(error) {
							activeDrainAbandoned = true
							pushNativeArray(failures, error)
						}
					}
					if (processorFlushAttempt && !processorFinalized) {
						try {
							await withBoundedWait(
								processorFlushAttempt,
								10_000,
								'Tracing active forceFlush drain timed out',
								timers
							)
						} catch(error) { pushNativeArray(failures, error) }
					}
					// Resource cleanup must run even when application-owned spans never
					// finish. A later shutdown retries only unfinished processor cleanup.
					if (!processorFinalized) {
						try {
							if (!processorFinalizationAttempt) {
								const pending = invokeNativeAsync<void>(
									() => processor.shutdown(), 'Tracing processor shutdown', true
								)
								processorFinalizationAttempt = pending
								// A real processor rejection permits a fresh cleanup attempt. A timeout
								// leaves this promise installed so retries join the same ambiguous I/O
								// instead of starting concurrent shutdown operations.
								observeNativePromiseSettlement(pending, () => undefined, () => {
									if (processorFinalizationAttempt === pending) processorFinalizationAttempt = undefined
								})
							}
							await withBoundedWait(
								processorFinalizationAttempt,
								30_000,
								'Tracing processor shutdown timed out',
								timers
							)
							processorFinalized = true
							processorFinalizationAttempt = undefined
						} catch(error) { pushNativeArray(failures, error) }
					}
					if (failures.length === 1) throw failures[0]
					if (failures.length > 1) throw new AggregateError(failures, 'Tracing shutdown finalization failed')
					admission.dispose()
					runtimeState = 'closed'
					telemetry.setRuntimeState('closed')
				})()
			}
			try {
				await shutdownPromise
			} catch(error) {
				shutdownPromise = undefined
				telemetry.markFinalizationFailure(error)
				throw error
			}
		}
	}
	return tracing
}

async function withBoundedWait(
	promise: Promise<void>, timeoutMs: number, message: string, timers: TimerOwnership
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await raceNativePromises([
			promise,
			createNativePromise<never>((_resolve, reject) => {
				timer = timers.schedule(() => reject(new Error(message)), timeoutMs)
			})
		])
	} finally {
		clearTimerSafely(timer, timers)
	}
}
