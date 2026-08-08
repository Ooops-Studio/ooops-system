import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createErrorHandler} from '../core/create-error-handler'
import type {ErrorHandlerOptions, ErrorsHandlerPort} from '../types/error-handler'
import {DEVELOPMENT_ERROR_OPTION_KEYS, snapshotErrorHandlerOptions} from '../utils/options'

/** Fixed local-development behavior: readable reporting and immediate rethrow. */
export interface DevelopmentErrorHandlerOptions {
	readonly clock?: Clock
	readonly ports?: ErrorHandlerOptions['ports']
}

export async function createDevelopmentErrorHandler(
	options: DevelopmentErrorHandlerOptions = {}
): Promise<ErrorsHandlerPort> {
	const safeOptions = snapshotErrorHandlerOptions(options as ErrorHandlerOptions, DEVELOPMENT_ERROR_OPTION_KEYS)
	const clock = safeOptions.clock ?? createSystemClock()
	return createErrorHandler({
		// Preserve an explicitly configured runtime value so the shared kernel can
		// reject malformed values such as `null`; nullish defaulting here used to
		// silently turn an invalid clock into the system clock.
		clock: Object.hasOwn(safeOptions, 'clock') ? safeOptions.clock! : clock,
		defaultSource: 'development',
		rethrow: true,
		...(safeOptions.ports ? {ports: safeOptions.ports} : {})
	})
}
