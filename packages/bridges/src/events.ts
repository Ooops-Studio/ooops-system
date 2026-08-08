import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {ManagedEvents} from '@ooopsstudio/core/ports/events'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'
import {attachEventsObservability, type EventsObservabilityEvent, type EventsTracing} from '@ooopsstudio/events/observability'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type EventsBridgeOptions = ObservabilityDestinations

export function wireEventsObservability(
	events: ManagedEvents,
	options: EventsBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	const increment = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['increment']>>(configured.metrics, 'increment'))
	const record = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['record']>>(configured.metrics, 'record'))
	const warn = createBoundedBridgeInvoker(captureBridgeMethod<Logging['warn']>(configured.logger, 'warn'))
	const logError = createBoundedBridgeInvoker(captureBridgeMethod<Logging['error']>(configured.logger, 'error'))
	const logInfo = createBoundedBridgeInvoker(captureBridgeMethod<Logging['info']>(configured.logger, 'info'))
	const report = createBoundedBridgeInvoker(captureBridgeMethod<Errors['report']>(configured.errors, 'report'))
	let failed = false
	const reportFailure = (
		name: string,
		code: string,
		context: Readonly<Record<string, JsonValue>> = {}
	): void => {
		report(normalizeError({name, message: code, code}), context)
		failed = true
	}
	const observe = (event: EventsObservabilityEvent): void => {
		switch (event.kind) {
			case 'published': increment('_events_published_total', {result: event.result}); break
			case 'delivered':
				increment('_events_delivered_total', {result: event.result, transport: event.transport})
				if (event.result === 'failure') {
					logError('Events delivery failed terminally', {code: 'EVENTS_DELIVERY_FAILURE'})
					reportFailure('EventsDeliveryError', 'EVENTS_DELIVERY_FAILURE')
				} else if (event.result === 'success' && failed) {
					failed = false; logInfo('Events delivery recovered', {code: 'EVENTS_RECOVERED'})
				}
				break
			case 'consumed': increment('_events_consumed_total', {result: event.result}); break
			case 'retry': increment('_events_retries_total'); warn('Events delivery will retry', {code: 'EVENTS_RETRY'}); break
			case 'active': record('_events_active_operations', event.value); break
			case 'queue': record('_events_queue_size', event.size); break
			case 'finalization-failure':
				increment('_events_finalization_failures_total', {operation: event.operation})
				logError('Events finalization failed', {code: 'EVENTS_FINALIZATION_FAILURE', operation: event.operation})
				reportFailure('EventsFinalizationError', 'EVENTS_FINALIZATION_FAILURE', {operation: event.operation})
				break
		}
	}
	return attachEventsObservability(events, observe, configured.tracer as EventsTracing | undefined)
}
