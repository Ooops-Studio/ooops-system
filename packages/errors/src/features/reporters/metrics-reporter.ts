/**
 * @file Metrics reporter for error handling.
 */

import type {EnrichedError} from '../../types/normalized-error'
import type {MetricsPort} from '../../types/ports'
import {redactEnrichedError} from '../../utils/redaction'

/**
 * Internal implementation of metrics reporting
 */
async function reportToMetricsImpl(error: EnrichedError, metrics: MetricsPort): Promise<void> {
	// A failure originating in the metrics service must not be sent back through
	// that same MetricsPort. Doing so can recursively report every failed metric
	// write until the process exhausts its async queue.
	if (error.source === 'metrics') return
	const increment = metrics.increment
	if (typeof increment !== 'function') return

	// Increment error counter
	const tags: Readonly<Record<string, string>> = Object.freeze({
		severity: error.severity,
		category: error.category
	})
	await increment('errors_total', tags)
}

/**
 * Report an error to metrics
 * @param error - The error to report
 * @param metrics - Optional metrics port
 * @returns Promise that resolves when reporting is complete
 */
export async function reportToMetrics(error: EnrichedError, metrics?: MetricsPort): Promise<void> {
	if (!metrics) return
	await reportToMetricsImpl(redactEnrichedError(error), metrics)
}
