import {attachAuditObservability, type AuditObservabilityEvent} from '@ooopsstudio/audit/observability'
import type {ManagedAudit} from '@ooopsstudio/core/ports/audit'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type AuditBridgeOptions = ObservabilityDestinations

export function wireAuditObservability(
	audit: ManagedAudit,
	options: AuditBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	const increment = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['increment']>>(configured.metrics, 'increment'))
	const record = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['record']>>(configured.metrics, 'record'))
	const logError = createBoundedBridgeInvoker(captureBridgeMethod<Logging['error']>(configured.logger, 'error'))
	const logInfo = createBoundedBridgeInvoker(captureBridgeMethod<Logging['info']>(configured.logger, 'info'))
	const report = createBoundedBridgeInvoker(captureBridgeMethod<Errors['report']>(configured.errors, 'report'))
	const breadcrumb = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<Tracing['addBreadcrumb']>>(configured.tracer, 'addBreadcrumb'))
	let failing = false
	const failure = (code: string, reportable: boolean): void => {
		if (!failing) logError('Audit operation failed', {code})
		failing = true
		breadcrumb({category: 'audit', message: 'Audit operation failed', level: 'error', data: {code}})
		if (reportable) report(normalizeError(new Error(code)), {stage: 'audit', code})
	}
	return attachAuditObservability(audit, (event: AuditObservabilityEvent) => {
		switch (event.kind) {
			case 'active': record('_audit_active_operations', event.count); break
			case 'recorded': increment('_audit_records_total', {result: 'success'}, event.count); break
			case 'operation_failed':
				increment('_audit_operation_failures_total', {operation: event.operation})
				if (event.operation === 'record' || event.operation === 'transaction') increment('_audit_records_total', {result: 'failure'})
				failure(event.code, event.reportable); break
			case 'integrity_failed': increment('_audit_integrity_failures_total'); break
			case 'pruned': increment('_audit_pruned_records_total', undefined, event.count); break
			case 'finalization_failed': increment('_audit_finalization_failures_total', {operation: event.operation}); failure(event.code, true); break
			case 'recovered': if (failing) logInfo('Audit operation recovered'); failing = false; break
		}
	})
}
