import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext, SpanLink, SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import type {Tracing, TracingSpan} from '@ooopsstudio/core/ports/tracing'

import {captureCapability} from '../utils/capabilities'

import type {SpanRecorder} from './span-recorder'
import {isSafeSpanText, snapshotSpanAttributes} from './span-recorder-safety'

interface TracerObservabilityOptions {
	getActiveSpan(): TracingSpan | undefined
	getActiveSpanContext(): SpanContext | undefined
	createTemporaryRecorder(name: string, kind: 'internal', parent: SpanContext): SpanRecorder
	createCorrelatedRecorder(name: string, kind: 'internal', traceId: string): SpanRecorder
	submitRecord(record: SpanRecord): void
	recordSpanProcessed(): void
	canCreateDetachedRecord(): boolean
	reportInternalError(error: unknown, context: {operation: string}): void
	maxAttributes: number
	maxAttrBytes: number
}

type TracerObservability = Pick<Required<Tracing>, 'recordException' | 'addBreadcrumb' | 'linkExternal'>
const nativePromiseThen = Promise.prototype.then

/** Build isolated helpers that turn out-of-band diagnostics into detached spans. */
export function createTracerObservability(options: TracerObservabilityOptions): TracerObservability {
	const observeOutcome = (outcome: unknown, operation: string): void => {
		if (!outcome || (typeof outcome !== 'object' && typeof outcome !== 'function')) return
		try {
			void Reflect.apply(nativePromiseThen, outcome, [undefined, (error: unknown) => {
				try { options.reportInternalError(error, {operation}) } catch { /* diagnostics are isolated */ }
			}])
		} catch { /* non-native thenables are deliberately ignored */ }
	}
	const recordDetached = (
		name: string,
		parent: SpanContext,
		operation: string,
		mutate: (recorder: SpanRecorder) => void
	): void => {
		try {
			const recorder = options.createTemporaryRecorder(name, 'internal', parent)
			mutate(recorder)
			options.submitRecord(recorder.end())
			options.recordSpanProcessed()
		} catch(error) { options.reportInternalError(error, {operation}) }
	}

	return {
		recordException: (error, recordOptions) => {
			const activeSpan = options.getActiveSpan()
			if (activeSpan) {
				try {
					const recordException = captureCapability<Parameters<TracingSpan['recordException']>, unknown>(activeSpan, 'recordException')
					if (!recordException) throw new TypeError('Active tracing span must expose recordException() as a data method')
					observeOutcome(recordException(error), 'record-active-exception')
				} catch(internalError) {
					options.reportInternalError(internalError, {operation: 'record-active-exception'})
				}
				return
			}
			const context = options.getActiveSpanContext()
			if (context) {
				if (!options.canCreateDetachedRecord()) return
				recordDetached('exception', context, 'record-detached-exception', (recorder) => {
					recorder.recordException(error)
				})
				return
			}
			if (!options.canCreateDetachedRecord()) return
			try {
				const traceIdDescriptor = recordOptions ? Object.getOwnPropertyDescriptor(recordOptions, 'traceId') : undefined
				const correlationDescriptor = recordOptions ? Object.getOwnPropertyDescriptor(recordOptions, 'correlationId') : undefined
				if ((traceIdDescriptor && !('value' in traceIdDescriptor)) || (correlationDescriptor && !('value' in correlationDescriptor))) {
					throw new TypeError('Tracing exception correlation options must use data fields')
				}
				const traceId = traceIdDescriptor && 'value' in traceIdDescriptor ? traceIdDescriptor.value : undefined
				const correlationId = correlationDescriptor && 'value' in correlationDescriptor ? correlationDescriptor.value : undefined
				if (!traceId) return
				const recorder = options.createCorrelatedRecorder('exception', 'internal', traceId as string)
				recorder.recordException(error, typeof correlationId === 'string' && correlationId
					? {correlation_id: correlationId}
					: undefined)
				options.submitRecord(recorder.end())
				options.recordSpanProcessed()
			} catch(internalError) {
				options.reportInternalError(internalError, {operation: 'record-correlated-exception'})
			}
		},
		addBreadcrumb: (breadcrumb) => {
			let attributes: LogAttributes
			try {
				if (!breadcrumb || typeof breadcrumb !== 'object') throw new TypeError('Tracing breadcrumb must be an object')
				const read = (key: 'category' | 'message' | 'level' | 'data'): unknown => {
					const descriptor = Object.getOwnPropertyDescriptor(breadcrumb, key)
					if (!descriptor) return undefined
					if (!('value' in descriptor)) throw new TypeError('Tracing breadcrumb must use data fields')
					return descriptor.value
				}
				const category = read('category')
				const message = read('message')
				const level = read('level')
				if (!isSafeSpanText(category, 128) || !isSafeSpanText(message, 1_024) || !isSafeSpanText(level, 64)) {
					throw new TypeError('Tracing breadcrumb text is invalid')
				}
				const data = snapshotSpanAttributes(
					(read('data') ?? {}) as LogAttributes, options.maxAttributes, options.maxAttrBytes
				) ?? {}
				attributes = {...data, category, message, level}
			} catch(error) {
				options.reportInternalError(error, {operation: 'add-breadcrumb'})
				return
			}
			const activeSpan = options.getActiveSpan()
			if (activeSpan) {
				try {
					const addEvent = captureCapability<Parameters<TracingSpan['addEvent']>, unknown>(activeSpan, 'addEvent')
					if (!addEvent) throw new TypeError('Active tracing span must expose addEvent() as a data method')
					observeOutcome(addEvent('breadcrumb', attributes), 'add-active-breadcrumb')
				} catch(error) {
					options.reportInternalError(error, {operation: 'add-active-breadcrumb'})
				}
				return
			}
			const context = options.getActiveSpanContext()
			if (context) {
				if (!options.canCreateDetachedRecord()) return
				recordDetached('breadcrumb', context, 'record-detached-breadcrumb', (recorder) => {
					recorder.addEvent('breadcrumb', attributes)
				})
			}
		},
		linkExternal: (context) => {
			const activeSpan = options.getActiveSpan()
			let linked = false
			if (activeSpan) {
				try {
					const addLink = captureCapability<[SpanLink], unknown>(activeSpan, 'addLink')
					if (addLink) {
						observeOutcome(addLink({context}), 'link-active-span')
						linked = true
					}
				} catch(error) { options.reportInternalError(error, {operation: 'link-active-span'}) }
			}
			if (linked) return
			if (!options.canCreateDetachedRecord()) return
			const parent = options.getActiveSpanContext()
			if (parent) {
				recordDetached('link', parent, 'record-detached-link', (recorder) => {
					recorder.addLink({context, attributes: {}})
				})
			}
		}
	}
}
