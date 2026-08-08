import type {LogRecord} from '@ooopsstudio/core/contracts/logging'

import {stableStringifyFormattingValue} from '../features/formatting/safe-value'
import type {Formatting, FormattingOptions} from '../types/formatting'
import {inspectLoggingProperty} from '../utils/capabilities'
import {createStageOnError} from '../utils/on-error'

function safeRecordString(record: Readonly<LogRecord>, key: 'level' | 'message'): string {
	const inspected = inspectLoggingProperty<unknown>(record, key)
	return inspected.safe && typeof inspected.value === 'string' ? inspected.value : '[unavailable]'
}

function safeRecordTime(record: Readonly<LogRecord>): number {
	const inspected = inspectLoggingProperty<unknown>(record, 'time')
	return inspected.safe && typeof inspected.value === 'number' && Number.isFinite(inspected.value)
		? inspected.value : 0
}

function createFallbackLine(record: Readonly<LogRecord>): string {
	const context = inspectLoggingProperty<unknown>(record, 'context')
	const originalMessage = safeRecordString(record, 'message')
	const messageUnavailable = originalMessage === '[unavailable]'
	return stableStringifyFormattingValue({
		level: safeRecordString(record, 'level'),
		message: messageUnavailable ? '[formatting-error]' : originalMessage,
		...(messageUnavailable ? {originalMessage} : {}),
		timestamp: safeRecordTime(record),
		...(context.safe && context.value !== undefined ? {context: context.value} : {}),
		error: 'Formatting failed'
	})
}

/**
 * Creates a formatting function that uses the provided formatter.
 * This allows presets to import only the formatters they need.
 */
export function createFormatting(
	formatter: (record: Readonly<LogRecord>, options: Readonly<FormattingOptions>) => string
): Formatting {
	return (record: Readonly<LogRecord>, options: Readonly<FormattingOptions>) => {
		try {
			return formatter(record, options)
		} catch(error) {
			const onError = createStageOnError(options.errors, {stage: 'formatting', step: 'createFormatting'})
			onError(error)
			return createFallbackLine(record)
		}
	}
}
