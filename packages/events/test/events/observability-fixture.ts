import type {ManagedEvents} from '@ooopsstudio/core/ports/events'

import {attachEventsTelemetry} from '../../src/events/telemetry'

interface TestMetrics {
	increment?(name: string, labels?: Readonly<Record<string, string>>): unknown
	record?(name: string, value: number): unknown
}

interface TestTracer {
	injectHeaders?(carrier: Record<string, unknown>): unknown
	withExtractedHeaders?<T>(carrier: Record<string, string>, callback: () => Promise<T>): Promise<T>
	inSpan?<T>(name: string, callback: () => Promise<T>, options: {kind: string}): Promise<T>
}

export interface TestEventsObservabilityOptions {
	readonly metrics?: TestMetrics
	readonly tracer?: TestTracer
}

export function wireEventsObservabilityForTest(
	events: ManagedEvents,
	options: TestEventsObservabilityOptions
): () => void {
	const traceFailOpen = async <T>(
		invoke: (callback: () => Promise<T>) => Promise<T>,
		callback: () => T | Promise<T>
	): Promise<T> => {
		let work: Promise<T> | undefined
		let timer: ReturnType<typeof setTimeout> | undefined
		const once = (): Promise<T> => work ??= Promise.resolve().then(callback)
		const fallback = new Promise<T>((resolve, reject) => {
			timer = setTimeout(() => {
				void once().then(resolve, reject)
			}, 100)
		})
		try {
			const observed = Promise.resolve().then(() => invoke(once)).then(() => once())
			return await Promise.race([observed, fallback])
		}
		catch { return work ?? once() }
		finally { if (timer) clearTimeout(timer) }
	}

	return attachEventsTelemetry(events, {
		traceContext: options.tracer?.injectHeaders ? () => {
			const carrier: Record<string, unknown> = {}
			try {
				options.tracer?.injectHeaders?.(carrier)
				const data = (name: string): unknown => {
					const descriptor = Object.getOwnPropertyDescriptor(carrier, name)
					return descriptor && 'value' in descriptor ? descriptor.value : undefined
				}
				const traceparent = data('traceparent')
				const tracestate = data('tracestate')
				const baggage = data('baggage')
				if (typeof traceparent !== 'string'
					|| !/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/iu.test(traceparent)
					|| (tracestate !== undefined && (typeof tracestate !== 'string' || tracestate.length > 1_024))
					|| (baggage !== undefined && (typeof baggage !== 'string' || baggage.length > 8_192))) return undefined
				return {traceparent, ...(tracestate ? {tracestate} : {}), ...(baggage ? {baggage} : {})}
			} catch { return undefined }
		} : undefined,
		withExtracted: options.tracer?.withExtractedHeaders
			? (carrier, callback) => traceFailOpen((once) => options.tracer!.withExtractedHeaders!(carrier, once), callback)
			: undefined,
		withPublish: options.tracer?.inSpan
			? (callback) => traceFailOpen((once) => options.tracer!.inSpan!('events.publish', once, {kind: 'producer'}), callback)
			: undefined,
		withConsume: options.tracer?.inSpan
			? (callback) => traceFailOpen((once) => options.tracer!.inSpan!('events.consume', once, {kind: 'consumer'}), callback)
			: undefined,
		emit(event): void {
			try {
				switch (event.kind) {
					case 'published': options.metrics?.increment?.('_events_published_total', {result: event.result}); break
					case 'delivered': options.metrics?.increment?.('_events_delivered_total', {result: event.result, transport: event.transport}); break
					case 'consumed': options.metrics?.increment?.('_events_consumed_total', {result: event.result}); break
					case 'retry': options.metrics?.increment?.('_events_retries_total'); break
					case 'active': options.metrics?.record?.('_events_active_operations', event.value); break
					case 'queue': options.metrics?.record?.('_events_queue_size', event.size); break
					case 'finalization-failure': options.metrics?.increment?.('_events_finalization_failures_total', {operation: event.operation}); break
				}
			} catch { return }
		}
	})
}
