import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {BudgetViolation, N1Pattern, PerfEvent, SaturationAlert} from '@ooopsstudio/core/contracts/performance'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {PerformanceEventExporterPort} from '@ooopsstudio/core/ports/performance'

import {createBudgetEngine, type BudgetConfig} from '../features/core/budget-engine'
import {createN1Detector, type N1DetectorOptions} from '../features/db/n1-detector'
import type {PerformanceHandlerPort} from '../types/ports'

import {
	createBasePerformanceHandler,
	type BasePerformanceHandlerOptions
} from './base-handler'
import type {PerformanceTelemetryCallbacks} from './callback-dispatcher'
import {createEventExportManager} from './event-export-manager'
import {toPerformanceEventRecord} from './utils/request-helpers'

export interface PerformanceHandlerOptions extends Omit<
	BasePerformanceHandlerOptions,
	'callbacks' | 'createExtensions'
> {
	budgets?: readonly BudgetConfig[]
	n1Detection?: N1DetectorOptions
	eventExporters?: ReadonlyArray<{name: string; exporter: PerformanceEventExporterPort}>
	eventExportBuffer?: {maxCount?: number; maxBytes?: number; flushIntervalMs?: number}
	eventExportRetry?: {attempts?: number; baseDelayMs?: number; timeoutMs?: number}
	metrics?: MetricsPort
	resource?: ObservabilityResource
	onBudgetViolation?: (violation: BudgetViolation) => void
	onSaturationAlert?: (alert: SaturationAlert) => void
	onDimensionExplosion?: (metricName: string, reason: string) => void
	onN1Pattern?: (pattern: N1Pattern) => void
	onDimensionDrop?: (metricName: string, reason: string) => void
	onPerfEvent?: (event: PerfEvent) => void
}

const toCallbacks = (options: PerformanceHandlerOptions): PerformanceTelemetryCallbacks => ({
	...(options.onBudgetViolation ? {onBudgetViolation: options.onBudgetViolation} : {}),
	...(options.onSaturationAlert ? {onSaturationAlert: options.onSaturationAlert} : {}),
	...(options.onDimensionExplosion ? {onDimensionExplosion: options.onDimensionExplosion} : {}),
	...(options.onN1Pattern ? {onN1Pattern: options.onN1Pattern} : {}),
	...(options.onDimensionDrop ? {onDimensionDrop: options.onDimensionDrop} : {}),
	...(options.onPerfEvent ? {onPerfEvent: options.onPerfEvent} : {})
})

export function createPerformanceHandler(
	options: PerformanceHandlerOptions
): PerformanceHandlerPort {
	return createBasePerformanceHandler({
		clock: options.clock,
		cardinalityLimit: options.cardinalityLimit,
		cardinalityMode: options.cardinalityMode,
		enableEventLoopMonitor: options.enableEventLoopMonitor,
		enableGCMonitor: options.enableGCMonitor,
		enableResourceMonitor: options.enableResourceMonitor,
		...(options.errors ? {errors: options.errors} : {}),
		...(options.tracer ? {tracer: options.tracer} : {}),
		callbacks: toCallbacks(options),
		createExtensions(dispatcher, clock) {
			const budgetEngine = options.budgets
				? createBudgetEngine({
					now: clock.now,
					onViolation: (violation) => dispatcher.emit('onBudgetViolation', violation)
				})
				: undefined
			for (const budget of options.budgets ?? []) budgetEngine?.registerBudget(budget)
			const n1Detector = options.n1Detection
				? createN1Detector(options.n1Detection)
				: undefined
			const exportManager = options.eventExporters?.length
				? createEventExportManager({
					exporters: options.eventExporters,
					maxBufferCount: options.eventExportBuffer?.maxCount ?? 1_000,
					maxBufferBytes: options.eventExportBuffer?.maxBytes ?? 1_048_576,
					flushIntervalMs: options.eventExportBuffer?.flushIntervalMs ?? 1_000,
					retryAttempts: options.eventExportRetry?.attempts ?? 2,
					retryBaseDelayMs: options.eventExportRetry?.baseDelayMs ?? 100,
					operationTimeoutMs: options.eventExportRetry?.timeoutMs ?? 5_000,
					...(options.errors ? {errors: options.errors} : {}),
					observe: (name, value, labels) => dispatcher.emit('onSelfMetric', name, value, labels)
				})
				: undefined
			return {
				onAcceptedEvent(event) {
					budgetEngine?.checkEvent(event)
					if (n1Detector && event.name.startsWith('db.')) {
						for (const pattern of n1Detector.check(event)) {
							dispatcher.emit('onN1Pattern', pattern)
						}
					}
					exportManager?.enqueue(toPerformanceEventRecord(event, options.resource))
				},
				getBudgetStatus: (name) => budgetEngine?.getStatus(name),
				flush: async() => exportManager?.flush(),
				shutdown: async() => exportManager?.shutdown(),
				getExportStatus: () => exportManager?.getStatus() ?? {
					queueSize: 0,
					droppedTotal: 0,
					retriedTotal: 0,
					sinkState: 'healthy'
				}
			}
		}
	})
}
