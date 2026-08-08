import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import type {SpanExporterPort, SpanExportResultPort, SpanProcessorPort} from '../types/ports'
import {createTracingOnError} from '../utils/on-error'
import {reportSpanDropped} from '../utils/self-metrics'

import {
	pushNativeArray,
	spliceNativeArray
} from './native-runtime'
import {observeNativePromiseSettlement} from './native-runtime'
import type {BatchingConfig, DeliveryObservableExporter, ProcessorObserver} from './processor-types'
import {
	captureErrorsPort,
	clearTimerSafely,
	captureDeliveryObserverSetter,
	captureMetricsPort,
	captureProcessorObserver,
	captureSpanExporter,
	captureTimerOwnership,
	estimateSpanSize,
	invokeNativeAsync,
	normalizeTracingError,
	snapshotSpanRecord,
	snapshotSpanExportResult,
	waitForExporterShutdown,
	waitForProcessorDrain
} from './processor-utils'
import type {TimerOwnership} from './processor-utils'
import {deepFreezeSpanRecord} from './span-recorder-safety'
const nativeMathMax = Math.max

/** Bounded asynchronous batch processor for remote tracing exporters. */
export class BatchingProcessor implements SpanProcessorPort {
	private readonly batch: SpanRecord[] = []
	private batchId = 0
	private readonly exporter: SpanExporterPort
	private readonly setDeliveryObserver?: DeliveryObservableExporter['setDeliveryObserver']
	private readonly config: BatchingConfig
	private readonly metrics?: MetricsPort
	private readonly errors?: Errors
	private telemetry?: ProcessorObserver
	private batchBytes = 0
	private flushTimer: ReturnType<typeof setTimeout> | undefined
	private flushInFlight: Promise<void> | undefined
	private backgroundFlush: Promise<void> | undefined
	/** A background export failure that the next explicit flush must surface. */
	private pendingFailure: {error: unknown; id: number} | undefined
	private admissionId = 0
	private shutdownRequested = false
	private shutdownPromise: Promise<void> | undefined
	private exporterClosed = false
	private exporterFinalizing = false
	private exporterShutdownAttempt: Promise<void> | undefined
	private readonly timers: TimerOwnership
	private clearFlushTimer(): void {
		clearTimerSafely(this.flushTimer, this.timers)
		this.flushTimer = undefined
	}

	constructor(exporter: SpanExporterPort, config: BatchingConfig, _clock: Clock, metrics?: MetricsPort, errors?: Errors) {
		if (!Number.isInteger(config.maxBatch) || config.maxBatch <= 0 || config.maxBatch > 100_000) throw new Error('Tracing batch maxBatch must be between 1 and 100000')
		if (!Number.isFinite(config.maxIntervalMs) || config.maxIntervalMs <= 0 || config.maxIntervalMs > 2_147_483_647) throw new Error('Tracing batch maxIntervalMs must be between 1 and 2147483647')
		if (!Number.isInteger(config.maxBytes) || config.maxBytes <= 0 || config.maxBytes > 100_000_000) throw new Error('Tracing batch maxBytes must be between 1 and 100000000')
		const setDeliveryObserver = captureDeliveryObserverSetter(exporter)
		this.exporter = captureSpanExporter(exporter)
		if (setDeliveryObserver) this.setDeliveryObserver = setDeliveryObserver
		this.config = Object.freeze({...config})
		this.timers = captureTimerOwnership()
		const safeMetrics = captureMetricsPort(metrics)
		const safeErrors = captureErrorsPort(errors)
		if (safeMetrics) this.metrics = safeMetrics
		if (safeErrors) this.errors = safeErrors
	}

	setObserver(observer: ProcessorObserver): void {
		this.telemetry = captureProcessorObserver(observer)
		this.setDeliveryObserver?.(this.telemetry)
	}
	getQueueSize(): number { return this.batch.length }

