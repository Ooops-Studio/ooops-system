/**
 * @file Metric record types and interfaces.
 * Base unit for metric data with optional exemplar/correlation metadata.
 */

import type {MetricInstrumentKind, MetricTemporality} from './instruments'

/**
 * Metric type enumeration
 */
export type MetricType = 'counter' | 'gauge' | 'histogram'

/**
 * Exemplar metadata for trace correlation
 */
export interface Exemplar {
	/** Trace ID from tracing service */
	traceId?: string

	/** Span ID from tracing service */
	spanId?: string

	/** Tenant ID for multi-tenancy (optional) */
	tenantId?: string

	/** User ID for user context (optional) */
	userId?: string

	/** Exemplar value */
	value: number

	/** Exemplar timestamp */
	timestamp: number
}

/**
 * Metric metadata (description and unit)
 */
export interface MetricMetadata {
	/** Human-readable description of the metric */
	description?: string

	/** Unit of measurement (e.g., 'bytes', 'seconds', 'requests') */
	unit?: string

	/** Service-level instrument kind */
	instrument?: MetricInstrumentKind

	/** Export temporality */
	temporality?: MetricTemporality

	/** Whether the metric is monotonic when represented as a sum/counter */
	monotonic?: boolean
}

/**
 * Base metric record unit
 */
export interface MetricRecord {
	/** Metric name */
	name: string

	/** Metric type */
	type: MetricType

	/** Metric value (counter: count, gauge: current value, histogram: bucket index) */
	value: number

	/** Labels/tags for filtering/grouping */
	labels: Record<string, string>

	/** Timestamp in milliseconds since epoch */
	timestamp: number

	/** Start of the aggregation window in milliseconds since epoch. */
	startTimestamp?: number

	/** Optional exemplar for trace correlation */
	exemplar?: Exemplar

	/** Optional metadata (description and unit) */
	metadata?: MetricMetadata
}
