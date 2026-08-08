/**
 * @file Exporter manager implementation.
 * Orchestrates multiple exporters with retry and health tracking.
 */

import type {MetricExporterPort} from '../types/exporter'
import type {MetricRecord} from '../types/metric-record'
import {estimateBatchBytes, getExporterName} from '../utils/helpers'

import {ExporterManagerState, type ExportAttemptResult, type MetricsExportError} from './exporter-manager-state'
import {toMetricsExportError} from './exporter-manager-utils'
import {MetricsOperationTimeoutError} from './operation-timeout'

export abstract class ExporterManagerQueue extends ExporterManagerState {
	protected abstract markFailure(exporter: MetricExporterPort, error: unknown): void
	protected abstract exportOnce(
		exporter: MetricExporterPort,
		batch: ReadonlyArray<MetricRecord>
	): Promise<ExportAttemptResult>
	protected getQueuedOperationCount(): number {
		return this.queuedOperationCount
	}

	protected getQueuedOperationBytes(): number {
		return this.queuedOperationBytes
	}

	protected getQueuedRecordCount(): number {
		return this.queuedRecordCount
	}

	protected createQueueOverflowError(exporter: MetricExporterPort): MetricsExportError {
		return toMetricsExportError(
			Object.assign(new Error(`Metrics exporter concurrency queue overflow for ${getExporterName(exporter)}`), {
				code: 'export_queue_overflow',
				retryable: false
			}),
			`Metrics exporter concurrency queue overflow for ${getExporterName(exporter)}`,
			'export_queue_overflow'
		)
	}

	protected recordQueueOverflow(exporter: MetricExporterPort, error: MetricsExportError): void {
		this.markFailure(exporter, error)
		this.onError(error, {
			exporter: getExporterName(exporter),
			operation: 'export-queue',
			queue: 'concurrency',
			reason: error.code ?? 'export_queue_overflow'
		})
		this.notifyExportFailure(getExporterName(exporter), error)
		this.logger.warn('metrics.export_queue_overflow', {
			exporter: getExporterName(exporter),
			queue: 'concurrency',
			maxQueuedBatches: this.maxQueuedBatches,
			maxQueuedBytes: this.maxQueuedBytes
		})
	}

	protected notifyExportFailure(exporter: string, error: unknown): void {
		try {
			this.onExportFailure?.(exporter, error)
		} catch(observerError) {
			this.onError(observerError, {exporter, operation: 'export-failure-observer'})
		}
	}

	protected notifyRetry(exporter: string): void {
		try {
			this.onRetry?.(exporter)
		} catch(observerError) {
			this.onError(observerError, {exporter, operation: 'retry-observer'})
		}
	}

	protected async waitForActiveOperations(): Promise<void> {
		while (this.activeOperations.size > 0) {
			await Promise.allSettled([...this.activeOperations])
		}
	}