	onEnd(span: SpanRecord): void {
		if (this.shutdownRequested) {
			const error = new Error('Tracing span ended after processor shutdown admission closed')
			try { isolateUnexpectedThenable(this.telemetry?.onDropped?.(1, error, true)) } catch { /* observers are isolated */ }
			reportSpanDropped(1, 'processor-shutdown', this.metrics)
			return
		}
		const admissionId = ++this.admissionId
		const snapshot = snapshotSpanRecord(span)
		if (!snapshot) {
			const error = new Error('Tracing batch processor rejected an unsafe span record')
			this.reportExportFailure(error, 1)
			this.recordFailure(error, admissionId)
			return
		}
		const safeSpan = deepFreezeSpanRecord(snapshot)
		const size = estimateSpanSize(safeSpan)
		if (size > this.config.maxBytes) {
			const error = new Error('Tracing span exceeds the maximum batch size')
			this.reportExportFailure(error, 1)
			this.recordFailure(error, admissionId)
			return
		}
		if (this.batch.length > 0 && (
			this.batch.length >= this.config.maxBatch || this.batchBytes + size > this.config.maxBytes
		)) {
			this.flushBackground()
			// flushBatch removes the queued batch synchronously when no export is
			// active. If an export is already in flight, however, the queue cannot
			// be drained yet. Never let that second-stage queue grow without bound.
			if (this.batch.length >= this.config.maxBatch || this.batchBytes + size > this.config.maxBytes) {
				this.reportQueueOverflow(admissionId)
				return
			}
		}
		pushNativeArray(this.batch, safeSpan)
		this.batchId = admissionId
		this.batchBytes += size
		if (this.batch.length >= this.config.maxBatch || this.batchBytes >= this.config.maxBytes) {
			this.flushBackground()
		} else if (!this.flushTimer) {
			try {
				let fired = false
				const timer = this.timers.schedule(() => {
					fired = true
					this.flushTimer = undefined
					this.flushBackground()
				}, this.config.maxIntervalMs)
				// Guard against a non-conforming host invoking the callback before
				// setTimeout returns; publishing that already-fired handle would block
				// all future autonomous flush scheduling.
				if (fired) {
					clearTimerSafely(timer, this.timers)
				} else {
					this.flushTimer = timer
					this.flushTimer.unref?.()
				}
			} catch(error) {
				this.clearFlushTimer()
				this.reportExportFailure(normalizeTracingError(error, 'Tracing batch timer unavailable'), 0)
				// Scheduling is only an optimization. Immediately claim the admitted
				// batch so it cannot remain stranded indefinitely.
				this.flushBackground()
			}
		}
	}

	async flush(): Promise<void> {
		try { await waitForProcessorDrain(this.flushBoundedBarrier(), this.timers) } catch(error) {
			throw normalizeTracingError(error, 'Tracing batch processor flush failed')
		}
	}

	private async flushBoundedBarrier(): Promise<void> {
		// Every caller gets its own barrier. A second forceFlush issued while an
		// export is active must also drain spans admitted before that second call.
		await this.flushInternal(true)
		if (!this.exporterFinalizing && this.exporter.flush) {
			await invokeNativeAsync<void>(() => this.exporter.flush!(), 'Tracing exporter flush', true)
		}
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		this.shutdownRequested = true
		// Wake resilient-exporter backoffs before waiting for the drain. The
		// exporter still admits one first attempt for every batch already queued.
		try { isolateUnexpectedThenable(this.exporter.prepareShutdown?.()) } catch { /* drain interruption is advisory */ }
		const pending = (async() => {
			this.clearFlushTimer()
			const failures: unknown[] = []
			if (!this.exporterClosed) {
				try { await this.flush() } catch(error) { pushNativeArray(failures, error) }
			}
			if (!this.exporterClosed) {
				try {
					this.exporterFinalizing = true
					if (!this.exporterShutdownAttempt) {
						const attempt = invokeNativeAsync<void>(
							() => this.exporter.shutdown(), 'Tracing exporter shutdown', true
						)
						this.exporterShutdownAttempt = attempt
						observeNativePromiseSettlement(attempt, () => undefined, () => {
							if (this.exporterShutdownAttempt === attempt) this.exporterShutdownAttempt = undefined
						})
					}
					await waitForExporterShutdown(this.exporterShutdownAttempt, this.timers)
					this.exporterClosed = true
				} catch(error) { pushNativeArray(failures, normalizeTracingError(error, 'Tracing exporter shutdown failed')) }
			}
			if (this.exporterClosed && this.batch.length > 0) {
				const droppedCount = this.batch.length
				spliceNativeArray(this.batch, 0)
				this.batchId = 0
				this.batchBytes = 0
				this.reportExportFailure(new Error('Tracing exporter closed before queued spans could drain'), droppedCount)
			}
			if (failures.length > 0) throw new AggregateError(failures, 'Tracing processor shutdown failed')
		})()
		this.shutdownPromise = pending
		try { await pending } catch(error) {
			if (this.shutdownPromise === pending) this.shutdownPromise = undefined
			throw error
		}
	}

	private flushBackground(): void {
		if (this.backgroundFlush) return
		const pending = this.flushInternal(false)
		this.backgroundFlush = pending
		const release = (): void => {
			if (this.backgroundFlush === pending) this.backgroundFlush = undefined
			// The completed barrier intentionally did not chase spans admitted while
			// its export was active. Schedule exactly one follow-up drain for that
			// bounded second-stage queue.
			if (!this.shutdownRequested && this.batch.length > 0) this.flushBackground()
		}
		if (!observeNativePromiseSettlement(pending, release, release)) release()
	}

