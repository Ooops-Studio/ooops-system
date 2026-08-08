import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext, SpanEvent, SpanKind, SpanLink, SpanRecord, SpanStatus} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import {createTracingOnError} from '../utils/on-error'

import {pushNativeArray} from './native-runtime'
import {snapshotSpanAttributesDetailed} from './span-recorder-safety'
import {maskSpanAttributes} from './span-redaction'

const nativeArrayIsArray = Array.isArray
const nativeJsonStringify = JSON.stringify
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectKeys = Object.keys
const nativeReflectApply = Reflect.apply
const nativeStringSlice = String.prototype.slice

function sliceText(value: string, end: number): string {
	return nativeReflectApply(nativeStringSlice, value, [0, end]) as string
}

export interface SpanRecordFinalizationOptions {
	name: string
	kind: SpanKind
	context: SpanContext
	parentContext?: SpanContext
	startTime: number
	endTime: number
	attributes: LogAttributes
	status: SpanStatus
	events: readonly SpanEvent[]
	links: readonly SpanLink[]
	droppedAttributesCount: number
	droppedEventsCount: number
	droppedLinksCount: number
	resource?: LogAttributes
	errors?: Errors
	redactAttributes?: (attrs: LogAttributes) => LogAttributes
	maxAttributes: number
	maxAttrBytes: number
}

export function finalizeSpanRecord(options: SpanRecordFinalizationOptions): SpanRecord {
	const reportRedactionError = createTracingOnError(options.errors, {stage: 'tracing'})
	const redact = (attributes: LogAttributes, operation: string, maxBytes = options.maxAttrBytes): LogAttributes => {
		if (!options.redactAttributes) return snapshotSpanAttributesDetailed(
			attributes, options.maxAttributes, maxBytes
		).attributes ?? {}
		try {
			const redacted = options.redactAttributes(attributes)
			if (!redacted || typeof redacted !== 'object' || nativeArrayIsArray(redacted)) {
				throw new Error('Tracing redactor must return an attributes object')
			}
			const prototype = nativeObjectGetPrototypeOf(redacted)
			if (prototype !== Object.prototype && prototype !== null) {
				throw new Error('Tracing redactor must return a plain attributes object')
			}
			const snapshot = snapshotSpanAttributesDetailed(redacted, options.maxAttributes, maxBytes)
			if (!snapshot.attributes || snapshot.droppedCount > 0) {
				throw new Error('Tracing redactor returned unsafe or oversized attributes')
			}
			return snapshot.attributes
		} catch(error) {
			reportRedactionError(error, {operation})
			return snapshotSpanAttributesDetailed(
				maskSpanAttributes(attributes), options.maxAttributes, maxBytes
			).attributes ?? {}
		}
	}
	let remainingAttributeBytes = options.maxAttrBytes
	const redactBudgeted = (attributes: LogAttributes, operation: string): LogAttributes | undefined => {
		if (remainingAttributeBytes <= 2) return undefined
		const result = redact(attributes, operation, remainingAttributeBytes)
		let used: number
		try { used = byteSize(nativeJsonStringify(result)) } catch { return undefined }
		if (used > remainingAttributeBytes) return undefined
		remainingAttributeBytes -= used
		return nativeObjectKeys(result).length > 0 ? result : undefined
	}
	// Preserve primary span attributes before auxiliary event/link metadata.
	const redactedAttributes = redactBudgeted(options.attributes, 'redact') ?? {}
	const redactedEvents: SpanEvent[] = []
	for (let index = 0; index < options.events.length; index++) {
		const event = options.events[index]!
		const attributes = event.attributes ? redactBudgeted(event.attributes, 'redact-event') : undefined
		const redactedName = options.redactAttributes
			? (() => {
				const value = redact({'event.name': event.name}, 'redact-event-name')['event.name']
				return sliceText(typeof value === 'string' && value.length > 0 ? value : '[REDACTED]', 128)
			})()
			: event.name
		pushNativeArray(redactedEvents, {...event, name: redactedName, ...(attributes ? {attributes} : {})})
	}
	const redactedLinks: SpanLink[] = []
	for (let index = 0; index < options.links.length; index++) {
		const link = options.links[index]!
		const attributes = link.attributes ? redactBudgeted(link.attributes, 'redact-link') : undefined
		pushNativeArray(redactedLinks, {...link, context: {...link.context}, ...(attributes ? {attributes} : {})})
	}
	const redactedStatus = options.status.description && options.redactAttributes
		? (() => {
			const value = redact({'status.description': options.status.description}, 'redact-status')['status.description']
			return {...options.status, description: sliceText(typeof value === 'string' ? value : '[REDACTED]', 1_024)}
		})()
		: options.status
	const redactedName = options.redactAttributes
		? (() => {
			const value = redact({'span.name': options.name}, 'redact-name')['span.name']
			return sliceText(typeof value === 'string' ? value : '[REDACTED]', 256)
		})()
		: options.name
	const finalEvents: SpanEvent[] = []
	for (let index = 0; index < redactedEvents.length; index++) {
		const event = redactedEvents[index]!
		pushNativeArray(finalEvents, {
			...event,
			...(event.attributes ? {attributes: {...event.attributes}} : {})
		})
	}
	return {
		name: redactedName,
		kind: options.kind,
		context: {...options.context},
		...(options.parentContext ? {parentContext: {...options.parentContext}} : {}),
		startTime: options.startTime,
		endTime: options.endTime,
		durationMs: options.endTime - options.startTime,
		attributes: redactedAttributes,
		status: redactedStatus,
		events: finalEvents,
		...(redactedLinks.length > 0 ? {links: redactedLinks} : {}),
		...(options.droppedAttributesCount > 0 ? {droppedAttributesCount: options.droppedAttributesCount} : {}),
		...(options.droppedEventsCount > 0 ? {droppedEventsCount: options.droppedEventsCount} : {}),
		...(options.droppedLinksCount > 0 ? {droppedLinksCount: options.droppedLinksCount} : {}),
		...(options.resource ? {resource: redact(options.resource, 'redact-resource')} : {})
	}
}
