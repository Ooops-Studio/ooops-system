/**
 * @file Metric exporter port interfaces.
 * Defines contracts for exporting metrics to various backends.
 */

import type {MetricRecord} from './metric-record'

export type MetricExportResult =
	| {
		readonly status: 'success'
		readonly failedRecords?: never
		readonly retryAfterMs?: never
	}
	| {
		readonly status: 'partial'
		/** A non-empty multiset subset of the exported batch. */
		readonly failedRecords: ReadonlyArray<MetricRecord>
		readonly retryAfterMs?: number
	}

export interface MetricExportErrorShape {
	readonly statusCode?: number
	readonly retryAfterMs?: number
	/** When supplied, must be a non-empty multiset subset of the exported batch. */
	readonly failedRecords?: ReadonlyArray<MetricRecord>
}

/**
 * Base metric exporter port interface
 */
export interface MetricExporterPort {

	/**
	 * Export a batch of metrics
	 * @param batch - Array of metric records to export
	 */
	export(batch: ReadonlyArray<MetricRecord>): Promise<void | MetricExportResult>

	/**
	 * Flush any pending exports
	 * Called periodically or on shutdown
	 */
	flush?(): Promise<void>

	/**
	 * Shutdown the exporter
	 * Performs cleanup and final flush
	 */
	shutdown?(): Promise<void>
}
