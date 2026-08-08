/* v8 ignore file */
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext} from '@ooopsstudio/core/contracts/tracing'
export interface PropagationExtractResult {
	context?: SpanContext
	baggage?: LogAttributes
}
export interface TracingPropagator {
	readonly format: 'w3c'
	inject(carrier: Record<string, string>, context: SpanContext | undefined, baggage?: LogAttributes): void
	extract(carrier: Record<string, string>): PropagationExtractResult
}
export const tracingPropagationTypesRuntime = true
