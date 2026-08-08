import type {LogAttributes, LogContext, LogLevel} from '@ooopsstudio/core/contracts/logging'

import type {LoggingStatus, ManagedLogging, MutableLevelLogging} from '../types/handler'
import {mergeContext, snapshotLogContext} from '../utils/enriching'
import {isLogLevel} from '../utils/guards'

interface BindingOptions {
	readonly controlState: {level: LogLevel}
	readonly mutableLevel: boolean
	readonly log: (context: LogContext | undefined, level: LogLevel, message: string, attributes?: LogAttributes) => Promise<void>
	readonly getStatus: () => LoggingStatus
	readonly flush: () => Promise<void>
	readonly shutdown: () => Promise<void>
}

export function createLoggerBinding(
	options: Readonly<BindingOptions>,
	context?: LogContext
): ManagedLogging | MutableLevelLogging {
	const {controlState, mutableLevel, log, getStatus, flush, shutdown} = options
	const initialContext = snapshotLogContext(context)
	const bind = (boundContext?: LogContext): ManagedLogging | MutableLevelLogging => {
		const managed: ManagedLogging = {
			get level() { return controlState.level },
			trace: (message, attributes) => { void log(boundContext, 'trace', message, attributes) },
			debug: (message, attributes) => { void log(boundContext, 'debug', message, attributes) },
			info: (message, attributes) => { void log(boundContext, 'info', message, attributes) },
			warn: (message, attributes) => { void log(boundContext, 'warn', message, attributes) },
			error: (message, attributes) => { void log(boundContext, 'error', message, attributes) },
			fatal: (message, attributes) => { void log(boundContext, 'fatal', message, attributes) },
			context: (bindings) => bind(mergeContext(boundContext, snapshotLogContext(bindings) ?? {})) as ManagedLogging,
			getStatus,
			flush,
			shutdown
		}
		if (!mutableLevel) return managed
		return Object.assign(managed, {
			setLevel(nextLevel: LogLevel): void {
				if (!isLogLevel(nextLevel)) throw new TypeError('Logging level must be a valid log level')
				controlState.level = nextLevel
			},
			context: (bindings: Partial<LogContext>) => bind(
				mergeContext(boundContext, snapshotLogContext(bindings) ?? {})
			) as MutableLevelLogging
		}) as MutableLevelLogging
	}
	return bind(initialContext)
}
