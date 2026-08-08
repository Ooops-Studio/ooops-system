/**
 * @file Runtime context contract for cross-service context propagation.
 * Services can enrich using this without coupling to AsyncLocalStorage specifics.
 */

/**
 * Runtime context fields for distributed tracing and multi-tenancy.
 * Used for correlation IDs, trace IDs, span IDs, tenant IDs, and user IDs.
 */
export interface RuntimeContext {
	/** Correlation ID for async tracing */
	correlationId?: string

	/** Trace ID from tracing service */
	traceId?: string

	/** Span ID from tracing service */
	spanId?: string

	/** Tenant ID for multi-tenancy */
	tenantId?: string

	/** User ID for user context */
	userId?: string
}
