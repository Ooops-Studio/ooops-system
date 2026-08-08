/**
 * @file Canonical tracing data model shared across the monorepo.
 * OpenTelemetry (OTel) aligned contracts for spans, context, and propagation.
 * Pure types only; no DI and no service coupling.
 */

import type {LogAttributes} from './logging'

/**
 * Span kind following OpenTelemetry specification.
 */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'

/**
 * W3C Trace Context: trace ID (128-bit), span ID (64-bit),
 * parent span ID, trace flags, and tracestate.
 */
export interface SpanContext {

	/** 128-bit trace ID as 32-character hex string */
	traceId: string

	/** 64-bit span ID as 16-character hex string */
	spanId: string

	/** Optional parent span ID (16-character hex string) */
	parentSpanId?: string

	/** W3C trace flags (bit 0 = sampled, bit 1 = random trace ID) */
	traceFlags?: number

	/** W3C tracestate header value (opaque string, vendor-specific) */
	traceState?: string
}

/**
 * Active tracing context carried in-process.
 */
export interface TracingContext {

	/** Active span context, if any */
	spanContext?: SpanContext

	/** Optional in-process baggage */
	baggage?: LogAttributes
}

/**
 * Span status following OpenTelemetry specification.
 */
export interface SpanStatus {

	/** Status code */
	code: 'unset' | 'ok' | 'error'

	/** Optional human-readable description */
	description?: string
}

/**
 * Span event: a timestamped event within a span (e.g., 'cache-miss', 'parsed-body').
 */
export interface SpanEvent {

	/** Event name */
	name: string

	/** Timestamp in epoch milliseconds (monotonic or wall-time, consistent within trace) */
	timestamp: number

	/** Optional event attributes */
	attributes?: LogAttributes
}

/**
 * Span link: connects a span to another span context (for fan-out/fan-in scenarios).
 */
export interface SpanLink {

	/** Linked span context */
	context: SpanContext

	/** Optional link attributes */
	attributes?: LogAttributes
}

/**
 * Span record: complete span data following OpenTelemetry model.
 * This is the canonical format for span export and storage.
 */
export interface SpanRecord {

	/** Span name (e.g., 'http.request', 'db.getUser') */
	name: string

	/** Span kind */
	kind: SpanKind

	/** Span context (trace ID, span ID, flags, state) */
	context: SpanContext

	/** Optional parent span context */
	parentContext?: SpanContext

	/** Start time in epoch milliseconds */
	startTime: number

	/** Optional end time in epoch milliseconds */
	endTime?: number

	/** Optional duration in milliseconds */
	durationMs?: number

	/** Span attributes (structured metadata) */
	attributes: LogAttributes

	/** Span status */
	status: SpanStatus

	/** Span events (timeline checkpoints) */
	events: SpanEvent[]

	/** Optional span links (for fan-out/fan-in) */
	links?: SpanLink[]

	/** Count of dropped attributes (for limits) */
	droppedAttributesCount?: number

	/** Count of dropped events (for limits) */
	droppedEventsCount?: number

	/** Count of dropped links (for limits) */
	droppedLinksCount?: number

	/** Optional resource attributes (service.name, host.name, etc.) */
	resource?: LogAttributes

}
