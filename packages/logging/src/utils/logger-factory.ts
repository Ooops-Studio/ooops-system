/**
 * @file Logger factory utility.
 * Internal lightweight logger factory used by utility-level tests.
 * Production presets must use ../core/logger to preserve full handler semantics.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes, LogContext, LogLevel, LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import type {FormattingMode} from '../types/formatting'

import {readLoggingDataProperty} from './capabilities'
import {mergeContext} from './enriching'
import {sanitizeLoggingErrorDiagnostic} from './sanitize-diagnostic'

const LEVEL_RANK: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
	fatal: 5
}

function toNormalizedError(error: unknown): import('@ooopsstudio/core/contracts/errors').NormalizedError {
	const name = readLoggingDataProperty<unknown>(error, 'name')
	const stack = readLoggingDataProperty<unknown>(error, 'stack')
	return {
		kind: typeof name === 'string' && name ? name : 'Error',
		message: sanitizeLoggingErrorDiagnostic(error),
		...(typeof stack === 'string' ? {stack} : {})
	}
}

export function createLogger(
	enriching: (record: LogRecord, context?: LogContext) => Promise<LogRecord>,
	redacting: (record: LogRecord) => Promise<LogRecord>,
	formatting: (record: LogRecord, options?: {mode?: string}) => string,
	transferring: {
		write: (line: string) => void
		flush: () => Promise<void>
		close: () => Promise<void>
	},
	clock: Clock,
	level: string,
	formatMode?: string,
	baseContext?: LogContext,
	errors?: Errors,
	_selfMetrics?: boolean,
	_metrics?: MetricsPort,
	_lifecycle?: LifecyclePort
): Logging {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	const threshold = LEVEL_RANK[(level as LogLevel) ?? 'info'] ?? LEVEL_RANK.info

	const write = async(invocationLevel: LogLevel, message: string, attributes?: LogAttributes): Promise<void> => {
		const invocationRank = LEVEL_RANK[invocationLevel]
		if (invocationRank < threshold) {
			return
		}

		try {
			const context = baseContext || attributes ? mergeContext(baseContext, {
				...(attributes ? {attributes} : {})
			}) : undefined

			const enriched = await enriching({
				level: invocationLevel,
				message,
				time: clock.now(),
				...(context ? {context} : {})
			}, {})
			const redacted = await redacting(enriched)
			const line = formatting(redacted, {mode: (formatMode ?? 'json') as FormattingMode})
			transferring.write(line)
		} catch(error) {
			try {
				errors?.report?.(toNormalizedError(error), {stage: 'logger-factory'})
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			} catch {
				// logging utilities must stay silent on failures
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
		}
	}

	return {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		level: (level as LogLevel) ?? 'info',
		trace(message, attributes) {
			void write('trace', message, attributes)
		},
		debug(message, attributes) {
			void write('debug', message, attributes)
		},
		info(message, attributes) {
			void write('info', message, attributes)
		},
		warn(message, attributes) {
			void write('warn', message, attributes)
		},
		error(message, attributes) {
			void write('error', message, attributes)
		},
		fatal(message, attributes) {
			void write('fatal', message, attributes)
		},
		context(bindings) {
			return createLogger(
				enriching,
				redacting,
				formatting,
				transferring,
				clock,
				level,
				formatMode,
				mergeContext(baseContext, bindings),
				errors
			)
		}
	}
}
