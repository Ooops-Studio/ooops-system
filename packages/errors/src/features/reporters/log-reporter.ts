/**
 * @file Log reporter for error handling.
 * Port-based implementation - composition happens at application level.
 */

import type {JsonValue} from '@ooopsstudio/core/contracts/json'

import type {EnrichedError} from '../../types/normalized-error'
import type {LoggerPort} from '../../types/ports'
import {mapErrorSeverityToLogLevel} from '../../utils/map-severity-to-log-level'
import {redactEnrichedError} from '../../utils/redaction'

/**
 * Internal implementation of log reporting
 */
async function reportToLogImpl(error: EnrichedError, logger: LoggerPort): Promise<void> {
	// Logging pipeline failures are owned by the logging service and must not
	// be sent back through the same logger path, otherwise sink failures recurse.
	if (error.source === 'logging') {
		return
	}

	// Map severity to log level
	const level = mapErrorSeverityToLogLevel(error.severity)
	const report = logger[level]
	if (typeof report !== 'function') throw new Error('Errors logger method unavailable.')

	// Build log attributes (convert to JsonValue)
	const attributes: Record<string, JsonValue> = {
		kind: error.kind,
		category: error.category,
		code: error.code ?? null,
		...(error.id ? {id: error.id} : {}),
		...(error.correlationId ? {correlationId: error.correlationId} : {}),
		...(error.traceId ? {traceId: error.traceId} : {}),
		...(error.source ? {source: error.source} : {}),
		reportedBy: 'errors',
		errorPipeline: true,
		...(error.context ? {context: error.context as JsonValue} : {}),
		...(error.stack ? {stack: error.stack} : {})
	}

	// Log based on severity using port directly
	await report(error.message, attributes)
}

/**
 * Report an error to the logger using port-based composition
 * @param error - The error to report
 * @param logger - Optional logger port
 * @returns Promise that resolves when reporting is complete
 */
export async function reportToLog(error: EnrichedError, logger?: LoggerPort): Promise<void> {
	if (!logger) return
	await reportToLogImpl(redactEnrichedError(error), logger)
}
