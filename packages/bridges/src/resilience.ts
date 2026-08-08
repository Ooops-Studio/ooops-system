import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'
import {attachResilienceObservability, type ResilienceObservabilityEvent} from '@ooopsstudio/resilience/observability'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type ResilienceBridgeOptions = ObservabilityDestinations

export function wireResilienceObservability(
	runtime: Parameters<typeof attachResilienceObservability>[0],
	options: ResilienceBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	const increment = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['increment']>>(configured.metrics, 'increment'))
	const record = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['record']>>(configured.metrics, 'record'))
	const logError = createBoundedBridgeInvoker(captureBridgeMethod<Logging['error']>(configured.logger, 'error'))
	const report = createBoundedBridgeInvoker(captureBridgeMethod<Errors['report']>(configured.errors, 'report'))
	return attachResilienceObservability(runtime, (event: ResilienceObservabilityEvent) => {
		switch (event.kind) {
			case 'active_operations': record('_resilience_active_operations', event.count); break
			case 'queued_operations': record('_resilience_queued_operations', event.count); break
			case 'execution': increment('_resilience_executions_total', {result: event.result}); break
			case 'retry': increment('_resilience_retries_total'); break
			case 'rejection': increment('_resilience_rejections_total', {reason: event.reason}); break
			case 'finalization_failed':
				increment('_resilience_finalization_failures_total', {operation: event.operation})
				logError('Resilience finalization failed', {code: event.code})
				report(normalizeError(new Error(event.code)), {stage: 'resilience', code: event.code})
				break
		}
	})
}
