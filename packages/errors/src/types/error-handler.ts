/**
 * @file Error handler port interface and options.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'

import type {ErrorSink} from '../sinks'

import type {EnrichedError} from './normalized-error'
import type {ObservabilityTap} from './observability'
import type {CachePort, LoggerPort, LifecyclePort, MetricsPort, TracerPort} from './ports'

/**
 * Classification registry mapping error names/types to categories
 */
export interface ErrorClassificationRegistry {
	readonly [category: string]: ReadonlyArray<string>
}

/**
 * Policy function type
 */
export interface ErrorHandlerOptions {
	readonly ports?: {
		readonly logger?: LoggerPort
		readonly metrics?: MetricsPort
		readonly tracer?: TracerPort
		readonly cache?: CachePort
		readonly lifecycle?: LifecyclePort | null
	}
	readonly sink?: ErrorSink
	readonly clock?: Clock
	readonly observe?: ObservabilityTap
	readonly rethrow?: boolean
	readonly deduplicate?: boolean
	readonly flushTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
	readonly reportTimeoutMs?: number
	readonly classificationRegistry?: ErrorClassificationRegistry
	readonly report?: (error: EnrichedError) => Promise<void>
	readonly defaultSource?: string
}

/**
 * Error handler port interface
 */
export interface ErrorHandlerPort {

	/**
	 * Handle an error: normalize, classify, observe, report, and optionally rethrow
	 * @param error - The error to handle (unknown type)
	 * @param context - Optional additional context
	 * @returns The normalized and enriched error
	 */
	handle(error: unknown, context?: Record<string, unknown>): Promise<EnrichedError>

	/**
	 * Normalize an error without classification or reporting
	 * @param error - The error to normalize
	 * @returns The normalized and enriched error
	 */
	normalize(error: unknown): EnrichedError

	/**
	 * Classify an already-normalized error
	 * @param error - The normalized error to classify
	 * @returns The classified error
	 */
	classify(error: EnrichedError): EnrichedError
}

export interface ErrorsHandlerPort extends ErrorHandlerPort {
	flush(): Promise<void>
	shutdown(): Promise<void>
}
