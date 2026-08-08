/**
 * @file Basic classification factory.
 * Composes classification features into a single classification function.
 */

import {DEFAULT_ERROR_CATEGORIES} from '../constants'
import {classifyError, snapshotClassificationRegistry} from '../features/classification/classify-error'
import type {ErrorClassificationRegistry} from '../types/error-handler'
import type {EnrichedError} from '../types/normalized-error'

/**
 * Classification function type
 */
export type Classify = (error: EnrichedError) => EnrichedError

/**
 * Create a classification function
 * @param registry - Optional custom classification registry
 * @returns Classification function
 */
export function createClassify(registry?: ErrorClassificationRegistry): Classify {
	const stableRegistry = snapshotClassificationRegistry(registry ?? DEFAULT_ERROR_CATEGORIES)
	return (error: EnrichedError): EnrichedError => {
		return classifyError(error, stableRegistry)
	}
}
