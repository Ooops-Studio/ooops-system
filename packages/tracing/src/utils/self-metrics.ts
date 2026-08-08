import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {safeIncrement, safeRecord} from '@ooopsstudio/core/utils/self-metrics'

export function reportTraceStarted(kind: string, metrics?: MetricsPort): void {
	safeIncrement(metrics, '_traces_started_total', {kind})
}

export function reportSpanExported(count: number, metrics?: MetricsPort): void {
	if (count <= 0) return
	safeIncrement(metrics, '_traces_exported_total', {}, count)
}

export function reportExportFailure(metrics?: MetricsPort): void {
	safeIncrement(metrics, '_traces_export_failures_total')
}

export function reportQueueSize(size: number, metrics?: MetricsPort): void {
	safeRecord(metrics, '_traces_queue_size', size, {})
}

export function reportSpanDropped(count: number, reason: string, metrics?: MetricsPort): void {
	if (count <= 0) return
	safeIncrement(metrics, '_traces_dropped_total', {reason}, count)
}

export function reportExportRetry(count: number, metrics?: MetricsPort): void {
	if (count <= 0) return
	safeIncrement(metrics, '_traces_export_retries_total', {}, count)
}

export function reportFinalizationFailure(operation: string, metrics?: MetricsPort): void {
	safeIncrement(metrics, '_traces_finalization_failures_total', {operation})
}
