/**
 * @file Logger utilities for metrics service.
 * Provides no-op logger fallback to avoid null checks throughout the codebase.
 */

import type {Logging} from '@ooopsstudio/core/ports/logging'

/**
 * No-op logger implementation.
 * Used as fallback when logger is not provided to avoid null checks.
 * All methods are no-ops that do nothing.
 */
export const noopLogger: Logging = {
	level: 'trace',
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	fatal: () => {},
	context: () => noopLogger
}

const LOG_METHODS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'context'] as const
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

function dataProperty(value: unknown, key: PropertyKey): unknown {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	let cursor: object | null = value as object
	const visited = new Set<object>()
	try {
		while (cursor && !visited.has(cursor) && visited.size < 32) {
			visited.add(cursor)
			const descriptor = Object.getOwnPropertyDescriptor(cursor, key)
			if (descriptor) return 'value' in descriptor ? descriptor.value : undefined
			cursor = Object.getPrototypeOf(cursor)
		}
	} catch {
		return undefined
	}
	return undefined
}

function snapshotLogger(logger: Logging): Logging | undefined {
	const configuredLevel = dataProperty(logger, 'level')
	// Metrics never performs threshold decisions. An accessor-backed dynamic
	// level is therefore left unread and represented conservatively.
	const level = typeof configuredLevel === 'string' && LOG_LEVELS.has(configuredLevel)
		? configuredLevel : 'trace'
	const methods = Object.fromEntries(LOG_METHODS.map((key) => [key, dataProperty(logger, key)]))
	if (LOG_METHODS.some((key) => typeof methods[key] !== 'function')) return undefined
	const invoke = (key: Exclude<typeof LOG_METHODS[number], 'context'>, ...args: unknown[]): void => {
		try { Reflect.apply(methods[key] as (...values: unknown[]) => unknown, logger, args) } catch {
			// Logging is an observer and must never replace a metrics outcome.
		}
	}
	const stable: Logging = {
		level: level as Logging['level'],
		trace: (message, attributes) => invoke('trace', message, attributes),
		debug: (message, attributes) => invoke('debug', message, attributes),
		info: (message, attributes) => invoke('info', message, attributes),
		warn: (message, attributes) => invoke('warn', message, attributes),
		error: (message, attributes) => invoke('error', message, attributes),
		fatal: (message, attributes) => invoke('fatal', message, attributes),
		context: (bindings) => {
			try {
				const derived = Reflect.apply(
					methods.context as (...values: unknown[]) => unknown, logger, [bindings]
				)
				return isSafeLogger(derived as Logging) ? getLogger(derived as Logging) : noopLogger
			} catch { return noopLogger }
		}
	}
	return Object.freeze(stable)
}

/**
 * Get logger with fallback to no-op.
 * Use this pattern throughout the metrics service to avoid null checks.
 *
 * @param logger - Optional logger port
 * @returns Logger or no-op logger if not provided
 */
export function getLogger(logger?: Logging): Logging {
	if (!logger || logger === noopLogger) return noopLogger
	return snapshotLogger(logger) ?? noopLogger
}

/**
 * Guard against recursive metrics logging.
 * Never use metrics port from within metrics service to prevent recursion.
 * This function checks if the logger is safe to use (not a metrics logger).
 *
 * @param logger - Logger to check
 * @returns true if logger is safe to use, false if it might cause recursion
 */
export function isSafeLogger(logger?: Logging): boolean {
	if (!logger) {
		return false
	}
	// Check for internal marker that indicates this logger is from metrics service
	// This prevents recursive logging if metrics service creates its own logger
	return dataProperty(logger, '__isMetricsLogger') !== true && snapshotLogger(logger) !== undefined
}
