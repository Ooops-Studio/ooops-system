/**
 * @file Enriching factory wrapper with standardized error handling.
 * Reduces duplication of try/catch error handling patterns across preset factories.
 */

import type {LogRecord} from '@ooopsstudio/core/contracts/logging'

import type {Enriching, EnrichingOptions} from '../types/enriching'

import {createStageOnError} from './on-error'

/**
 * Options for creating an enriching function with error handling
 */
export interface EnrichingWithErrorHandlingOptions {
	/** Stage name for error reporting (e.g., 'enriching') */
	readonly stage: string
	/** Step name for error reporting (e.g., 'custom', 'production', 'development') */
	readonly step: string
}

/**
 * Create an enriching function wrapper with standardized error handling.
 * Wraps an async enriching function with try/catch that reports errors via
 * createStageOnError() and returns the original record on failure.
 * @param enrichingFn - The enriching function to wrap
 * @param options - Error handling options
 * @returns Enriching function with error boundary
 *
 * @example
 * ```ts
 * const enriching = createEnrichingWithErrorHandling(
 *   async(record, options) => {
 *     // ... enriching logic ...
 *     return enrichedRecord
 *   },
 *   { stage: 'enriching', step: 'custom' }
 * )
 * ```
 */
export function createEnrichingWithErrorHandling(
	enrichingFn: (
		record: Readonly<LogRecord>,
		options?: EnrichingOptions
	) => Promise<LogRecord> | LogRecord,
	options: EnrichingWithErrorHandlingOptions
): Enriching {
	return async(
		record: Readonly<LogRecord>,
		enrichingOptions?: EnrichingOptions
	): Promise<LogRecord> => {
		try {
			return await enrichingFn(record, enrichingOptions)
		} catch(error) {
			const onError = createStageOnError(enrichingOptions?.errors, {
				stage: options.stage,
				step: options.step
			})
			onError(error)
			return record
		}
	}
}
