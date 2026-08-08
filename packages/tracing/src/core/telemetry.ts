import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {createNativePromise} from '@ooopsstudio/core/runtime/async/native-promise'
import {
	addNativeSet,
	deleteNativeSet,
	snapshotNativeSet
} from '@ooopsstudio/core/runtime/collections/native-collections'

import type {TracingRuntimeState, TracingSinkState, TracingStatus} from '../public/types'
import {
	reportExportFailure,
	reportSpanExported,
	reportSpanDropped,
	reportTraceStarted,
	reportExportRetry,
	reportFinalizationFailure,
	reportQueueSize
} from '../utils/self-metrics'

/** Internal self-metrics only; tracing no longer retains raw span snapshots. */
export class TelemetryManager {
	private readonly metrics?: MetricsPort
	private runtimeState: TracingRuntimeState = 'running'
	private sinkState: TracingSinkState = 'healthy'
	private activeSpans = 0
	private droppedTotal = 0
	private retriedTotal = 0
	private lastFailureCode: string | undefined
	private queueSize: () => number = () => 0
	private readonly idleWaiters = new Set<() => void>()

	constructor(metrics?: MetricsPort) {
		if (metrics) this.metrics = metrics
	}

	recordSpansExported(count: number): void {
		reportSpanExported(count, this.metrics)
		if (count > 0 && this.runtimeState !== 'closed') {
			this.sinkState = 'healthy'
			this.lastFailureCode = undefined
		}
	}
	recordSpanProcessed(): void { reportTraceStarted('internal', this.metrics) }

	recordExportFailure(error?: unknown): void {
		reportExportFailure(this.metrics)
		this.sinkState = 'unhealthy'
		this.lastFailureCode = failureCode(error)
	}
	recordPartialDelivery(error?: unknown): void {
		reportExportFailure(this.metrics)
		this.sinkState = 'degraded'
		this.lastFailureCode = failureCode(error)
	}

	recordSpansDropped(count = 1, reason = 'processor', emitMetric = true): void {
		this.droppedTotal += Math.max(0, count)
		if (emitMetric) reportSpanDropped(count, reason, this.metrics)
	}

	spanStarted(kind: string): void {
		this.activeSpans++
		reportTraceStarted(kind, this.metrics)
	}
	spanEnded(): void {
		this.activeSpans = Math.max(0, this.activeSpans - 1)
		if (this.activeSpans === 0) {
			for (const resolve of snapshotNativeSet(this.idleWaiters)) {
				deleteNativeSet(this.idleWaiters, resolve)
				resolve()
			}
		}
	}
	waitForIdle(): Promise<void> {
		if (this.activeSpans === 0) return createNativePromise((resolve) => { resolve() })
		return createNativePromise((resolve) => { addNativeSet(this.idleWaiters, resolve) })
	}
	recordRetry(): void {
		this.retriedTotal++
		this.sinkState = 'degraded'
		reportExportRetry(1, this.metrics)
	}
	setSinkState(state: 'healthy' | 'degraded' | 'unhealthy'): void {
		if (this.runtimeState === 'closed') return
		this.sinkState = state
		if (state === 'healthy') this.lastFailureCode = undefined
	}
	setQueueReader(reader: () => number): void { this.queueSize = reader }
	setRuntimeState(state: TracingRuntimeState): void {
		this.runtimeState = state
		if (state === 'closed') this.sinkState = 'closed'
	}
	markFinalizationFailure(error: unknown): void {
		this.sinkState = 'unhealthy'
		this.lastFailureCode = failureCode(error, 'TRACING_FINALIZATION_FAILURE')
		reportFinalizationFailure('shutdown', this.metrics)
	}
	getActiveSpans(): number { return this.activeSpans }
	getStatus(): TracingStatus {
		let queueSize = 0
		try { queueSize = Math.max(0, Math.trunc(this.queueSize())) } catch { queueSize = 0 }
		reportQueueSize(queueSize, this.metrics)
		return Object.freeze({
			state: this.runtimeState,
			activeSpans: this.activeSpans,
			queueSize,
			droppedTotal: this.droppedTotal,
			retriedTotal: this.retriedTotal,
			sinkState: this.sinkState,
			...(this.lastFailureCode ? {lastFailureCode: this.lastFailureCode} : {})
		})
	}
}

function failureCode(error: unknown, fallback = 'TRACING_EXPORT_FAILURE'): string {
	if (error && typeof error === 'object') {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
			if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string' &&
				/^[A-Z][A-Z0-9_]{1,63}$/u.test(descriptor.value)) return descriptor.value
		} catch { /* hostile failures use the stable fallback */ }
	}
	return fallback
}
