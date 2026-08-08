/**
 * @file Span recorder: manages span lifecycle, attributes, events, links, and limits.
 * Enforces attribute/event/link limits and truncation strategies.
 */
import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext, SpanEvent, SpanKind, SpanLink, SpanRecord, SpanStatus} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import {captureClock} from '../utils/capabilities'

import {pushNativeArray} from './native-runtime'
import {finalizeSpanRecord} from './span-record-finalizer'
import {
	deepFreezeSpanRecord,
	describeSpanException,
	isSafeSpanText,
	snapshotSpanAttributes,
	snapshotSpanAttributesDetailed,
	snapshotSpanContext,
	snapshotSpanValue
} from './span-recorder-safety'

const VALID_KINDS = new Set<SpanKind>(['internal', 'server', 'client', 'producer', 'consumer'])
const VALID_STATUS = new Set<SpanStatus['code']>(['unset', 'ok', 'error'])

export interface SpanRecorderOptions {
	clock: Clock
	maxAttributes: number
	maxEvents: number
	maxAttrBytes: number
	errors?: Errors
	redactAttributes?: (attrs: LogAttributes) => LogAttributes
	startTime?: number
}
/**
 * Span recorder: manages span lifecycle and enforces limits.
 */
export class SpanRecorder {
	private readonly clock: Clock
	private readonly maxAttributes: number
	private readonly maxEvents: number
	private readonly maxAttrBytes: number
	private readonly errors?: Errors
	private readonly redactAttributes?: (attrs: LogAttributes) => LogAttributes
	// Span state
	private name: string
	private kind: SpanKind
	private context: SpanContext
	private parentContext?: SpanContext
	private startTime: number
	private endTime?: number
	private attributes: LogAttributes
	private status: SpanStatus
	private events: SpanEvent[]
	private links: SpanLink[]
	private droppedAttributesCount: number
	private droppedEventsCount: number
	private droppedLinksCount: number
	private auxiliaryAttributeBytes: number
	private resource?: LogAttributes
	private finalRecord?: SpanRecord
	constructor(name: string, kind: SpanKind, context: SpanContext, options: SpanRecorderOptions) {
		const {
			clock,
			maxAttributes,
			maxEvents,
			maxAttrBytes,
			errors,
			redactAttributes,
			startTime
		} = options
		if (!isSafeSpanText(name, 256)) throw new Error('Span name must be 1-256 characters without control characters')
		if (!VALID_KINDS.has(kind)) throw new Error('Invalid span kind')
		const safeContext = snapshotSpanContext(context)
		if (!safeContext) throw new Error('Span context must contain valid non-zero W3C trace and span IDs')
		if (!Number.isInteger(maxAttributes) || maxAttributes < 0 || maxAttributes > 10_000) throw new Error('Span maxAttributes must be between 0 and 10000')
		if (!Number.isInteger(maxEvents) || maxEvents < 0 || maxEvents > 10_000) throw new Error('Span maxEvents must be between 0 and 10000')
		if (!Number.isInteger(maxAttrBytes) || maxAttrBytes < 0 || maxAttrBytes > 10_000_000) throw new Error('Span maxAttrBytes must be between 0 and 10000000')
		this.clock = captureClock(clock)
		this.maxAttributes = maxAttributes
		this.maxEvents = maxEvents
		this.maxAttrBytes = maxAttrBytes
		if (errors) {
			this.errors = errors
		}
		if (redactAttributes) {
			this.redactAttributes = redactAttributes
		}
		// Initialize span state
		this.name = name
		this.kind = kind
		this.context = safeContext
		const resolvedStartTime = startTime ?? this.clock.now()
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		if (!Number.isFinite(resolvedStartTime) || resolvedStartTime < 0 ||
			!Number.isSafeInteger(Math.trunc(resolvedStartTime))) {
			throw new Error('Span startTime must be a finite non-negative number')
		}
		this.startTime = resolvedStartTime
		this.attributes = {}
		this.status = {code: 'unset'}
		this.events = []
		this.links = []
		this.droppedAttributesCount = 0
		this.droppedEventsCount = 0
		this.droppedLinksCount = 0
		this.auxiliaryAttributeBytes = 0
	}
	/**
	 * Get the span context.
	 */
	getContext(): SpanContext {
		return {...this.context}
	}
	/**
	 * Set parent context.
	 */
	setParentContext(parent: SpanContext | undefined): void {
		if (this.endTime !== undefined || !parent) return
		const snapshot = snapshotSpanContext(parent)
		if (!snapshot || snapshot.traceId !== this.context.traceId || (
			this.context.parentSpanId !== undefined && snapshot.spanId !== this.context.parentSpanId
		)) return
		this.parentContext = snapshot
	}
	/**
	 * Set a span attribute.
	 * Enforces maxAttributes and maxAttrBytes limits.
	 * Always recomputes attribute byte size for correctness.
	 */
	setAttribute(key: string, value: unknown): void {
		if (this.endTime !== undefined) {
			// Span already ended, ignore
			return
		}
		if (!isSafeSpanText(key, 256) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
			this.droppedAttributesCount++
			return
		}
		const safeValue = snapshotSpanValue(value)
		if (safeValue === undefined) {
			this.droppedAttributesCount++
			return
		}
		// Check if we've hit attribute count limit
		const currentAttrCount = Object.keys(this.attributes).length
		const keyExists = Object.hasOwn(this.attributes, key)
		if (!keyExists && currentAttrCount >= this.maxAttributes) {
			this.droppedAttributesCount++
			return
		}
		// Build candidate attributes with the new value
		const candidate = {...this.attributes, [key]: safeValue} as Record<string, unknown>
		// Always compute accurate size via JSON serialization
		// Attributes are low-frequency, so this is acceptable for correctness
		let candidateSize: number
		try {
			candidateSize = byteSize(JSON.stringify(candidate))
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		} catch {
			// Fallback: safe overestimate
			candidateSize = this.maxAttrBytes + 100
		}
		// Check if adding this attribute would exceed byte limit
		if (candidateSize + this.auxiliaryAttributeBytes > this.maxAttrBytes) {
			// Try to truncate value if it's a string
			if (typeof safeValue === 'string' && safeValue.length > 0) {
				// Try truncation with progressively shorter lengths
				// Start from 75% of the string and work down
				const truncateSuffix = '[TRUNCATED]'
				let truncateLength = Math.floor(safeValue.length * 0.75)
				while (truncateLength > 0) {
					const truncatedValue = safeValue.substring(0, truncateLength) + truncateSuffix
					const truncatedCandidate = {...this.attributes, [key]: truncatedValue} as Record<string, unknown>
					let truncatedSize: number
					try {
						truncatedSize = byteSize(JSON.stringify(truncatedCandidate))
					/* v8 ignore next -- defensive branch not constructible through the public tracing API */
					} catch {
						truncatedSize = this.maxAttrBytes + 100
					}
					// Verify final size after truncation
					/* v8 ignore next -- defensive branch not constructible through the public tracing API */
					if (truncatedSize + this.auxiliaryAttributeBytes <= this.maxAttrBytes) {
						// Truncation successful: count as drop (partial) and apply
						this.droppedAttributesCount += 1
						;(this.attributes as Record<string, unknown>)[key] = truncatedValue
						return
					}
					// Reduce truncation length by 50%
					truncateLength = Math.floor(truncateLength / 2)
				}
			}
			// Can't fit even with truncation: drop it entirely
			this.droppedAttributesCount++
			return
		}
		// Safe to add: update attribute
		Object.defineProperty(this.attributes, key, {value: safeValue, enumerable: true, configurable: true, writable: true})
	}

