/**
 * @file Exporter manager implementation.
 * Orchestrates multiple exporters with retry and health tracking.
 */

import type {MetricExporterPort} from '../types/exporter'
import type {MetricRecord} from '../types/metric-record'
import {snapshotMetricBatch} from '../utils/metric-record-snapshot'

import {ExporterManagerDelivery} from './exporter-manager-delivery'
import type {ExporterRuntimeState, MetricsExportError} from './exporter-manager-state'
import {
	cloneMetricBatch,
	extractFailedRecords,
	metricRecordIdentity,
	toExportError,
	isOperationTimeoutError,
	toMetricsExportError
} from './exporter-manager-utils'

export type {RetryConfig, ExporterCircuitBreakerConfig, ExporterManagerOptions} from './exporter-manager-state'

interface PendingDelivery {
	readonly batch: ReadonlyArray<MetricRecord>
	readonly identities: readonly string[]
	readonly chunks: ReadonlyArray<ReadonlyArray<MetricRecord>>
	readonly completedChunks: Map<MetricExporterPort, number>
	readonly remainingChunks: Map<MetricExporterPort, Map<number, ReadonlyArray<MetricRecord>>>
}

interface ActiveRetainedDelivery {
	readonly delivery: PendingDelivery
	readonly promise: Promise<void>
}

export class ExporterManager extends ExporterManagerDelivery {
	private pendingDelivery: PendingDelivery | undefined
	private activeRetainedDelivery: ActiveRetainedDelivery | undefined

	async export(batch: ReadonlyArray<MetricRecord>): Promise<void> {
		const stableBatch = snapshotMetricBatch(batch)
		if (stableBatch.length === 0) {
			return
		}
		if (this.runtimeState !== 'running') {
			const error = new Error(`Metrics exporter manager is ${this.runtimeState} and cannot accept exports`)
			this.logger.warn('metrics.exporter_manager_not_accepting_exports', {
				operation: 'export',
				state: this.runtimeState
			})
			throw error
		}
		return this.trackOperation(this.exportAcceptedBatch(stableBatch))
	}

	private async exportAcceptedBatch(stableBatch: ReadonlyArray<MetricRecord>): Promise<void> {
		// Let export() publish operation ownership before custom callbacks run.
		await 0
		const identities = stableBatch.map(metricRecordIdentity)
		const activeRetainedDelivery = this.activeRetainedDelivery
		if (activeRetainedDelivery
			&& this.identitiesMatch(identities, activeRetainedDelivery.delivery.identities)) {
			return activeRetainedDelivery.promise
		}
		const retainedDelivery = this.pendingDelivery
		const resumesRetainedDelivery = retainedDelivery !== undefined
			&& this.identitiesMatch(identities, retainedDelivery.identities)
		if (retainedDelivery && resumesRetainedDelivery) {
			this.pendingDelivery = undefined
			const promise = (async() => {
				try {
					await this.drainDelivery(retainedDelivery)
				} catch(error) {
					this.retainFailedDelivery(retainedDelivery, error)
					throw error
				}
			})()
			const active = {delivery: retainedDelivery, promise}
			this.activeRetainedDelivery = active
			try {
				await promise
			} finally {
				if (this.activeRetainedDelivery === active) this.activeRetainedDelivery = undefined
			}
			return
		}
		const delivery: PendingDelivery = {
			batch: stableBatch,
			identities: Object.freeze(identities),
			chunks: this.splitBatch(stableBatch),
			completedChunks: new Map(this.exporters.map((exporter) => [exporter, 0])),
			remainingChunks: new Map(this.exporters.map((exporter) => [exporter, new Map()]))
		}
		try {
			await this.drainDelivery(delivery)
		} catch(error) {
			this.retainFailedDelivery(delivery, error)
			throw error
		}
	}

	private identitiesMatch(left: readonly string[], right: readonly string[]): boolean {
		return left.length === right.length
			&& left.every((identity, index) => identity === right[index])
	}

	private retainFailedDelivery(delivery: PendingDelivery, error: unknown): void {
		// Retain at most one bounded delivery. A concurrent caller still receives
		// its own rejection and can retry its batch without growing manager state.
		const code = toMetricsExportError(error, 'Metric export failed', 'export_failed').code
		// Queue overflow is an explicit bounded drop; retaining it would silently
		// bypass the queue limit on a later call.
		if (code !== 'export_queue_overflow') this.pendingDelivery ??= delivery
	}

	private async drainDelivery(pending: PendingDelivery): Promise<void> {
		for (let chunkIndex = 0; chunkIndex < pending.chunks.length; chunkIndex += 1) {
			const chunk = pending.chunks[chunkIndex]
			if (!chunk) continue
			const tasks = this.exporters
				.filter((exporter) => (pending.completedChunks.get(exporter) ?? 0) <= chunkIndex)
				.map((exporter) => {
					const attemptedBatch = pending.remainingChunks.get(exporter)?.get(chunkIndex) ?? chunk
					return {
						exporter,
						attemptedBatch,
						promise: this.trackOperation((async() => {
							await this.executeWithConcurrencyLimit(exporter, cloneMetricBatch(attemptedBatch))
						})())
					}
				})
			const results = await Promise.allSettled(tasks.map((task) => task.promise))
			const failures: Array<{exporter: MetricExporterPort; error: MetricsExportError}> = []
			for (let index = 0; index < results.length; index++) {
				const result = results[index]
				const exporter = tasks[index]?.exporter
				if (!exporter) {
					continue
				}
				if (result?.status === 'fulfilled') {
					pending.remainingChunks.get(exporter)?.delete(chunkIndex)
					pending.completedChunks.set(exporter, chunkIndex + 1)
					continue
				}
				if (result?.status === 'rejected') {
					let remaining = tasks[index]?.attemptedBatch ?? chunk
					try {
						remaining = extractFailedRecords(result.reason, remaining)
					} catch(contractError) {
						this.onError(contractError, {
							exporter: 'custom',
							operation: 'export-retention-contract'
						})
					}
					pending.remainingChunks.get(exporter)?.set(chunkIndex, remaining)
					failures.push({
						exporter,
						error: toMetricsExportError(result.reason, 'Metric export failed', 'export_failed')
					})
				}
			}
			if (failures.length > 0) {
				throw toExportError(failures[0]?.error, 'Metric export failed')
			}
		}
	}

