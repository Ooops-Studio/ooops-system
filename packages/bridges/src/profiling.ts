import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'
import {attachProfilingObservability, type ProfilingObservabilityEvent} from '@ooopsstudio/profiling/observability'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type ProfilingBridgeOptions = ObservabilityDestinations

export function wireProfilingObservability(
	runtime: Parameters<typeof attachProfilingObservability>[0],
	options: ProfilingBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	const increment = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['increment']>>(configured.metrics, 'increment'))
	const record = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['record']>>(configured.metrics, 'record'))
	const logError = createBoundedBridgeInvoker(captureBridgeMethod<Logging['error']>(configured.logger, 'error'))
	const logInfo = createBoundedBridgeInvoker(captureBridgeMethod<Logging['info']>(configured.logger, 'info'))
	const report = createBoundedBridgeInvoker(captureBridgeMethod<Errors['report']>(configured.errors, 'report'))
	let failing = false
	const failure = (code: string): void => {
		if (!failing) logError('Profiling operation failed', {code})
		failing = true
		report(normalizeError(new Error(code)), {stage: 'profiling', code})
	}
	return attachProfilingObservability(runtime, (event: ProfilingObservabilityEvent) => {
		switch (event.kind) {
			case 'capture_started': record('_profiling_active_capture', 1); break
			case 'capture_completed': increment('_profiling_captures_total', {result: 'success'}); record('_profiling_active_capture', 0); break
			case 'dropped': increment('_profiling_dropped_total', {reason: event.reason}); increment('_profiling_captures_total', {result: 'dropped'}); break
			case 'capture_failed': increment('_profiling_captures_total', {result: 'failure'}); record('_profiling_active_capture', 0); failure('PROFILING_CAPTURE_FAILURE'); break
			case 'export_failed': increment('_profiling_export_failures_total', undefined, event.count); failure('PROFILING_EXPORT_FAILURE'); break
			case 'continuous_failed': increment('_profiling_continuous_failures_total', {operation: event.operation}); failure('PROFILING_CONTINUOUS_FAILURE'); break
			case 'finalization_failed': increment('_profiling_finalization_failures_total', {operation: event.operation}); failure('PROFILING_FINALIZATION_FAILURE'); break
			case 'recovered': if (failing) { failing = false; logInfo('Profiling delivery recovered') } break
		}
	})
}