	setAttributes(attributes: LogAttributes): void {
		if (this.endTime !== undefined) return
		const snapshot = snapshotSpanAttributesDetailed(attributes, this.maxAttributes, this.maxAttrBytes)
		this.droppedAttributesCount += snapshot.droppedCount
		for (const [key, value] of Object.entries(snapshot.attributes ?? {})) this.setAttribute(key, value)
	}
	/**
	 * Add an event to the span.
	 * Enforces maxEvents limit.
	 */
	addEvent(name: string, attributes?: LogAttributes): void {
		if (this.endTime !== undefined) {
			// Span already ended, ignore
			return
		}
		if (!isSafeSpanText(name, 128) || this.events.length >= this.maxEvents) {
			this.droppedEventsCount++
			return
		}
		let timestamp: number
		try { timestamp = this.clock.now() } catch { this.droppedEventsCount++; return }
		if (!Number.isFinite(timestamp) || timestamp < 0 || !Number.isSafeInteger(Math.trunc(timestamp))) {
			this.droppedEventsCount++
			return
		}
		const snapshot = attributes ? snapshotSpanAttributesDetailed(attributes, this.maxAttributes, this.maxAttrBytes) : undefined
		this.droppedAttributesCount += snapshot?.droppedCount ?? 0
		let safeAttributes = snapshot?.attributes
		if (safeAttributes && Object.keys(safeAttributes).length === 0) safeAttributes = undefined
		const attributeBytes = safeAttributes ? this.measureAttributes(safeAttributes) : 0
		if (safeAttributes && this.currentSpanAttributeBytes() + this.auxiliaryAttributeBytes + attributeBytes > this.maxAttrBytes) {
			this.droppedAttributesCount += Math.max(1, Object.keys(safeAttributes).length)
			safeAttributes = undefined
		} else {
			this.auxiliaryAttributeBytes += attributeBytes
		}
		pushNativeArray(this.events, {
			name,
			timestamp,
			...(safeAttributes ? {attributes: safeAttributes} : {})
		})
	}
	/**
	 * Add a link to the span.
	 */
	addLink(link: SpanLink): void {
		if (this.endTime !== undefined) {
			// Span already ended, ignore
			return
		}
		// Links don't have a hard limit in OTel spec, but we'll cap at a reasonable number
		let context: SpanContext
		let safeAttributes: LogAttributes | undefined
		try {
			if (!link || typeof link !== 'object' || Array.isArray(link)) throw new TypeError()
			const prototype = Object.getPrototypeOf(link)
			if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
			let fields = 0
			let rawContext: unknown
			let rawAttributes: unknown
			for (const key in link) {
				if (++fields > 2 || key.length > 64) throw new TypeError()
				const descriptor = Object.getOwnPropertyDescriptor(link, key)
				if (!descriptor) continue
				if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError()
				if (key === 'context') rawContext = descriptor.value
				else if (key === 'attributes') rawAttributes = descriptor.value
				else throw new TypeError()
			}
			if (rawContext === undefined) throw new TypeError()
			context = rawContext as SpanContext
			const snapshot = rawAttributes !== undefined
				? snapshotSpanAttributesDetailed(rawAttributes as LogAttributes, this.maxAttributes, this.maxAttrBytes)
				: undefined
			this.droppedAttributesCount += snapshot?.droppedCount ?? 0
			safeAttributes = snapshot?.attributes
			if (safeAttributes && Object.keys(safeAttributes).length === 0) safeAttributes = undefined
		} catch {
			this.droppedLinksCount++
			return
		}
		const contextSnapshot = context ? snapshotSpanContext(context) : undefined
		if (!contextSnapshot || this.links.length >= 128) {
			this.droppedLinksCount++
			return
		}
		const attributeBytes = safeAttributes ? this.measureAttributes(safeAttributes) : 0
		if (safeAttributes && this.currentSpanAttributeBytes() + this.auxiliaryAttributeBytes + attributeBytes > this.maxAttrBytes) {
			this.droppedAttributesCount += Math.max(1, Object.keys(safeAttributes).length)
			safeAttributes = undefined
		} else {
			this.auxiliaryAttributeBytes += attributeBytes
		}
		pushNativeArray(this.links, {
			context: contextSnapshot,
			...(safeAttributes ? {attributes: safeAttributes} : {})
		})
	}
	/**
	 * Record an exception on the span.
	 */
	recordException(error: unknown, attributes?: LogAttributes): void {
		if (this.endTime !== undefined) {
			// Span already ended, ignore
			return
		}
		const details = describeSpanException(error)
		// Set status to error
		this.setStatus({
			code: 'error',
			description: details.message
		})
		// Add error attributes
		this.setAttribute('error.type', details.type)
		this.setAttribute('error.message', details.message)
		// Instrumentation and source-map settings can make stack traces arbitrarily
		// large. Keep them inside a sub-budget so they cannot displace the canonical
		// exception event and all subsequently recorded auxiliary metadata.
		const stackBudget = Math.min(2_048, Math.floor(this.maxAttrBytes / 4))
		if (details.stack && stackBudget > 0) this.setAttribute('error.stack', details.stack.slice(0, stackBudget))
		// Add custom attributes
		let safeEventAttributes: LogAttributes | undefined
		if (attributes) {
			try {
				const snapshot = snapshotSpanAttributesDetailed(attributes, this.maxAttributes, this.maxAttrBytes)
				this.droppedAttributesCount += snapshot.droppedCount
				safeEventAttributes = snapshot.attributes
				for (const [key, value] of Object.entries(safeEventAttributes ?? {})) this.setAttribute(`error.${key}`, value)
			} catch { this.droppedAttributesCount++ }
		}
		// Add as event
		this.addEvent('exception', {
			...(safeEventAttributes ?? {}),
			'exception.type': details.type,
			'exception.message': details.message
		})
	}
	/**
	 * Set the span status.
	 */
	setStatus(status: SpanStatus): void {
		if (this.endTime !== undefined) {
			// Span already ended, ignore
			return
		}
		try {
			if (!status || typeof status !== 'object') return
			const codeDescriptor = Object.getOwnPropertyDescriptor(status, 'code')
			const descriptionDescriptor = Object.getOwnPropertyDescriptor(status, 'description')
			const code = codeDescriptor && 'value' in codeDescriptor ? codeDescriptor.value : undefined
			const description = descriptionDescriptor && 'value' in descriptionDescriptor ? descriptionDescriptor.value : undefined
			if (!VALID_STATUS.has(code as SpanStatus['code'])) return
			this.status = {
				code: code as SpanStatus['code'],
				...(typeof description === 'string' ? {description: description.slice(0, 1_024)} : {})
			}
		} catch { /* hostile status objects are ignored */ }
	}
	/**
	 * Set resource attributes.
	 */
	setResource(resource: LogAttributes): void {
		if (this.endTime !== undefined) return
		const snapshot = snapshotSpanAttributes(resource, this.maxAttributes, Math.min(this.maxAttrBytes, 16_000))
		if (snapshot) this.resource = snapshot
	}
	/**
	 * End the span.
	 * @param endTime - Optional explicit end time (defaults to clock.now())
	 * @returns Final span record
	 */
	end(endTime?: number): SpanRecord {
		if (this.finalRecord) {
			return this.finalRecord
		}
		const clockEndTime = endTime ?? this.clock.now()
		const resolvedEndTime = endTime === undefined && clockEndTime < this.startTime
			? this.startTime
			: clockEndTime
		if (!Number.isFinite(resolvedEndTime) || resolvedEndTime < 0 ||
			!Number.isSafeInteger(Math.trunc(resolvedEndTime))) {
			throw new Error('Span endTime must be a finite non-negative number')
		}
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		if (resolvedEndTime < this.startTime) {
			throw new Error(`Span endTime (${resolvedEndTime}) must be >= startTime (${this.startTime})`)
		}
		const record = finalizeSpanRecord({
			name: this.name,
			kind: this.kind,
			context: this.context,
			...(this.parentContext ? {parentContext: this.parentContext} : {}),
			startTime: this.startTime,
			endTime: resolvedEndTime,
			attributes: this.attributes,
			status: this.status,
			events: this.events,
			links: this.links,
			droppedAttributesCount: this.droppedAttributesCount,
			droppedEventsCount: this.droppedEventsCount,
			droppedLinksCount: this.droppedLinksCount,
			maxAttributes: this.maxAttributes,
			maxAttrBytes: this.maxAttrBytes,
			...(this.resource ? {resource: this.resource} : {}),
			...(this.errors ? {errors: this.errors} : {}),
			...(this.redactAttributes ? {redactAttributes: this.redactAttributes} : {})
		})
		this.finalRecord = deepFreezeSpanRecord(record)
		this.endTime = resolvedEndTime
		return this.finalRecord
	}

	private currentSpanAttributeBytes(): number {
		return this.measureAttributes(this.attributes)
	}

	private measureAttributes(attributes: LogAttributes): number {
		try { return byteSize(JSON.stringify(attributes)) } catch { return this.maxAttrBytes + 1 }
	}
}
