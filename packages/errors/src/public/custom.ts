import {createErrorHandler} from '../core/create-error-handler'
import type {ErrorHandlerOptions, ErrorsHandlerPort} from '../types/error-handler'
import {CUSTOM_ERROR_OPTION_KEYS, snapshotErrorHandlerOptions} from '../utils/options'

/** Escape hatch for a custom reporter, classifier, sink, or delivery behavior. */
export type CustomErrorHandlerOptions = ErrorHandlerOptions

export const createCustomErrorHandler = async(
	options?: CustomErrorHandlerOptions
): Promise<ErrorsHandlerPort> => createErrorHandler(
	snapshotErrorHandlerOptions(options, CUSTOM_ERROR_OPTION_KEYS)
)
