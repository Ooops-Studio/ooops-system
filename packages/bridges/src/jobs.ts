import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {ManagedJobs} from '@ooopsstudio/core/ports/jobs'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'
import {attachJobsObservability, type JobsObservabilityEvent, type JobsTracing} from '@ooopsstudio/jobs/observability'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type JobsBridgeOptions = ObservabilityDestinations

export function wireJobsObservability(
	jobs: ManagedJobs,
	options: JobsBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	const increment = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['increment']>>(configured.metrics, 'increment'))
	const record = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['record']>>(configured.metrics, 'record'))
	const report = createBoundedBridgeInvoker(captureBridgeMethod<Errors['report']>(configured.errors, 'report'))
	const logs = {
		debug: createBoundedBridgeInvoker(captureBridgeMethod<Logging['debug']>(configured.logger, 'debug')),
		info: createBoundedBridgeInvoker(captureBridgeMethod<Logging['info']>(configured.logger, 'info')),
		warn: createBoundedBridgeInvoker(captureBridgeMethod<Logging['warn']>(configured.logger, 'warn')),
		error: createBoundedBridgeInvoker(captureBridgeMethod<Logging['error']>(configured.logger, 'error'))
	}
	let failing = false
	const safeAttributes = (
		value: Readonly<Record<string, unknown>> | undefined
	): Record<string, string | number | boolean> | undefined => {
		if (!value) return undefined
		const result: Record<string, string | number | boolean> = {}
		for (const [key, item] of Object.entries(value).slice(0, 32)) {
			if (typeof item === 'string') result[key] = item.slice(0, 512)
			else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item
			else if (typeof item === 'boolean') result[key] = item
		}
		return result
	}
	const failure = (event: Extract<JobsObservabilityEvent, {kind: 'operation_failed' | 'finalization_failed'}>): void => {
		if (!failing) logs.error('Jobs operation failed', {operation: event.operation, code: event.code})
		failing = true
		if (event.kind === 'finalization_failed' || event.reportable) {
			report(normalizeError(new Error(event.code)), {stage: 'jobs', code: event.code, operation: event.operation})
		}
	}
	return attachJobsObservability(jobs, (event: JobsObservabilityEvent) => {
		switch (event.kind) {
			case 'enqueued': increment('_jobs_enqueued_total', {result: event.result}); break
			case 'execution': increment('_jobs_executions_total', {result: event.result}); break
			case 'retry': increment('_jobs_retries_total'); break
			case 'active': record('_jobs_active_runs', event.count); break
			case 'rejected': increment('_jobs_rejections_total', {reason: event.reason}); break
			case 'operation_failed': increment('_jobs_operation_failures_total', {operation: event.operation}); failure(event); break
			case 'finalization_failed': increment('_jobs_finalization_failures_total', {operation: event.operation}); failure(event); break
			case 'log': logs[event.level](event.message, safeAttributes(event.attributes)); break
			case 'recovered': if (failing) { failing = false; logs.info('Jobs runtime recovered') } break
		}
	}, configured.tracer as JobsTracing | undefined)
}
