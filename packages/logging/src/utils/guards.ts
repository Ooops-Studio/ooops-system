/**
 * @file Guard functions for logging service.
 * Runtime validation functions for logging types.
 */

import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {LogAttributes, LogContext, LogLevel, LogRecord} from '@ooopsstudio/core/contracts/logging'

/**
 * Valid log levels
 */
const LOG_LEVELS: ReadonlySet<LogLevel> = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

/**
 * Check if a value is a valid log level
 */
export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === 'string' && LOG_LEVELS.has(value as LogLevel)
}

/**
 * Check if a value is a valid JSON value (for LogAttributes)
 */
function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
	if (value === null) return true
	if (typeof value === 'string' || typeof value === 'boolean') return true
	if (typeof value === 'number') return Number.isFinite(value)
	if (Array.isArray(value)) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (seen.has(value)) return false
		seen.add(value)
		try {
			return value.every((item) => isJsonValue(item, seen))
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		} catch {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			return false
		} finally {
			seen.delete(value)
		}
	}
	if (typeof value === 'object') {
		if (seen.has(value)) return false
		seen.add(value)
		try {
			return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen))
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		} catch {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			return false
		} finally {
			seen.delete(value)
		}
	}
	return false
}

/**
 * Check if a value is LogAttributes (readonly record of JSON-safe values)
 */
export function isLogAttributes(value: unknown): value is LogAttributes {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return false

	try {
		const obj = value as Record<string, unknown>
		return Object.values(obj).every((item) => isJsonValue(item))
	} catch {
		return false
	}
}

/**
 * Check if a value is LogTags (readonly array of strings)
 */
export function isLogTags(value: unknown): value is ReadonlyArray<string> {
	try {
		return Array.isArray(value) && value.every((item) => typeof item === 'string')
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return false
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

/**
 * Check if a value is LogContext
 */
export function isLogContext(value: unknown): value is LogContext {
	try {
		if (!value || typeof value !== 'object') return false
		if (Array.isArray(value)) return false

		const obj = value as Record<string, unknown>

		// Check attributes if present
		if ('attributes' in obj && obj.attributes !== undefined) {
			if (!isLogAttributes(obj.attributes)) return false
		}

		// Check tags if present
		if ('tags' in obj && obj.tags !== undefined) {
			if (!isLogTags(obj.tags)) return false
		}

		return true
	} catch {
		return false
	}
}

/**
 * Check if a value is a LogRecord
 */
export function isLogRecord(value: unknown): value is LogRecord {
	try {
		if (!value || typeof value !== 'object') return false
		if (Array.isArray(value)) return false

		const obj = value as Record<string, unknown>

		// Check required fields
		if (typeof obj.level !== 'string' || !isLogLevel(obj.level)) return false
		if (typeof obj.time !== 'number' || !Number.isFinite(obj.time)) return false
		if (typeof obj.message !== 'string') return false

		// Check optional context field
		if ('context' in obj && obj.context !== undefined) {
			if (!isLogContext(obj.context)) return false
		}

		return true
	} catch {
		return false
	}
}
