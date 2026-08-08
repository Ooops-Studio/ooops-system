/**
 * @file Exporter manager implementation.
 * Orchestrates multiple exporters with retry and health tracking.
 */

import {JITTER_FACTOR} from '../constants'
import type {MetricExporterPort, MetricExportResult} from '../types/exporter'
import type {MetricRecord} from '../types/metric-record'
import {getExporterName, retryWithBackoff, type RetryConfig as RetryConfigUtil} from '../utils/helpers'

import {ExporterManagerPersistence} from './exporter-manager-persistence'
import type {ExportAttemptResult} from './exporter-manager-state'
import {cloneMetricBatch, isPartialExportResult, assertValidExportResult, extractFailedRecords, isTransientFailure, toMetricsExportError} from './exporter-manager-utils'

export class ExporterManagerDelivery extends ExporterManagerPersistence {
	protected async exportOnce(
		exporter: MetricExporterPort,
		batch: ReadonlyArray<MetricRecord>
	): Promise<ExportAttemptResult> {

		if (!this.canExport(exporter)) {
			const state = this.getState(exporter)
			const error = Object.assign(new Error(`Exporter unavailable for ${getExporterName(exporter)}`), {
				code: state.circuitState === 'open'
					? 'circuit_open'
					: state.circuitState === 'half_open' ? 'circuit_half_open' : 'throttled',
				...(state.throttledUntilMonotonic !== undefined
					? {retryAfterMs: Math.max(0, state.throttledUntilMonotonic - this.monotonicNow())}
					: {})
			})
			this.onError(error, {exporter: getExporterName(exporter), operation: 'export', reason: error.code})
			this.notifyExportFailure(getExporterName(exporter), error)
			throw error
		}

		try {
			const rawResult = this.retryConfig
				? await this.exportWithRetry(exporter, batch)
				: await exporter.export(batch)
			const result = assertValidExportResult(rawResult, batch)
			if (isPartialExportResult(result)) {
				const failed = result.failedRecords
				const partialFailure = {
					message: 'Partial metric export failure',
					failedRecords: failed,
					retryAfterMs: result.retryAfterMs
				}
				const partialError = Object.assign(
					new Error(`Partial metric export failure for ${getExporterName(exporter)}`),
					partialFailure
				)
				throw partialError
			}
			this.markSuccess(exporter)
			return {status: 'delivered'}
		} catch(error) {
			const exportError = toMetricsExportError(
				error,
				`Metric export failed for ${getExporterName(exporter)}`,
				'export_failed'
			)
			this.markFailure(exporter, exportError)
			try {
				extractFailedRecords(exportError, batch)
			} catch(contractError) {
				this.onError(contractError, {
					exporter: getExporterName(exporter),
					operation: 'export-contract'
				})
				this.logger.error('metrics.exporter_invalid_failed_records', {
					exporter: getExporterName(exporter),
					error: 'metrics_exporter_contract_failed'
				})
			}
			this.onError(exportError, {
				exporter: getExporterName(exporter),
				operation: 'export',
				retryable: String(exportError.retryable !== false),
				...(exportError.code ? {reason: exportError.code} : {})
			})
			this.notifyExportFailure(getExporterName(exporter), exportError)
			throw exportError
		}
	}

	protected async exportWithRetry(
		exporter: MetricExporterPort,
		batch: ReadonlyArray<MetricRecord>
	): Promise<void | MetricExportResult> {

		if (!this.retryConfig) {
			return exporter.export(batch)
		}

		const exporterName = getExporterName(exporter)
		const retryConfigUtil: RetryConfigUtil = {
			maxRetries: this.retryConfig.maxRetries,
			baseDelayMs: this.retryConfig.baseDelayMs,
			maxDelayMs: this.retryConfig.maxDelayMs,
			multiplier: this.retryConfig.multiplier,
			...(this.retryConfig.jitter !== undefined ? {jitter: this.retryConfig.jitter} : {}),
			jitterFactor: JITTER_FACTOR
		}

		let result: void | MetricExportResult | undefined
		let pendingBatch = cloneMetricBatch(batch)
		try {
			await retryWithBackoff({
				operation: async() => {
					// Export calls do not accept a cancellation signal. Timing out locally
					// and retrying while the original call is still alive can deliver the
					// same delta twice. The handler's flush deadline bounds the public wait
					// while this call retains delivery ownership until it actually settles.
					const rawResult = await exporter.export(cloneMetricBatch(pendingBatch))
					result = assertValidExportResult(rawResult, pendingBatch)
					if (isPartialExportResult(result)) {
						pendingBatch = cloneMetricBatch(result.failedRecords)
						throw Object.assign(
							new Error(`Partial metric export failure for ${exporterName}`),
							{
								failedRecords: pendingBatch,
								retryAfterMs: result.retryAfterMs,
								retryable: true,
								code: 'partial_export'
							}
						)
					}
					return result
				},
				config: retryConfigUtil,
				shouldRetry: (error) => isTransientFailure(error),
				onRetry: () => this.notifyRetry(exporterName),
				onError: (error, attempt, context) => {
					this.onError(error, {
						exporter: exporterName,
						operation: 'export-with-retry',
						attempt: String(attempt),
						...context
					})
				}
			})
		} catch(error) {
			const retainedError = toMetricsExportError(
				error,
				`Metric export failed for ${exporterName}`,
				'export_failed'
			) as ReturnType<typeof toMetricsExportError> & {
				failedRecords: ReadonlyArray<MetricRecord>
			}
			retainedError.failedRecords = cloneMetricBatch(pendingBatch)
			throw retainedError
		}

		return result
	}

}
