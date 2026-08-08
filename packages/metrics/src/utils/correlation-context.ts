/**
 * @file Correlation context extraction.
 * Extracts traceId, spanId, tenantId, userId from async context for exemplar attachment.
 */

import type {MetricsExemplarMetadata} from '@ooopsstudio/core/contracts/observability-shared'
import {getContext} from '@ooopsstudio/core/runtime/context'

import type {Exemplar} from '../types/metric-record'

/**
 * Correlation context extracted from async context
 */
export interface CorrelationContext extends MetricsExemplarMetadata {}

/**
 * Extract correlation context from async context
 * @returns Correlation context with traceId, spanId, tenantId, userId if available
 */
export function extractCorrelationContext(): CorrelationContext {

	const context = getContext()

	if (!context) {
		return {}
	}

	return {
		...(context.traceId ? {traceId: context.traceId} : {}),
		...(context.spanId ? {spanId: context.spanId} : {}),
		...(context.tenantId ? {tenantId: context.tenantId} : {}),
		...(context.userId ? {userId: context.userId} : {})
	}
}

/**
 * Create an exemplar from correlation context
 * @param value - Exemplar value
 * @param timestamp - Exemplar timestamp
 * @returns Exemplar with correlation metadata if available
 */
export function createExemplar(
	value: number,
	timestamp: number
): Exemplar | undefined {

	const context = extractCorrelationContext()
	const bounded = (field: unknown, maximum: number): string | undefined =>
		typeof field === 'string' && field.length > 0 && field.length <= maximum
			? field
			: undefined
	const traceId = bounded(context.traceId, 32)
	const spanId = bounded(context.spanId, 16)
	const tenantId = bounded(context.tenantId, 256)
	const userId = bounded(context.userId, 256)

	// Only create exemplar if we have at least traceId or spanId
	if (!traceId && !spanId) {
		return undefined
	}

	return {
		value,
		timestamp,
		...(traceId ? {traceId} : {}),
		...(spanId ? {spanId} : {}),
		...(tenantId ? {tenantId} : {}),
		...(userId ? {userId} : {})
	}
}
