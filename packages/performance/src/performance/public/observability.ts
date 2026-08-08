import type {BudgetViolation, N1Pattern, PerfEvent, SaturationAlert} from '@ooopsstudio/core/contracts/performance'

import {attachPerformanceTelemetry} from '../core/runtime-capabilities'
import type {ManagedPerformance} from '../types/ports'
import {isRuntimePromise} from '../utils/safe-object'

export type PerformanceObservabilityEvent =
	| {readonly kind: 'budget_violation'; readonly violation: Readonly<BudgetViolation>}
	| {readonly kind: 'saturation_alert'; readonly alert: Readonly<SaturationAlert>}
	| {readonly kind: 'dimension_explosion' | 'dimension_drop'; readonly metricName: string; readonly reason: string}
	| {readonly kind: 'n1_pattern'; readonly pattern: Readonly<N1Pattern>}
	| {readonly kind: 'performance_event'; readonly event: Readonly<PerfEvent>}
	| {readonly kind: 'self_metric'; readonly name: string; readonly value: number; readonly labels?: Readonly<Record<string, string>>}

export type PerformanceObservabilityAttachment = () => void
export type PerformanceObservabilityListener = (event: PerformanceObservabilityEvent) => void

const attachments = new WeakSet<ManagedPerformance>()
const emissions = new WeakMap<ManagedPerformance, object>()
const OBSERVABILITY_LISTENER_TIMEOUT_MS = 5_000

/** Attach one fail-open, bounded listener without exposing runtime internals. */
export function attachPerformanceObservability(
	performance: ManagedPerformance,
	listener: PerformanceObservabilityListener
): PerformanceObservabilityAttachment {
	if (typeof listener !== 'function') throw new TypeError('performance_invalid_observability')
	if (attachments.has(performance)) throw new Error('PERFORMANCE_OBSERVABILITY_ATTACHED')
	let listenerDisabled = false
	const emit = (event: PerformanceObservabilityEvent): unknown => {
		if (listenerDisabled || emissions.has(performance)) return undefined
		const emission = {}
		emissions.set(performance, emission)
		let listenerTimeout: ReturnType<typeof setTimeout> | undefined
		const release = () => {
			if (emissions.get(performance) === emission) emissions.delete(performance)
			if (listenerTimeout !== undefined) {
				try { clearTimeout(listenerTimeout) } catch { /* listener settlement remains authoritative */ }
				listenerTimeout = undefined
			}
		}
		try {
			const result: unknown = listener(Object.freeze(event))
			if (isRuntimePromise(result)) {
				try {
					listenerTimeout = setTimeout(() => {
						listenerDisabled = true
						release()
					}, OBSERVABILITY_LISTENER_TIMEOUT_MS)
					try { listenerTimeout.unref?.() } catch { /* optional process-lifetime optimization */ }
				} catch {
					listenerDisabled = true
					release()
				}
				try { void Reflect.apply(Promise.prototype.then, result, [release, release]) } catch { release() }
			} else release()
			return result
		} catch { release(); return undefined }
	}
	const detachTelemetry = attachPerformanceTelemetry(performance, {
		onBudgetViolation: (violation) => emit({kind: 'budget_violation', violation}),
		onSaturationAlert: (alert) => emit({kind: 'saturation_alert', alert}),
		onDimensionExplosion: (metricName, reason) => emit({kind: 'dimension_explosion', metricName, reason}),
		onDimensionDrop: (metricName, reason) => emit({kind: 'dimension_drop', metricName, reason}),
		onN1Pattern: (pattern) => emit({kind: 'n1_pattern', pattern}),
		onPerfEvent: (event) => emit({kind: 'performance_event', event}),
		onSelfMetric: (name, value, labels) => emit({kind: 'self_metric', name, value, ...(labels ? {labels} : {})})
	})
	attachments.add(performance)
	let active = true
	return () => {
		if (!active) return
		active = false
		attachments.delete(performance)
		detachTelemetry()
	}
}
