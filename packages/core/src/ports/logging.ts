/**
 * @file Logging capability boundary (DI port).
 * Implementations decide formatting, sampling, routing, and buffering,
 * but MUST NOT throw on user paths.
 */

import type {LogLevel, LogAttributes, LogContext} from '../contracts/logging'

/** Signature used by level methods. */
export type LogMethod = (message: string, attributes?: LogAttributes) => void

export interface Logging {
	/** Current threshold; implementations may drop events below this level. */
	readonly level: LogLevel

	trace: LogMethod
	debug: LogMethod
	info: LogMethod
	warn: LogMethod
	error: LogMethod
	fatal: LogMethod

	/**
   * Returns a derived logger with extra bound context (namespace, tags, attributes).
   * Partial lets callers add a few keys without reconstructing all.
   */
	context(bindings: Partial<LogContext>): Logging
}