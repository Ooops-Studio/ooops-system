import type {LogRecord} from '@ooopsstudio/core/contracts/logging'

import type {Formatting, FormattingOptions} from '../../types/formatting'
import {createStageOnError} from '../../utils/on-error'

import {normalizeFormattingTags, normalizeFormattingValue, stableStringifyFormattingValue} from './safe-value'

function safeRecordValue(record: Readonly<LogRecord>, key: 'level' | 'message' | 'time'): unknown {
	try {
		return record[key]
	} catch {
		return '[unavailable]'
	}
}

function createFormattingErrorLine(record: Readonly<LogRecord>): string {
	try {
		return stableStringifyFormattingValue({
			time: safeRecordValue(record, 'time'),
			level: safeRecordValue(record, 'level'),
			message: '[formatting-error]',
			originalMessage: safeRecordValue(record, 'message')
		})
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return '{"level":"[unavailable]","message":"[formatting-error]","originalMessage":"[unavailable]","time":0}'
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

/** Build a stable JSON payload with fixed top-level order. */
function buildStablePayload(record: Readonly<LogRecord>): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		time: record.time,
		level: record.level,
		message: record.message
	}

	const ctx = record.context
	if (ctx?.namespace) payload.namespace = ctx.namespace
	const tags = normalizeFormattingTags(ctx?.tags)
	if (tags && tags.length > 0) payload.tags = tags
	if (ctx?.attributes) {
		payload.attributes = normalizeFormattingValue(ctx.attributes)
	}

	// If your LogRecord may carry a normalized error, include it last
	// (comment out if your public record never has error)
	if ((record as {error?: unknown}).error !== undefined) {
		payload.error = normalizeFormattingValue((record as {error?: unknown}).error)
	}

	// Sort the full payload again to ensure deterministic top-level order
	return normalizeFormattingValue(payload) as Record<string, unknown>
}

export const formatJson: Formatting = (record, options: Readonly<FormattingOptions>): string => {
	try {
		// `mode` is ignored here (the dispatcher decides); we accept the same signature for symmetry
		const payload = buildStablePayload(record)
		return JSON.stringify(payload)
	} catch(error) {
		const onError = createStageOnError(options.errors, {stage: 'formatting', step: 'formatJson'})
		onError(error)
		return createFormattingErrorLine(record)
	}
}
