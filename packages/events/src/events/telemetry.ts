import type {EventEnvelope, EventTransportKind} from '@ooopsstudio/core/contracts/events'
import type {ManagedEvents} from '@ooopsstudio/core/ports/events'

export type EventsTelemetryEvent =
	| {kind: 'published'; result: 'success' | 'failure'; event?: EventEnvelope<unknown>}
	| {kind: 'delivered'; result: 'success' | 'retry' | 'failure'; transport: EventTransportKind}
	| {kind: 'consumed'; result: 'success' | 'duplicate' | 'failure'}
	| {kind: 'retry'}
	| {kind: 'queue'; size: number}
	| {kind: 'active'; value: number}
	| {kind: 'finalization-failure'; operation: 'flush' | 'shutdown' | 'backend' | 'transport'; error: unknown}

export interface EventsTelemetryAttachment {
	emit(event: EventsTelemetryEvent): void
	traceContext?(): {traceparent: string; tracestate?: string; baggage?: string} | undefined
	withExtracted?<T>(carrier: Record<string, string>, fn: () => T | Promise<T>): Promise<T>
	withPublish?<T>(fn: () => T | Promise<T>): Promise<T>
	withConsume?<T>(fn: () => T | Promise<T>): Promise<T>
}

const capabilities = new WeakMap<ManagedEvents, {attach(value: EventsTelemetryAttachment): () => void}>()

export function registerEventsTelemetry(events: ManagedEvents, attach: (value: EventsTelemetryAttachment) => () => void): void {
	capabilities.set(events, {attach})
}

export function attachEventsTelemetry(events: ManagedEvents, value: EventsTelemetryAttachment): () => void {
	const capability = capabilities.get(events)
	if (!capability) throw new Error('EVENTS_OBSERVABILITY_UNSUPPORTED')
	return capability.attach(value)
}
