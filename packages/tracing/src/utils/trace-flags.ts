/**
 * @file W3C traceparent flag management utilities.
 * Handles flag mutation rules for child spans and tail promotion.
 */
import type {SpanContext} from '@ooopsstudio/core/contracts/tracing'
/**
 * W3C trace flags constants.
 */
export const TRACE_FLAGS = {
	/** Not sampled (0x00) */
	NOT_SAMPLED: 0x00,
	/** Sampled (0x01) */
	SAMPLED: 0x01
} as const
/**
 * Check if a span context is sampled.
 * @param context - Span context
 * @returns True if sampled
 */
export function isSampled(context: SpanContext): boolean {
	const flags = context.traceFlags ?? 0
	return (flags & TRACE_FLAGS.SAMPLED) === TRACE_FLAGS.SAMPLED
}
/**
 * Create a span context with sampled flag set.
 * @param context - Base context
 * @returns Context with sampled flag
 */
export function setSampled(context: SpanContext): SpanContext {
	return {
		...context,
		traceFlags: (context.traceFlags ?? 0) | TRACE_FLAGS.SAMPLED
	}
}
/**
 * Create a span context with sampled flag cleared.
 * @param context - Base context
 * @returns Context without sampled flag
 */
export function setNotSampled(context: SpanContext): SpanContext {
	return {
		...context,
		traceFlags: (context.traceFlags ?? 0) & ~TRACE_FLAGS.SAMPLED
	}
}
/**
 * Inherit trace flags from parent context.
 * Child spans inherit parent's flags by default.
 * @param parent - Parent span context
 * @returns Inherited trace flags
 */
export function inheritTraceFlags(parent: SpanContext | undefined): number {
	if (!parent) {
		// Root span: default to sampled
		return TRACE_FLAGS.SAMPLED
	}
	return parent.traceFlags ?? TRACE_FLAGS.NOT_SAMPLED
}
