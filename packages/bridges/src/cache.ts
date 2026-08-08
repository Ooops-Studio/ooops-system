import {attachCacheObservability, type CacheObservabilityEvent} from '@ooopsstudio/cache/observability'
import type {ManagedCache} from '@ooopsstudio/core/ports/cache'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type CacheBridgeOptions = ObservabilityDestinations

export function wireCacheObservability(
	cache: ManagedCache,
	options: CacheBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	const increment = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['increment']>>(configured.metrics, 'increment'))
	const record = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['record']>>(configured.metrics, 'record'))
	const logError = createBoundedBridgeInvoker(captureBridgeMethod<Logging['error']>(configured.logger, 'error'))
	const logInfo = createBoundedBridgeInvoker(captureBridgeMethod<Logging['info']>(configured.logger, 'info'))
	const report = createBoundedBridgeInvoker(captureBridgeMethod<Errors['report']>(configured.errors, 'report'))
	const breadcrumb = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<Tracing['addBreadcrumb']>>(configured.tracer, 'addBreadcrumb'))
	let failing = false
	const failure = (code: string): void => {
		if (failing) return
		failing = true
		logError('Cache backend operation failed', {code})
		breadcrumb({category: 'cache', message: 'Cache backend operation failed', level: 'error', data: {code}})
		report(normalizeError(new Error(code)), {stage: 'cache', code})
	}
	return attachCacheObservability(cache, (event: CacheObservabilityEvent) => {
		switch (event.kind) {
			case 'operation': increment('_cache_operations_total', {operation: event.operation, result: event.result}); break
			case 'lookup': increment('_cache_lookups_total', {result: event.result}); break
			case 'dropped': increment('_cache_dropped_total', {reason: event.reason}); break
			case 'active_operations': record('_cache_active_operations', event.count); break
			case 'active_loads': record('_cache_active_loads', event.count); break
			case 'backend_failed': increment('_cache_backend_failures_total', {operation: event.operation}); failure(event.code); break
			case 'finalization_failed': increment('_cache_finalization_failures_total', {operation: event.operation}); failure(event.code); break
			case 'recovered': if (failing) { failing = false; logInfo('Cache backend recovered') } break
		}
	})
}
