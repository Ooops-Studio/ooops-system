import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'

import type {Formatting, FormattingOptions} from '../../types/formatting'
import {formatTimestamp} from '../../utils/formatting'
import {createStageOnError} from '../../utils/on-error'

import {normalizeFormattingTags, normalizeFormattingValue, stableStringifyFormattingValue} from './safe-value'

const isTty = (): boolean => typeof process !== 'undefined' && !!process.stdout && !!process.stdout.isTTY
const wrap = (code: number) => (s: string): string => isTty() ? `\u001b[${code}m${s}\u001b[0m` : s
const dim = wrap(2), bold = wrap(1), red = wrap(31),
	yellow = wrap(33), cyan = wrap(36), magenta = wrap(35), gray = wrap(90), blue = wrap(34)
const UNSERIALIZABLE = '[Unserializable]'
const MAX_INLINE_TEXT_LENGTH = 16_384
const MAX_ATTRIBUTE_ENTRIES = 1_000
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu')
const ASCII_CONTROL = new RegExp(String.raw`[\u0000-\u001f]`, 'gu')
const UNSAFE_UNICODE_TEXT = /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu

function safeStructuredText(value: string): string {
	return value.replace(ANSI_ESCAPE, '').replace(UNSAFE_UNICODE_TEXT, '�')
}

function safeInlineText(value: unknown): string {
	let text: string
	try {
		if (value !== null && (typeof value === 'object' || typeof value === 'function')) return UNSERIALIZABLE
		text = String(value)
	} catch { return UNSERIALIZABLE }
	if (text.length > MAX_INLINE_TEXT_LENGTH) {
		text = `${text.slice(0, MAX_INLINE_TEXT_LENGTH)}[Truncated]`
	}
	text = text
		.replace(ANSI_ESCAPE, '')
		.replace(/\r/gu, '\\r')
		.replace(/\n/gu, '\\n')
		.replace(/\t/gu, '\\t')
	// C1, Unicode line separators, and bidi controls can forge visual log lines
	// or reverse trusted prefixes even though they are not ASCII control bytes.
	return text.replace(ASCII_CONTROL, '�').replace(UNSAFE_UNICODE_TEXT, '�')
}

function colorFor(level: string) {
	switch (level) {
		case 'fatal':
		case 'error': return red
		case 'warn' : return yellow
		case 'info' : return cyan
		case 'debug': return magenta
		case 'trace': return gray
		default     : return (s: string) => s
	}
}

function safeKeys(attrs: LogAttributes): {keys: ReadonlyArray<string>; truncated: boolean} | undefined {
	try {
		const keys = Object.keys(attrs).sort()
		return {
			keys: keys.slice(0, MAX_ATTRIBUTE_ENTRIES),
			truncated: keys.length > MAX_ATTRIBUTE_ENTRIES
		}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return undefined
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

function safeRead(attrs: LogAttributes, key: string): unknown {
	try {
		return (attrs as Record<string, unknown>)[key]
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return UNSERIALIZABLE
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

function attrsInline(attrs: LogAttributes | undefined): string {
	if (!attrs) return ''
	const result = safeKeys(attrs)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!result) return ` attributes=${JSON.stringify(UNSERIALIZABLE)}`
	const parts: string[] = []
	for (const k of result.keys) {
		const v = normalizeFormattingValue(safeRead(attrs, k))
		let s: string
		if (v == null) s = 'null'
		else if (typeof v === 'string') s = JSON.stringify(v)
		else if (typeof v === 'number' || typeof v === 'boolean') s = String(v)
		else s = safeStructuredText(stableStringifyFormattingValue(v))
		parts.push(`${safeInlineText(k)}=${s}`)
	}
	if (result.truncated) parts.push('__truncated__="[MaxEntries]"')
	return parts.length ? ' ' + parts.join(' ') : ''
}

function attrsMultiline(attrs: LogAttributes | undefined): string {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!attrs) return ''
	const result = safeKeys(attrs)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!result) return `\n  attributes: ${UNSERIALIZABLE}`
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (result.keys.length === 0) return ''
	const lines = result.keys.map((k) => {
		const v = normalizeFormattingValue(safeRead(attrs, k))
		const rendered = typeof v === 'string'
			? safeInlineText(v)
			: (typeof v === 'number' || typeof v === 'boolean')
				? String(v)
				: safeStructuredText(stableStringifyFormattingValue(v, 2))
		return `  ${safeInlineText(k)}: ${rendered}`
	})
	if (result.truncated) lines.push('  __truncated__: [MaxEntries]')
	return '\n' + lines.join('\n')
}

/** Heuristic: long inline tail → switch to multiline (TTY only). */
function shouldMultiline(attrs: LogAttributes | undefined): boolean {
	if (!isTty() || !attrs) return false
	const rough = stableStringifyFormattingValue(attrs)
	return rough.length > 120
}

function safeRecordString(record: object, key: 'level' | 'message'): string {
	try {
		const value = (record as Record<string, unknown>)[key]
		return typeof value === 'string' ? value : '[unavailable]'
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return '[unavailable]'
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

function safeRecordTime(record: object): number {
	try {
		const value = Number((record as Record<string, unknown>).time)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return Number.isFinite(value) ? value : 0
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return 0
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

export const formatPretty: Formatting = (record, options: Readonly<FormattingOptions>): string => {
	try {
		const ts = dim(
			formatTimestamp(record.time, 'pretty', options.timestampFormat ?? 'iso')
		)
		const level = colorFor(record.level)(record.level.toUpperCase())
		const ns    = record.context?.namespace ? ' ' + blue(safeInlineText(record.context.namespace)) : ''
		const normalizedTags = normalizeFormattingTags(record.context?.tags)
		const tags  = normalizedTags && normalizedTags.length > 0
			? ' ' + dim('[' + normalizedTags.map(safeInlineText).join(',') + ']')
			: ''
		const msg   = ' ' + bold(safeInlineText(record.message))

		const attrs = record.context?.attributes
		const tail = shouldMultiline(attrs) ? attrsMultiline(attrs) : attrsInline(attrs)

		return `${ts} ${level}${ns}${tags}${msg}${tail}`
	} catch(error) {
		const onError = createStageOnError(options.errors, {stage: 'formatting', step: 'formatPretty'})
		onError(error)
		return `${formatTimestamp(safeRecordTime(record), 'pretty', 'iso')} ${safeInlineText(safeRecordString(record, 'level')).toUpperCase()} [formatting-error] ${safeInlineText(safeRecordString(record, 'message'))}`
	}
}
