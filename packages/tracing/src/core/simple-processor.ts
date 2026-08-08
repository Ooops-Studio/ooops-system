import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import {mapNativePromise, observeNativePromiseSettlement} from '@ooopsstudio/core/runtime/async/native-promise'
import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {
	addNativeSet,
	deleteNativeSet,
	getNativeWeakMap,
	pushNativeArray,
	setNativeWeakMap,
	sizeNativeSet,
	snapshotNativeSet
} from '@ooopsstudio/core/runtime/collections/native-collections'

import type {SpanExporterPort, SpanProcessorPort} from '../types/ports'

import type {DeliveryObservableExporter, ProcessorObserver} from './processor-types'
import {
	captureDeliveryObserverSetter,
	captureProcessorObserver,
	captureSpanExporter,
	captureTimerOwnership,
	invokeNativeAsync,
	normalizeTracingError,
	snapshotSpanRecord,
	snapshotSpanExportResult,
	waitForExporterShutdown,
	waitForProcessorDrain
} from './processor-utils'
import type {TimerOwnership} from './processor-utils'
import {deepFreezeSpanRecord} from './span-recorder-safety'

export class SimpleProcessor implements SpanProcessorPort {
	private readonly exporter: SpanExporterPort
	private readonly setDeliveryObserver?: DeliveryObservableExporter['setDeliveryObserver']
	private telemetry?: ProcessorObserver
	private readonly activeExports = new Set<Promise<void>>()
	private readonly exportOutcomes = new WeakMap<Promise<void>, {failure?: unknown}>()
	private pendingFailure: {error: unknown; id: number} | undefined
	private admissionId = 0
	private shutdownRequested = false
	private shutdownPromise: Promise<void> | undefined
	private exporterClosed = false
	private exporterFinalizationStarted = false
	private exporterShutdownAttempt: Promise<void> | undefined
	private readonly maxActiveExports: number
	private readonly timers: TimerOwnership

	constructor(exporter: SpanExporterPort, telemetry?: ProcessorObserver, maxActiveExports = 1_024) {
		if (!Number.isSafeInteger(maxActiveExports) || maxActiveExports < 1 || maxActiveExports > 100_000) {
			throw new Error('Tracing direct processor maxActiveExports must be between 1 and 100000')
		}
		const setDeliveryObserver = captureDeliveryObserverSetter(exporter)
		this.exporter = captureSpanExporter(exporter)
		if (setDeliveryObserver) this.setDeliveryObserver = setDeliveryObserver
		this.maxActiveExports = maxActiveExports
		this.timers = captureTimerOwnership()
		if (telemetry) {
			this.telemetry = captureProcessorObserver(telemetry)
			this.setDeliveryObserver?.(this.telemetry)
		}
	}

	setObserver(observer: ProcessorObserver): void {
		this.telemetry = captureProcessorObserver(observer)
		this.setDeliveryObserver?.(this.telemetry)
	}

	onEnd(span: SpanRecord): void {
		if (this.shutdownRequested) {
			const error = new Error('Tracing span ended after processor shutdown admission closed')
			try { isolateUnexpectedThenable(this.telemetry?.onDropped?.(1, error)) } catch { /* observers are isolated */ }
			return
		}
		const admissionId = ++this.admissionId
		if (sizeNativeSet(this.activeExports) >= this.maxActiveExports) {
			const error = new Error('Tracing direct export capacity exceeded')
			this.recordFailure(error, admissionId)
			try { isolateUnexpectedThenable(this.telemetry?.onExportFailure?.(error)) } catch { /* observers are isolated */ }
			try { isolateUnexpectedThenable(this.telemetry?.onDropped?.(1, error)) } catch { /* observers are isolated */ }
			return
		}
		const snapshot = snapshotSpanRecord(span)
		if (!snapshot) {
			const error = new Error('Tracing direct processor rejected an unsafe span record')
			this.recordFailure(error, admissionId)
			try { isolateUnexpectedThenable(this.telemetry?.onExportFailure?.(error)) } catch { /* observers are isolated */ }
			try { isolateUnexpectedThenable(this.telemetry?.onDropped?.(1, error)) } catch { /* observers are isolated */ }
			return
		}
		const safeSpan = deepFreezeSpanRecord(snapshot)
		const outcome: {failure?: unknown} = {}
		const physicalExport = invokeNativeAsync<unknown>(
			() => this.exporter.export(Object.freeze([safeSpan])), 'Tracing exporter export'
		)
		const recordExportFailure = (error: unknown): void => {
			const safeError = normalizeTracingError(error, 'Tracing exporter threw an opaque value')
			outcome.failure = safeError
			this.recordFailure(safeError, admissionId)
			try { isolateUnexpectedThenable(this.telemetry?.onExportFailure?.(safeError)) } catch { /* observers are isolated */ }
			try { isolateUnexpectedThenable(this.telemetry?.onDropped?.(1, safeError)) } catch { /* observers are isolated */ }
		}
		const exportPromise = mapNativePromise(physicalExport, (rawResult) => {
			let result
			try { result = snapshotSpanExportResult(rawResult, 1) }
			catch(error) { recordExportFailure(error); return }
			if (result.acceptedCount > 0) {
				try { isolateUnexpectedThenable(this.telemetry?.onExported?.(result.acceptedCount)) } catch { /* observers are isolated */ }
			}
			if (result.acceptedCount < 1) {
				try { isolateUnexpectedThenable(this.telemetry?.onDropped?.(1, result.error)) } catch { /* observers are isolated */ }
			}
			if (result.status !== 'success' || result.acceptedCount !== 1) {
				const error = result.error ?? new Error(`Tracing export ${result.status}`)
				outcome.failure = error
				this.recordFailure(error, admissionId)
				try {
					if (result.status === 'partial') isolateUnexpectedThenable(this.telemetry?.onPartialDelivery?.(error))
					else isolateUnexpectedThenable(this.telemetry?.onExportFailure?.(error))
				} catch { /* observers are isolated */ }
			}
		}, (error) => { recordExportFailure(error) })
		setNativeWeakMap(this.exportOutcomes, exportPromise, outcome)
		this.trackExport(exportPromise)
	}

