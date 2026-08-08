import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext, SpanKind, SpanLink, SpanStatus} from '@ooopsstudio/core/contracts/tracing'
import type {SpanOptions, TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {
	deleteNativeWeakMap,
	getNativeWeakMap,
	setNativeWeakMap
} from '@ooopsstudio/core/runtime/collections/native-collections'
import type {IdGenerator} from '@ooopsstudio/core/utils/tracing'

import type {SpanProcessorPort} from '../types/ports'
import {captureCapability} from '../utils/capabilities'

import {SpanRecorder, type SpanRecorderOptions} from './span-recorder'
import {snapshotSpanContext} from './span-recorder-safety'
import type {TelemetryManager} from './telemetry'

type ActiveSpanEntry = {span: TracingSpan; activations: number}

const activeSpanMap = new WeakMap<SpanContext, ActiveSpanEntry>()

interface TracerSpanToolsOptions {
	clock: Clock
	idGen: IdGenerator
	processor: SpanProcessorPort
	telemetry: TelemetryManager
	getActiveSpanContext(): SpanContext | undefined
	createRecorderOptions(startTime?: number): SpanRecorderOptions
	logger?: {warn(message: string, attributes?: LogAttributes): void}
	resource?: LogAttributes
	onProcessorError?(error: unknown): void
	onSpanStarted?(kind: SpanKind): void
	onSpanEnded?(): void
}

const isValidSpanId = (spanId: string | undefined): spanId is string =>
	typeof spanId === 'string' && /^[0-9a-f]{16}$/u.test(spanId) && !/^0{16}$/u.test(spanId)
const isValidTraceId = (traceId: string | undefined): traceId is string =>
	typeof traceId === 'string' && /^[0-9a-f]{32}$/u.test(traceId) && !/^0{32}$/u.test(traceId)

export function createTracerSpanTools(options: TracerSpanToolsOptions) {
	const {
		idGen, processor, telemetry, getActiveSpanContext, createRecorderOptions,
		logger, resource, onProcessorError, onSpanStarted, onSpanEnded
	} = options
	const submitRecord = (record: import('@ooopsstudio/core/contracts/tracing').SpanRecord): void => {
		try { isolateUnexpectedThenable(processor.onEnd(record)) } catch(error) {
			try { isolateUnexpectedThenable(onProcessorError?.(error)) } catch { /* diagnostics are isolated */ }
			try { telemetry.recordExportFailure() } catch { /* metrics are isolated */ }
		}
	}
	const resolveParentContext = (parent?: SpanContext | TracingSpan | null): SpanContext | undefined => {
		if (parent === null) return undefined
		const source = parent === undefined ? getActiveSpanContext() : parent
		if (!source) return undefined
		let candidate: SpanContext
		try {
			const getContext = captureCapability<[], SpanContext>(source, 'getContext')
			candidate = getContext ? getContext() : source as SpanContext
		} catch(error) {
			throw new Error('Unable to read parent span context', {cause: error})
		}
		const snapshot = snapshotSpanContext(candidate)
		if (!snapshot) throw new Error('Parent span context must contain valid non-zero IDs and valid W3C fields')
		return snapshot
	}
	const createSpanContext = (parent?: SpanContext | TracingSpan | null): SpanContext => {
		const parentContext = resolveParentContext(parent)
		const spanId = idGen.nextSpanId()
		if (!isValidSpanId(spanId)) throw new Error('Tracing ID generator returned an invalid span ID')
		if (parentContext) {
			return {
				traceId: parentContext.traceId,
				spanId,
				...(isValidSpanId(parentContext.spanId) ? {parentSpanId: parentContext.spanId} : {}),
				/* v8 ignore next -- defensive branch not constructible through the public tracing API */
				...(parentContext.traceFlags !== undefined ? {traceFlags: parentContext.traceFlags} : {}),
				/* v8 ignore next -- defensive branch not constructible through the public tracing API */
				...(parentContext.traceState !== undefined ? {traceState: parentContext.traceState} : {})
			}
		}
		const traceId = idGen.nextTraceId()
		if (!isValidTraceId(traceId)) throw new Error('Tracing ID generator returned an invalid trace ID')
		return {traceId, spanId, traceFlags: 1}
	}
	const deleteActiveSpan = (context: SpanContext): void => {
		deleteNativeWeakMap(activeSpanMap, context)
	}
	const createNoOpSpan = (context: SpanContext): TracingSpan => ({
		getContext: () => ({...context}),
		setAttribute: () => {},
		addEvent: () => {},
		recordException: () => {},
		setStatus: () => {},
		end: () => deleteActiveSpan(context)
	})
	const createRecordingSpan = (
		name: string,
		kind: SpanKind,
		context: SpanContext,
		parentContext: SpanContext | undefined,
		spanOptions?: SpanOptions
	): TracingSpan & {addLink(link: SpanLink): void; hasRecordedException(): boolean} => {
		const recorder = new SpanRecorder(name, kind, context, createRecorderOptions(spanOptions?.startTime))
		onSpanStarted?.(kind)
		let ended = false
		let exceptionRecorded = false
		recorder.setParentContext(parentContext)
		if (spanOptions?.attributes) recorder.setAttributes(spanOptions.attributes)
		if (resource) recorder.setResource(resource)
		const span = {
			getContext: () => recorder.getContext(),
			setAttribute: (key: string, value: unknown) => recorder.setAttribute(key, value),
			addEvent: (eventName: string, attrs?: LogAttributes) => recorder.addEvent(eventName, attrs),
			recordException: (error: unknown, attrs?: LogAttributes) => {
				exceptionRecorded = true
				recorder.recordException(error, attrs)
			},
			hasRecordedException: () => exceptionRecorded,
			setStatus: (status: SpanStatus) => recorder.setStatus(status),
			addLink: (link: SpanLink) => recorder.addLink(link),
			end: (endTime?: number) => {
				if (ended) return
				let record: import('@ooopsstudio/core/contracts/tracing').SpanRecord
				try { record = recorder.end(endTime) } finally {
					ended = true
					deleteActiveSpan(context)
					onSpanEnded?.()
				}
				submitRecord(record)
				if (logger && record.status.code === 'error') {
					try {
						isolateUnexpectedThenable(logger.warn('span', {
							name: record.name,
							...(record.durationMs !== undefined ? {duration: record.durationMs} : {}),
							status: record.status.code,
							traceId: record.context.traceId
						}))
					} catch(error) { try { isolateUnexpectedThenable(onProcessorError?.(error)) } catch { /* diagnostics are isolated */ } }
				}
			}
		}
		return span
	}
	const createTemporaryRecorder = (name: string, kind: SpanKind, parentContext: SpanContext): SpanRecorder => {
		const recorder = new SpanRecorder(name, kind, createSpanContext(parentContext), createRecorderOptions())
		recorder.setParentContext(parentContext)
		if (resource) recorder.setResource(resource)
		return recorder
	}
	const createCorrelatedRecorder = (name: string, kind: SpanKind, traceId: string): SpanRecorder => {
		if (!isValidTraceId(traceId)) throw new Error('Correlated trace ID must be a valid non-zero W3C trace ID')
		const spanId = idGen.nextSpanId()
		if (!isValidSpanId(spanId)) throw new Error('Tracing ID generator returned an invalid span ID')
		const recorder = new SpanRecorder(name, kind, {traceId, spanId, traceFlags: 1}, createRecorderOptions())
		if (resource) recorder.setResource(resource)
		return recorder
	}
	return {
		createSpanContext,
		resolveParentContext,
		createNoOpSpan,
		createRecordingSpan,
		createTemporaryRecorder,
		createCorrelatedRecorder,
		submitRecord,
		deleteActiveSpan,
		getActiveSpan: (context: SpanContext) => getNativeWeakMap(activeSpanMap, context)?.span,
		setActiveSpan: (context: SpanContext, span: TracingSpan) => setNativeWeakMap(activeSpanMap, context, {span, activations: 0}),
		activateSpan: (context: SpanContext, span: TracingSpan) => {
			const entry = getNativeWeakMap(activeSpanMap, context)
			if (entry?.span === span) entry.activations++
			else setNativeWeakMap(activeSpanMap, context, {span, activations: 1})
		},
		deactivateSpan: (context: SpanContext, span: TracingSpan) => {
			const entry = getNativeWeakMap(activeSpanMap, context)
			if (entry?.span === span && --entry.activations <= 0) deleteNativeWeakMap(activeSpanMap, context)
		}
	}
}