	private async flushInternal(throwOnFailure: boolean): Promise<void> {
		const admissionBarrier = this.admissionId
		const pendingFailureAtRequest = this.pendingFailure
		let joinedExportFailure: unknown
		const exportActiveAtRequest = this.flushInFlight
		if (exportActiveAtRequest) {
			try { await exportActiveAtRequest } catch(error) { joinedExportFailure = error }
		}
		// Multiple callers can resume from the same completed export. The first
		// continuation may synchronously claim the queued batch before the others
		// run, leaving the queue empty but a *new* export in flight. That export is
		// part of every caller's barrier, so the other continuations must join it.
		const exportClaimedByAnotherFlush = this.flushInFlight
		if (exportClaimedByAnotherFlush && exportClaimedByAnotherFlush !== exportActiveAtRequest) {
			try { await exportClaimedByAnotherFlush } catch(error) { joinedExportFailure ??= error }
		}
		// A drain timeout may leave this continuation alive while shutdown moves
		// on to exporter cleanup. Never claim queued work after that fence.
		if (this.exporterFinalizing) return
		// A flush is a barrier for work queued when it was requested. Do not
		// recursively chase spans admitted while the export itself is running;
		// under continuous traffic that could make forceFlush() never settle.
		if (this.batch.length > 0 && !this.flushInFlight) {
			const pending = this.flushBatch()
			this.flushInFlight = pending
			const release = (): void => {
				if (this.flushInFlight === pending) this.flushInFlight = undefined
			}
			if (!observeNativePromiseSettlement(pending, release, release)) release()
			try { await pending } catch(error) { joinedExportFailure ??= error }
		}
		const failure = joinedExportFailure ?? pendingFailureAtRequest?.error
		if (throwOnFailure && failure !== undefined) {
			// Acknowledge only failures admitted inside this barrier. A newer failed
			// batch remains owned by the next flush even if this caller exported it.
			if (this.pendingFailure && this.pendingFailure.id <= admissionBarrier) {
				this.pendingFailure = undefined
			}
			throw normalizeTracingError(failure, joinedExportFailure !== undefined
				? 'Tracing batch export failed' : 'Tracing background export failed')
		}
	}

	private async flushBatch(): Promise<void> {
		this.clearFlushTimer()
		if (this.batch.length === 0) return
		const spans = spliceNativeArray(this.batch, 0)
		const batchAdmissionId = this.batchId || this.admissionId
		this.batchId = 0
		this.batchBytes = 0
		let result: SpanExportResultPort
		try {
			const rawResult = await invokeNativeAsync<unknown>(
				() => this.exporter.export(Object.freeze(spans)), 'Tracing exporter export'
			)
			result = snapshotSpanExportResult(rawResult, spans.length)
		} catch(error) {
			const safeError = normalizeTracingError(error, 'Tracing exporter threw an opaque value')
			this.reportExportFailure(safeError, spans.length)
			this.recordFailure(safeError, batchAdmissionId)
			throw safeError
		}
		if (result.acceptedCount > 0) {
			try { isolateUnexpectedThenable(this.telemetry?.onExported?.(result.acceptedCount)) } catch { /* observers are isolated */ }
		}
		if (result.status === 'success' && result.acceptedCount === spans.length) return
		const error = result.error ?? new Error(`Tracing export ${result.status}`)
		const droppedCount = nativeMathMax(0, spans.length - result.acceptedCount)
		this.reportExportFailure(error, droppedCount, result.status === 'partial')
		this.recordFailure(error, batchAdmissionId)
		throw error
	}

	private reportExportFailure(error: unknown, droppedCount: number, partial = false): void {
		try {
			if (partial) isolateUnexpectedThenable(this.telemetry?.onPartialDelivery?.(error))
			else isolateUnexpectedThenable(this.telemetry?.onExportFailure?.(error))
		} catch { /* observers are isolated */ }
		if (droppedCount > 0) {
			try { isolateUnexpectedThenable(this.telemetry?.onDropped?.(droppedCount, error, true)) } catch { /* observers are isolated */ }
		}
		createTracingOnError(this.errors, {stage: 'tracing'})(error, {operation: 'export', batchSize: droppedCount, reason: 'span-export-failure'})
		if (droppedCount > 0) reportSpanDropped(droppedCount, 'export-failure', this.metrics)
	}

	private reportQueueOverflow(admissionId: number): void {
		const error = new Error('Tracing batch queue capacity exceeded while an export is in flight')
		this.recordFailure(error, admissionId)
		try { isolateUnexpectedThenable(this.telemetry?.onDropped?.(1, error, true)) } catch { /* observers are isolated */ }
		createTracingOnError(this.errors, {stage: 'tracing'})(error, {
			operation: 'queue', reason: 'queue-overflow'
		})
		reportSpanDropped(1, 'queue-overflow', this.metrics)
	}

	private recordFailure(error: unknown, id: number): void {
		if (!this.pendingFailure || id >= this.pendingFailure.id) {
			this.pendingFailure = {error, id}
		}
	}
}
