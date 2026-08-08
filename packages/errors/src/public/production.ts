import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createErrorHandler} from '../core/create-error-handler'
import type {ErrorSink} from '../sinks'
import type {ErrorHandlerOptions, ErrorsHandlerPort} from '../types/error-handler'
import type {ObservabilityTap} from '../types/observability'
import {PRODUCTION_ERROR_OPTION_KEYS, snapshotErrorHandlerOptions} from '../utils/options'

/** Fixed production behavior with one optional external error destination. */
export interface ProductionErrorHandlerOptions {
	readonly clock?: Clock
	readonly ports?: ErrorHandlerOptions['ports']
	readonly sink?: ErrorSink
	readonly classificationRegistry?: ErrorHandlerOptions['classificationRegistry']
	readonly observe?: ObservabilityTap
	readonly defaultSource?: string
}

export async function createProductionErrorHandler(
	options: ProductionErrorHandlerOptions = {}
): Promise<ErrorsHandlerPort> {
	const safeOptions = snapshotErrorHandlerOptions(options as ErrorHandlerOptions, PRODUCTION_ERROR_OPTION_KEYS)
	const clock = safeOptions.clock ?? createSystemClock()
	return createErrorHandler({
		// Preserve malformed explicit values for the shared boundary validator.
		clock: Object.hasOwn(safeOptions, 'clock') ? safeOptions.clock! : clock,
		...(safeOptions.ports ? {ports: safeOptions.ports} : {}),
		rethrow: false,
		deduplicate: true,
		// `undefined` means "not configured" just like an omitted optional field.
		// Preserve other malformed explicit values for the kernel validator.
		defaultSource: safeOptions.defaultSource === undefined
			? 'production'
			: safeOptions.defaultSource,
		...(Object.hasOwn(safeOptions, 'sink') ? {sink: safeOptions.sink!} : {}),
		...(Object.hasOwn(safeOptions, 'classificationRegistry')
			? {classificationRegistry: safeOptions.classificationRegistry!}
			: {}),
		...(Object.hasOwn(safeOptions, 'observe') ? {observe: safeOptions.observe!} : {})
	})
}
