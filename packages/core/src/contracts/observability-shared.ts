/**
 * @file Stable cross-runtime observability contracts.
 * These contracts are intentionally provider-agnostic and are shared across
 * logging, tracing, metrics, and profiling.
 */

import type {LogAttributes} from './logging'

/**
 * Shared resource metadata for logs, metrics, traces, and profiles.
 */
export interface ObservabilityResource {
	readonly serviceName: string
	readonly serviceVersion?: string
	readonly deploymentEnvironment?: string
	readonly hostKind?: string
	readonly runtime?: string
	readonly attributes?: LogAttributes
}

/**
 * Minimal trace correlation fields used across sibling services.
 */
export interface TraceCorrelationFields {
	readonly traceId?: string
	readonly spanId?: string
}

/**
 * Exemplar metadata for trace-correlated metrics.
 */
export interface MetricsExemplarMetadata extends TraceCorrelationFields {
	readonly tenantId?: string
	readonly userId?: string
}