	protected async withOperationTimeout<T>(work: Promise<T>, operation: 'flush' | 'shutdown'): Promise<T> {
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		let output: T
		const timeoutPromise = new Promise<'timed_out'>((resolve) => {
			timeoutId = setTimeout(() => {
				resolve('timed_out')
			}, this.operationTimeoutMs)
			// Awaited flush/shutdown deadlines must keep the process alive.
		})
		try {
			const result = await Promise.race([
				work.then((value) => { output = value; return 'completed' as const }),
				timeoutPromise
			])
			if (result === 'timed_out') {
				const error = new MetricsOperationTimeoutError(
					`exporter-${operation}`,
					`Metrics exporter ${operation} timed out after ${this.operationTimeoutMs}ms`
				)
				this.onError(error, {
					operation: `exporter-${operation}-timeout`,
					timeoutMs: String(this.operationTimeoutMs)
				})
				this.logger.warn('metrics.exporter_manager_timeout', {
					operation,
					timeoutMs: this.operationTimeoutMs
				})
				void work.catch((lateError) => {
					this.onError(lateError, {operation: `exporter-${operation}-late`})
				})
				throw error
			}
			return output!
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId)
			}
		}
	}

	protected createFinalizationError(operation: 'flush' | 'shutdown', failures: ReadonlyArray<unknown>): Error {
		return new AggregateError(
			failures,
			`Metrics exporter ${operation} failed for ${failures.length} exporter${failures.length === 1 ? '' : 's'}`
		)
	}

	protected async finalizeExporters(operation: 'flush' | 'shutdown'): Promise<void> {
		const results = await Promise.allSettled(
			this.exporters.map(async(exporter) => {
				if (operation === 'flush') {
					// A shutdown retry may re-enter the flush phase after only some
					// exporters closed. Never call lifecycle methods on those completed
					// targets again; many transports correctly reject flush-after-close.
					if (this.shutdownCompleted.has(exporter)) return
					await exporter.flush?.()
					return
				}
				if (this.shutdownCompleted.has(exporter)) return
				await exporter.shutdown?.()
				this.shutdownCompleted.add(exporter)
			})
		)
		const failures: unknown[] = []
		for (let index = 0; index < results.length; index++) {
			const result = results[index]
			const exporter = this.exporters[index]
			if (!exporter || result?.status !== 'rejected') {
				continue
			}
			const exporterName = getExporterName(exporter)
			this.markFailure(exporter, result.reason)
			this.onError(result.reason, {
				exporter: exporterName,
				operation: `exporter-${operation}`
			})
			this.logger.error('metrics.exporter_finalization_failed', {
				exporter: exporterName,
				operation,
				error: `metrics_exporter_${operation}_failed`
			})
			this.notifyExportFailure(exporterName, result.reason)
			failures.push(result.reason)
		}
		if (failures.length > 0) {
			throw this.createFinalizationError(operation, failures)
		}
	}

	protected async executeWithConcurrencyLimit(
		exporter: MetricExporterPort,
		batch: ReadonlyArray<MetricRecord>,
		fromQueue = false
	): Promise<void> {

		if (fromQueue) {
			try {
				await this.exportOnce(exporter, batch)
			} finally {
				this.activeCounts.set(exporter, Math.max(0, (this.activeCounts.get(exporter) ?? 1) - 1))
				this.processQueue(exporter)
			}
			return
		}

		const currentCount = this.activeCounts.get(exporter) ?? 0
		if (currentCount < this.maxConcurrency) {
			this.activeCounts.set(exporter, currentCount + 1)
			try {
				await this.exportOnce(exporter, batch)
			} finally {
				this.activeCounts.set(exporter, Math.max(0, (this.activeCounts.get(exporter) ?? 1) - 1))
				this.processQueue(exporter)
			}
			return
		}

		const queuedBatchBytes = estimateBatchBytes(batch)
		if (
			this.getQueuedOperationCount() + 1 > this.maxQueuedBatches ||
				this.getQueuedOperationBytes() + queuedBatchBytes > this.maxQueuedBytes
		) {
			const error = this.createQueueOverflowError(exporter)
			this.recordQueueOverflow(exporter, error)
			throw error
		}

		return new Promise<void>((resolve, reject) => {
			const queue = this.concurrencyQueues.get(exporter) ?? []
			queue.push({
				bytes: queuedBatchBytes,
				records: batch.length,
				run: async() => {
					try {
						await this.executeWithConcurrencyLimit(exporter, batch, true)
						resolve()
					} catch(error) {
						reject(error)
					}
				}
			})
			this.concurrencyQueues.set(exporter, queue)
			this.queuedOperationCount += 1
			this.queuedOperationBytes += queuedBatchBytes
			this.queuedRecordCount += batch.length
		})
	}

	protected processQueue(exporter: MetricExporterPort): void {
		const queue = this.concurrencyQueues.get(exporter) ?? []
		while (queue.length > 0 && (this.activeCounts.get(exporter) ?? 0) < this.maxConcurrency) {
			const next = queue.shift()
			if (!next) {
				break
			}
			this.queuedOperationCount = Math.max(0, this.queuedOperationCount - 1)
			this.queuedOperationBytes = Math.max(0, this.queuedOperationBytes - next.bytes)
			this.queuedRecordCount = Math.max(0, this.queuedRecordCount - next.records)
			this.activeCounts.set(exporter, (this.activeCounts.get(exporter) ?? 0) + 1)
			void next.run()
		}
	}

}