	private async drainForFlush(options: {
		readonly finalizeExporters?: boolean
	} = {}): Promise<void> {
		const {finalizeExporters = true} = options
		await this.waitForActiveOperations()
		if (finalizeExporters) {
			await this.finalizeExporters('flush')
			await this.waitForActiveOperations()
		}
	}

	async flush(options: {
		readonly finalizeExporters?: boolean
	} = {}): Promise<void> {
		if (this.flushPromise) {
			return this.withOperationTimeout(this.flushPromise, 'flush')
		}
		if (this.shutdownPromise) {
			// Shutdown owns the complete flush/finalization sequence. Starting a
			// second flush here can race exporter.flush() with exporter.shutdown()
			// and can duplicate a transport's final delivery.
			return this.withOperationTimeout(this.shutdownPromise, 'flush')
		}
		if (this.runtimeState === 'closed') {
			this.logger.warn('metrics.exporter_manager_already_shut_down', {operation: 'flush'})
			return
		}
		const previousState = this.runtimeState
		this.runtimeState = 'draining'
		const activeFlush = (async() => {
			await this.drainForFlush(options)
		})()
		this.flushPromise = activeFlush
		void activeFlush.finally(() => {
			if (this.flushPromise === activeFlush) {
				this.flushPromise = undefined
				if (!this.shutdownPromise) {
					this.runtimeState = previousState === 'draining'
						? previousState
						: 'running'
				}
			}
		}).catch(() => undefined)
		await this.withOperationTimeout(activeFlush, 'flush')
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) {
			return this.withOperationTimeout(this.shutdownPromise, 'shutdown')
		}
		if (this.runtimeState === 'closed') {
			this.logger.warn('metrics.exporter_manager_already_shut_down', {operation: 'shutdown'})
			return
		}
		const generation = ++this.shutdownGeneration
		let completed = false
		let timedOut = false
		this.runtimeState = 'draining'
		this.shutdownPromise = (async() => {
			if (this.flushPromise) {
				await this.flushPromise
			} else {
				await this.drainForFlush()
			}
			await this.finalizeExporters('shutdown')
			if (generation === this.shutdownGeneration) {
				this.pendingDelivery = undefined
				this.releaseExporterReferences()
				this.runtimeState = 'closed'
			}
		})()
		const activeShutdown = this.shutdownPromise
		void activeShutdown.finally(() => {
			if (this.shutdownPromise === activeShutdown) {
				this.shutdownPromise = undefined
			}
		}).catch(() => undefined)
		void activeShutdown.catch(() => {
			if (generation === this.shutdownGeneration && this.runtimeState !== 'closed') {
				this.runtimeState = 'draining'
			}
		})
		try {
			await this.withOperationTimeout(activeShutdown, 'shutdown')
			completed = true
		} catch(error) {
			if (isOperationTimeoutError(error, 'shutdown')) {
				timedOut = true
				this.retainTimedOutShutdownFence()
			} else if (this.shutdownPromise === activeShutdown) {
				this.shutdownPromise = undefined
			}
			throw error
		} finally {
			if (completed && this.shutdownPromise === activeShutdown) {
				this.shutdownPromise = undefined
			}
			if (!completed && !timedOut && generation === this.shutdownGeneration) {
				this.runtimeState = 'draining'
			}
		}
	}

	retainTimedOutShutdownFence(): void {
		const pendingShutdown = this.shutdownPromise
		if (!pendingShutdown || this.runtimeState === 'closed') {
			return
		}
		// The timeout does not revoke the pending shutdown's ownership. Reopening
		// exports here would race exporter.shutdown() and could deliver into a
		// transport that is being closed.
		this.runtimeState = 'draining'
	}

	getTelemetry(): Readonly<{
		state: ExporterRuntimeState
		activeExports: number
		queueSize: number
		sinkState: 'healthy' | 'degraded' | 'unhealthy' | 'closed'
		lastFailureCode?: string
	}> {
		const states = this.exporters.map((exporter) => this.getState(exporter))
		const sinkState = this.runtimeState === 'closed'
			? 'closed'
			: states.some((state) => state.circuitState === 'open')
				? 'unhealthy'
				: states.some((state) => state.circuitState === 'half_open'
					|| state.throttledUntilMonotonic !== undefined)
					? 'degraded'
					: states.some((state) => state.lastFailureCode !== undefined)
						? 'unhealthy'
						: 'healthy'
		const lastFailureCode = states.find((state) => state.lastFailureCode)?.lastFailureCode
		return Object.freeze({
			state: this.runtimeState,
			activeExports: this.activeOperations.size,
			queueSize: this.pendingDelivery?.batch.length ?? this.getQueuedRecordCount(),
			sinkState,
			...(lastFailureCode ? {lastFailureCode} : {})
		})
	}

}