	async flush(): Promise<void> {
		try { await waitForProcessorDrain(this.flushInternal(), this.timers) } catch(error) {
			throw normalizeTracingError(error, 'Tracing direct processor flush failed')
		}
	}

	private async flushInternal(): Promise<void> {
		// Every caller captures an independent fixed barrier. Sharing a flush
		// promise would let a later caller miss exports admitted after the first
		// caller's snapshot.
		const admissionBarrier = this.admissionId
		const pendingFailureAtRequest = this.pendingFailure
		const barrier = snapshotNativeSet(this.activeExports)
		for (let index = 0; index < barrier.length; index++) {
			const operation = barrier[index]!
			try { await operation } catch { /* settlement is the barrier */ }
		}
		// Preserve the processor's established last-failure reporting semantics
		// when more than one operation in the same barrier fails.
		let barrierFailure: unknown
		for (let index = 0; index < barrier.length; index++) {
			const operation = barrier[index]!
			const failure = getNativeWeakMap(this.exportOutcomes, operation)?.failure
			if (failure !== undefined) barrierFailure = failure
		}
		const failure = barrierFailure ?? pendingFailureAtRequest?.error
		if (failure !== undefined) {
			// Acknowledge only failures owned by admissions inside this barrier.
			// A newer span failure remains visible to the next flush.
			if (this.pendingFailure && this.pendingFailure.id <= admissionBarrier) this.pendingFailure = undefined
			throw normalizeTracingError(failure, 'Tracing direct export failed')
		}
		if (!this.exporterFinalizationStarted && this.exporter.flush) {
			await invokeNativeAsync<void>(() => this.exporter.flush!(), 'Tracing exporter flush', true)
		}
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		this.shutdownRequested = true
		// Do not let a configured retry delay hold host shutdown open. Existing
		// logical exports finish their current attempt and skip further backoff.
		try { isolateUnexpectedThenable(this.exporter.prepareShutdown?.()) } catch { /* drain interruption is advisory */ }
		const pending = (async() => {
			const failures: unknown[] = []
			if (!this.exporterClosed) {
				try { await this.flush() } catch(error) { pushNativeArray(failures, error) }
			}
			// Cleanup is mandatory even after delivery failed; otherwise a stalled
			// physical export can retain sockets and block every shutdown retry.
			if (!this.exporterClosed) {
				try {
					this.exporterFinalizationStarted = true
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
			if (failures.length > 0) throw new AggregateError(failures, 'Tracing processor shutdown failed')
		})()
		this.shutdownPromise = pending
		try { await pending } catch(error) {
			if (this.shutdownPromise === pending) this.shutdownPromise = undefined
			throw error
		}
	}

	private trackExport(exportPromise: Promise<void>): void {
		addNativeSet(this.activeExports, exportPromise)
		observeNativePromiseSettlement(
			exportPromise,
			() => deleteNativeSet(this.activeExports, exportPromise),
			() => deleteNativeSet(this.activeExports, exportPromise)
		)
	}

	private recordFailure(error: unknown, id: number): void {
		if (!this.pendingFailure || id >= this.pendingFailure.id) {
			this.pendingFailure = {error, id}
		}
	}
}
