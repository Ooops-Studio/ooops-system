/**
 * @file Basic normalization factory.
 * Composes normalization features into a single normalization function.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'

import {normalizeError} from '../features/normalization/normalize-error'
import type {EnrichedError} from '../types/normalized-error'
import type {TracerPort} from '../types/ports'
import {captureErrorCapability} from '../utils/capabilities'

/**
 * Options for creating a normalization function
 */
export interface NormalizeOptions {
	readonly clock: Clock
	readonly defaultSource?: string
	readonly generateId?: boolean
	readonly tracer?: TracerPort
	/** Internal-only escape hatch; public normalization remains redacted. */
	readonly redact?: boolean
}

/**
 * Normalization function type
 */
export type Normalize = (error: unknown, context?: Record<string, unknown>) => EnrichedError

/**
 * Create a normalization function
 * @param options - Normalization options
 * @returns Normalization function
 */
export function createNormalize(options: NormalizeOptions): Normalize {
	const tracer = options.tracer
	const currentTraceId = captureErrorCapability(tracer, 'currentTraceId') as TracerPort['currentTraceId']
	const stableTracer = tracer && currentTraceId
		? {currentTraceId: () => currentTraceId.call(tracer)}
		: undefined
	return (error: unknown, context?: Record<string, unknown>): EnrichedError => {
		return normalizeError(error, {
			clock: options.clock,
			...(options.defaultSource ? {defaultSource: options.defaultSource} : {}),
			generateId: options.generateId ?? true,
			...(stableTracer ? {tracer: stableTracer} : {}),
			redact: options.redact ?? true
		}, context)
	}
}
