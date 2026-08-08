import {LOGGING_SHUTDOWN_TIMEOUT_MS} from '../constants'
import type {ManagedLogging, MutableLevelLogging} from '../types/handler'
import type {TransferringHandle} from '../types/transferring'

import {withTimeout} from './logger-helpers'

export async function cleanupLoggingConstructionFailure(
	error: unknown,
	cleanup: () => void | Promise<void>,
	message = 'Logging construction and cleanup failed'
): Promise<never> {
	try {
		await withTimeout(Promise.resolve().then(cleanup), LOGGING_SHUTDOWN_TIMEOUT_MS, 'construction cleanup')
	} catch(cleanupError) {
		throw new AggregateError([error, cleanupError], message)
	}
	throw error
}

export async function constructLoggerWithCleanup<T extends ManagedLogging | MutableLevelLogging>(
	create: () => T,
	transferring: TransferringHandle
): Promise<T> {
	try {
		return create()
	} catch(error) {
		return await cleanupLoggingConstructionFailure(
			error,
			async() => await transferring.close(),
			'Logging construction and transfer cleanup failed'
		)
	}
}
