/**
 * @file Tracing capability boundary (DI port).
 * Full tracing port interface for span lifecycle, context propagation, and exporters.
 */

import type {EnrichedError} from '../contracts/errors'
import type {LogAttributes} from '../contracts/logging'
import type {
	SpanContext,
	SpanKind,
	SpanStatus
} from '../contracts/tracing'

/**
 * Minimal tracing port interface for error breadcrumbs and spans.
 */
export interface TracerPort {

	/** Record an exception/error in the current trace */
	recordException?(error: EnrichedError, options?: {
		traceId?: string
		correlationId?: string
	}): void

	/** Add a breadcrumb to the current trace */
	addBreadcrumb?(breadcrumb: {
		category: string
		message: string
		level: string
		data?: Record<string, unknown>
	}): void

	/** Get the current trace ID */
	currentTraceId?(): string | undefined
}

/**
 * Active span interface for span manipulation.
 */
export interface TracingSpan {

	/** Get the span's context */
	getContext(): SpanContext

	/** Set a span attribute */
	setAttribute(key: string, value: unknown): void

	/** Add an event to the span */
	addEvent(name: string, attributes?: LogAttributes): void

	/** Record an exception on the span */
	recordException(error: unknown, attributes?: LogAttributes): void

	/** Set the span status */
	setStatus(status: SpanStatus): void

	/** End the span (optionally with explicit end time) */
	end(endTime?: number): void
}

/**
 * Options for creating a span.
 */
export interface SpanOptions {

	/** Span kind */
	kind?: SpanKind

	/** Initial span attributes */
	attributes?: LogAttributes

	/** Explicit parent span context or span instance (null = no parent) */
	parent?: SpanContext | TracingSpan | null

	/** Optional start time (overrides clock.now()) */
	startTime?: number

}

/**
 * Options for injecting trace context into headers.
 */
export interface InjectOptions {

	/** Optional baggage attributes to inject */
	baggage?: LogAttributes
}

/**
 * Result of extracting trace context from headers.
 */
export interface ExtractResult {

	/** Extracted span context (if any) */
	context?: SpanContext

	/** Extracted baggage attributes (if any) */
	baggage?: LogAttributes
}

/**
 * Full tracing port interface following OpenTelemetry patterns.
 */
export interface Tracing extends TracerPort {

	/** Get the currently active span (if any) */
	getActiveSpan(): TracingSpan | undefined

	/**
	 * Execute a function within a span.
	 * Creates a span, runs the function, and ends the span automatically.
	 */
	inSpan<T>(
		name: string,
		fn: (span: TracingSpan) => T | Promise<T>,
		options?: SpanOptions
	): Promise<T>

	/**
	 * Start a new span.
	 * Returns a span that must be manually ended.
	 */
	startSpan(name: string, options?: SpanOptions): TracingSpan

	/**
	 * Execute a function with an existing span as the active span.
	 * Useful for passing spans across async boundaries.
	 */
	withSpan<T>(span: TracingSpan, fn: () => T | Promise<T>): Promise<T>

	/**
	 * Inject trace context into a carrier (headers object).
	 * Adds traceparent, tracestate, and optional baggage headers.
	 */
	injectHeaders(
		carrier: Record<string, string>,
		options?: InjectOptions
	): void

	/**
	 * Extract trace context from a carrier (headers object).
	 * Parses traceparent, tracestate, and optional baggage headers.
	 */
	extractHeaders(carrier: Record<string, string>): ExtractResult

	/**
	 * Extract trace context, activate it for the callback, then restore the prior context.
	 */
	withExtractedHeaders?<T>(
		carrier: Record<string, string>,
		fn: () => T | Promise<T>
	): Promise<T>

	/**
	 * Link the current span to an external span context.
	 * Used for fan-out/fan-in scenarios (queues, pub/sub).
	 */
	linkExternal(context: SpanContext): void

	/** Get active baggage for the current context. */
	getBaggage?(): Readonly<LogAttributes>

	/** Update baggage for the current context. */
	setBaggage?(attrs: LogAttributes, mode?: 'merge' | 'replace'): void

	/** Clear all baggage or the provided keys from the current context. */
	clearBaggage?(keys?: readonly string[]): void

	/** Flush pending spans and replay queues. */
	forceFlush?(): Promise<void>

	/** Shutdown the tracing service. */
	shutdown?(): Promise<void>

}
