import type {ManagedEvents} from '@ooopsstudio/core/ports/events'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {captureSyncMethod, isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {isolateCapabilityFields} from '../safe-input'
import {attachEventsTelemetry, type EventsTelemetryEvent} from '../telemetry'

export type EventsObservabilityEvent = Readonly<EventsTelemetryEvent>
export type EventsObservabilityListener = (event: EventsObservabilityEvent) => unknown
export type EventsObservabilityAttachment = () => void
export type EventsTracing = Pick<Tracing, 'injectHeaders' | 'inSpan'>
	& Partial<Pick<Tracing, 'withExtractedHeaders'>>

const TRACE_FALLBACK_MS = 100
const TRACEPARENT = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/iu

function captureMethod<T extends (...arguments_: never[]) => unknown>(target: unknown, key: PropertyKey): T | undefined {
	return captureSyncMethod<never[], ReturnType<T>>(target, key) as T | undefined
}

async function traceFailOpen<T>(
	invoke: (operation: () => Promise<T>) => Promise<T>,
	operation: () => T | Promise<T>
): Promise<T> {
	let work: Promise<T> | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	const once = (): Promise<T> => work ??= Promise.resolve().then(operation)
	const fallback = new Promise<T>((resolve, reject) => {
		timer = setTimeout(() => { void once().then(resolve, reject) }, TRACE_FALLBACK_MS)
	})
	try {
		const observed = Promise.resolve().then(() => invoke(once)).then(() => once())
		return await Promise.race([observed, fallback])
	}
	catch(error) { isolateUnexpectedThenable(error); return work ?? once() }
	finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Attach raw events and optional W3C propagation without exposing telemetry internals. */
export function attachEventsObservability(
	events: ManagedEvents,
	listener: EventsObservabilityListener,
	tracing?: EventsTracing
): EventsObservabilityAttachment {
	const eventsThenable = isolateUnexpectedThenable(events)
	const listenerThenable = isolateUnexpectedThenable(listener)
	const tracingThenable = isolateUnexpectedThenable(tracing)
	if (eventsThenable) throw new TypeError('EVENTS_OBSERVABILITY_UNSUPPORTED')
	if (listenerThenable || typeof listener !== 'function') {
		throw new TypeError('EVENTS_OBSERVABILITY_LISTENER_INVALID')
	}
	const tracingInput = tracingThenable ? undefined : tracing
	isolateCapabilityFields(tracingInput, ['injectHeaders', 'inSpan'], ['withExtractedHeaders'])
	const injectHeaders = captureMethod<Tracing['injectHeaders']>(tracingInput, 'injectHeaders')
	const withExtractedHeaders = captureMethod<NonNullable<Tracing['withExtractedHeaders']>>(tracingInput, 'withExtractedHeaders')
	const inSpan = captureMethod<Tracing['inSpan']>(tracingInput, 'inSpan')

	return attachEventsTelemetry(events, {
		traceContext: injectHeaders ? () => {
			const carrier: Record<string, string> = {}
			try {
				isolateUnexpectedThenable(injectHeaders(carrier))
				const data = (name: string): unknown => {
					const descriptor = Object.getOwnPropertyDescriptor(carrier, name)
					if (!descriptor || !('value' in descriptor)) return undefined
					isolateUnexpectedThenable(descriptor.value)
					return descriptor.value
				}
				const traceparent = data('traceparent')
				const tracestate = data('tracestate')
				const baggage = data('baggage')
				if (typeof traceparent !== 'string' || !TRACEPARENT.test(traceparent)
					|| (tracestate !== undefined && (typeof tracestate !== 'string' || tracestate.length > 1_024))
					|| (baggage !== undefined && (typeof baggage !== 'string' || baggage.length > 8_192))) return undefined
				return Object.freeze({traceparent, ...(tracestate ? {tracestate} : {}), ...(baggage ? {baggage} : {})})
			} catch(error) { isolateUnexpectedThenable(error); return undefined }
		} : undefined,
		withExtracted: withExtractedHeaders
			? (carrier, operation) => traceFailOpen((once) => withExtractedHeaders(carrier, once), operation)
			: undefined,
		withPublish: inSpan
			? (operation) => traceFailOpen((once) => inSpan('events.publish', async() => once(), {kind: 'producer'}), operation)
			: undefined,
		withConsume: inSpan
			? (operation) => traceFailOpen((once) => inSpan('events.consume', async() => once(), {kind: 'consumer'}), operation)
			: undefined,
		emit(event): void {
			try { isolateUnexpectedThenable(listener(Object.freeze({...event}))) }
			catch(error) { isolateUnexpectedThenable(error) }
		}
	})
}
