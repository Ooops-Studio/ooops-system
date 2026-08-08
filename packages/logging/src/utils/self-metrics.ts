/**
 * @file Self-metrics reporting utilities for logging service.
 * Reports logging service health and performance metrics to metrics service.
 */

import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {getMetricsPort, safeIncrement, safeRecord} from '@ooopsstudio/core/utils/self-metrics'

import {
	LOG_SELF_DROPPED_TOTAL,
	LOG_SELF_FINALIZATION_FAILURES_TOTAL,
	LOG_SELF_QUEUE_SIZE,
	LOG_SELF_RETRIED_TOTAL,
	LOG_SELF_SINK_FAILURES_TOTAL,
	LOG_SELF_WRITTEN_TOTAL
} from '../constants'

/**
 * Report that a log was written successfully
 */
export function reportLogWritten(metrics?: MetricsPort, tags?: Record<string, string>): void {

	const port = getMetricsPort(metrics)
	safeIncrement(port, LOG_SELF_WRITTEN_TOTAL, tags)
}

/**
 * Report that a log was dropped
 */
export function reportLogDropped(
	metrics: MetricsPort | undefined,
	reason: string,
	tags?: Record<string, string>
): void {

	const port = getMetricsPort(metrics)
	safeIncrement(port, LOG_SELF_DROPPED_TOTAL, {...tags, reason})
}

/**
 * Report that a log was retried
 */
export function reportLogRetried(metrics?: MetricsPort, tags?: Record<string, string>): void {

	const port = getMetricsPort(metrics)
	safeIncrement(port, LOG_SELF_RETRIED_TOTAL, tags)
}

/**
 * Report queue size (gauge)
 */
export function reportQueueSize(
	size: number,
	metrics?: MetricsPort,
	tags?: Record<string, string>
): void {

	const port = getMetricsPort(metrics)
	safeRecord(port, LOG_SELF_QUEUE_SIZE, size, tags)
}

/**
 * Report stage failure
 */
export function reportStageFailure(
	metrics: MetricsPort | undefined,
	stage: string,
	tags?: Record<string, string>
): void {

	const port = getMetricsPort(metrics)
	if (!port) return

	switch (stage) {
		case 'sink':
			safeIncrement(port, LOG_SELF_SINK_FAILURES_TOTAL, tags)
			break
		case 'flush':
		case 'shutdown':
			safeIncrement(port, LOG_SELF_FINALIZATION_FAILURES_TOTAL, {...tags, operation: stage})
			break
		default:
			// Unknown stage - don't report
			break
	}
}
