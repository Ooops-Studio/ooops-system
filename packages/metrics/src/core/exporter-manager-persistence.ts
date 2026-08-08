/**
 * @file Exporter manager implementation.
 * Orchestrates multiple exporters with retry and health tracking.
 */

import {MAX_METRICS_TIMER_MS} from '../constants'
import type {MetricExporterPort, MetricExportResult} from '../types/exporter'
import type {MetricRecord} from '../types/metric-record'

import {ExporterManagerQueue} from './exporter-manager-queue'
import type {ExporterDeliveryState} from './exporter-manager-state'
import {extractRetryAfterMs, splitMetricBatch} from './exporter-manager-utils'

export abstract class ExporterManagerPersistence extends ExporterManagerQueue {
	private boundedDeadline(now: number, delayMs: number): number {
		return Math.min(Number.MAX_SAFE_INTEGER, now + Math.min(MAX_METRICS_TIMER_MS, Math.max(0, delayMs)))
	}

	protected abstract exportWithRetry(exporter: MetricExporterPort, batch: ReadonlyArray<MetricRecord>): Promise<void | MetricExportResult>
	protected splitBatch(batch: ReadonlyArray<MetricRecord>): ReadonlyArray<ReadonlyArray<MetricRecord>> {
		return splitMetricBatch(batch, this.maxBatchSize, this.maxBatchBytes)
	}

	protected getState(exporter: MetricExporterPort): ExporterDeliveryState {
		const state = this.exporterState.get(exporter)
		if (!state) {
			throw new Error('Exporter state missing')
		}
		return state
	}

	protected canExport(exporter: MetricExporterPort): boolean {
		const state = this.getState(exporter)
		const now = this.monotonicNow()

		if (state.throttledUntilMonotonic !== undefined && state.throttledUntilMonotonic > now) {
			return false
		}

		if (state.circuitState === 'open') {
			if (state.openUntilMonotonic !== undefined && state.openUntilMonotonic <= now) {
				state.circuitState = 'half_open'
				state.halfOpenProbeInFlight = true
				return true
			}
			return false
		}
		if (state.circuitState === 'half_open') {
			if (state.halfOpenProbeInFlight) return false
			state.halfOpenProbeInFlight = true
		}

		return true
	}

	protected markSuccess(exporter: MetricExporterPort): void {
		const state = this.getState(exporter)
		state.consecutiveFailures = 0
		delete state.lastFailureCode
		state.circuitState = 'closed'
		delete state.openUntil
		delete state.throttledUntil
		delete state.openUntilMonotonic
		delete state.throttledUntilMonotonic
		delete state.halfOpenProbeInFlight
	}

	protected markFailure(exporter: MetricExporterPort, error: unknown): void {
		const state = this.getState(exporter)
		state.consecutiveFailures++
		state.lastFailureCode = 'METRICS_EXPORT_FAILURE'
		delete state.halfOpenProbeInFlight
		const retryAfterMs = extractRetryAfterMs(error)
		if (retryAfterMs !== undefined) {
			state.throttledUntil = this.boundedDeadline(this.now(), retryAfterMs)
			state.throttledUntilMonotonic = this.boundedDeadline(this.monotonicNow(), retryAfterMs)
		}
		if (this.circuitBreaker !== false
			&& state.consecutiveFailures >= this.circuitBreaker.failureThreshold) {
			state.circuitState = 'open'
			state.openUntil = this.boundedDeadline(this.now(), this.circuitBreaker.openMs)
			state.openUntilMonotonic = this.boundedDeadline(this.monotonicNow(), this.circuitBreaker.openMs)
		}
	}

}
