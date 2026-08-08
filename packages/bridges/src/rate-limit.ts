import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {ManagedRateLimit} from '@ooopsstudio/core/ports/ratelimit'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'
import {attachRateLimitObservability, type RateLimitObservabilityEvent} from '@ooopsstudio/rate-limit/observability'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type RateLimitBridgeOptions = ObservabilityDestinations

export function wireRateLimitObservability(
	runtime: ManagedRateLimit,
	options: RateLimitBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	const increment = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['increment']>>(configured.metrics, 'increment'))
	const record = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['record']>>(configured.metrics, 'record'))
	const logError = createBoundedBridgeInvoker(captureBridgeMethod<Logging['error']>(configured.logger, 'error'))
	const logInfo = createBoundedBridgeInvoker(captureBridgeMethod<Logging['info']>(configured.logger, 'info'))
	const report = createBoundedBridgeInvoker(captureBridgeMethod<Errors['report']>(configured.errors, 'report'))
	let failing = false
	const failure = (code: string): void => {
		if (!failing) { failing = true; logError('Rate limit backend failed', {code}) }
		report(normalizeError(new Error(code)), {stage: 'rate-limit', code})
	}
	return attachRateLimitObservability(runtime, (event: RateLimitObservabilityEvent) => {
		switch (event.kind) {
			case 'check': increment('_rate_limit_checks_total', {result: event.result}); break
			case 'rejection': increment('_rate_limit_rejections_total', {reason: event.reason}); break
			case 'active_operations': record('_rate_limit_active_operations', event.count); break
			case 'backend_failed': increment('_rate_limit_backend_failures_total'); failure(event.code); break
			case 'finalization_failed': increment('_rate_limit_finalization_failures_total', {operation: event.operation}); failure(event.code); break
			case 'recovered': if (failing) { failing = false; logInfo('Rate limit backend recovered') } break
		}
	})
}
