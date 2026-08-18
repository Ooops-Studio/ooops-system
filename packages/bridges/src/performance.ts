import type {PerfEvent} from '@ooopsstudio/core/contracts/performance'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {attachPerformanceObservability, type PerformanceObservabilityEvent} from '@ooopsstudio/performance/observability'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from './internal/capabilities'
import type {ObservabilityDestinations} from './internal/types'

export type PerformanceBridgeOptions = ObservabilityDestinations

const isResourceSnapshot = (event: PerfEvent): boolean =>
	event.source === 'runtime' && (event.name === 'cpu_usage' || event.name === 'memory_usage')

export function wirePerformanceObservability(
	runtime: Parameters<typeof attachPerformanceObservability>[0],
	options: PerformanceBridgeOptions = {}
): () => void {
	const configured = snapshotBridgeOptions(options, ['logger', 'errors', 'metrics', 'tracer'] as const)
	const increment = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['increment']>>(configured.metrics, 'increment'))
	const record = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<MetricsPort['record']>>(configured.metrics, 'record'))
	const info = createBoundedBridgeInvoker(captureBridgeMethod<Logging['info']>(configured.logger, 'info'))
	const warn = createBoundedBridgeInvoker(captureBridgeMethod<Logging['warn']>(configured.logger, 'warn'))
	const breadcrumb = createBoundedBridgeInvoker(captureBridgeMethod<NonNullable<Tracing['addBreadcrumb']>>(configured.tracer, 'addBreadcrumb'))
	const getActiveSpan = captureBridgeMethod<Tracing['getActiveSpan']>(configured.tracer, 'getActiveSpan')
	const decorateSpan = (event: PerfEvent): void => {
		const span = (() => { try { return getActiveSpan?.() } catch { return undefined } })()
		const setAttribute = createBoundedBridgeInvoker(captureBridgeMethod<(key: string, value: unknown) => unknown>(span, 'setAttribute'))
		setAttribute('performance.measurement', Object.freeze({name: event.name, durationMs: event.duration, source: event.source}))
	}
	return attachPerformanceObservability(runtime, (item: PerformanceObservabilityEvent) => {
		switch (item.kind) {
			case 'self_metric':
				if (item.name === '_performance_active_measurements' || item.name === '_performance_export_queue_size') record(item.name, item.value, item.labels as Record<string, string>)
				else increment(item.name, item.labels as Record<string, string>, item.value)
				break
			case 'budget_violation':
				warn('Performance budget violated', {budget_name: item.violation.name, target: item.violation.target, actual: item.violation.actual})
				breadcrumb({category: 'performance.budget', message: 'Performance budget violated', level: 'warn', data: {name: item.violation.name, target: item.violation.target, actual: item.violation.actual}})
				break
			case 'saturation_alert': {
				const state = item.alert.state
				const previousState = item.alert.previousState
				const attributes = {
					reason: item.alert.reason,
					severity: item.alert.severity,
					value: item.alert.value,
					threshold: item.alert.threshold,
					...(state ? {state} : {}),
					...(previousState ? {previous_state: previousState} : {}),
					...(item.alert.aggregation ? {aggregation: item.alert.aggregation} : {}),
					...(item.alert.sampleCount !== undefined ? {sample_count: item.alert.sampleCount} : {})
				}
				const wasActive = previousState === 'warn' || previousState === 'critical'
				const isActive = state === 'warn' || state === 'critical'
				if (state && wasActive && !isActive) {
					info('Performance saturation recovered', attributes)
					breadcrumb({category: 'performance.saturation', message: 'Performance saturation recovered', level: 'info', data: attributes})
				} else if (state === 'info') {
					// Informational transitions remain available to metrics consumers but
					// do not create operational log noise.
				} else if (item.alert.reminder) {
					warn('Performance saturation persists', attributes)
					breadcrumb({category: 'performance.saturation', message: 'Performance saturation persists', level: item.alert.severity, data: attributes})
				} else if (state && isActive) {
					warn('Performance saturation state changed', attributes)
					breadcrumb({category: 'performance.saturation', message: 'Performance saturation state changed', level: item.alert.severity, data: attributes})
				} else if (!state) {
					// Preserve mappings for saturation producers that have not adopted
					// transition metadata yet.
					warn('Performance saturation detected', attributes)
					breadcrumb({category: 'performance.saturation', message: 'Performance saturation detected', level: item.alert.severity, data: attributes})
				}
				break
			}
			case 'dimension_explosion': case 'dimension_drop': warn('Performance dimensions dropped', {metric_name: item.metricName, reason: item.reason}); break
			case 'n1_pattern':
				warn('N+1 pattern detected', {pattern_type: item.pattern.type, duplicate_count: item.pattern.duplicateCount, query_signature: item.pattern.querySignature})
				breadcrumb({category: 'performance.n1', message: 'N+1 pattern detected', level: 'warn', data: {type: item.pattern.type, duplicateCount: item.pattern.duplicateCount}})
				break
			case 'performance_event': {
				const event = item.event
				if (isResourceSnapshot(event) && event.name === 'cpu_usage') {
					record('process_cpu_utilization', Number(event.labels?.utilization ?? 0)); record('process_cpu_user_ms', Number(event.labels?.user ?? 0)); record('process_cpu_system_ms', Number(event.labels?.system ?? 0))
				} else if (isResourceSnapshot(event) && event.name === 'memory_usage') {
					record('process_resident_memory_bytes', Number(event.labels?.rss ?? 0)); record('process_heap_used_bytes', Number(event.labels?.heapUsed ?? 0)); record('process_heap_total_bytes', Number(event.labels?.heapTotal ?? 0)); record('process_external_memory_bytes', Number(event.labels?.external ?? 0))
				} else record(event.name, event.duration, {source: event.source})
				if (event.labels?.instrumentation !== 'span') breadcrumb({category: 'performance.measurement', message: event.name, level: 'info', data: {durationMs: event.duration, source: event.source}})
				decorateSpan(event); break
			}
		}
	})
}
