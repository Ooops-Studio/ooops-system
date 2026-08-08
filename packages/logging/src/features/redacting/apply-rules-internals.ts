import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'
import {createStableHasher} from '@ooopsstudio/core/utils/hashing/stable-hash'

import {stableStringifyFormattingValue} from '../formatting/safe-value'

export const DEFAULT_DEPTH = 6
export const DEFAULT_BYTES = 100_000
export const DEFAULT_ARRAY_LENGTH = 1000
export const DEFAULT_OBJECT_ENTRIES = 1000
export const MASK_SYMBOL = '***'

export const sizeof = (value: unknown): number => {
	if (value == null) return 0
	switch (typeof value) {
		case 'string': return byteSize(value)
		case 'number': return 8
		case 'boolean': return 1
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		case 'object': return 2
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		default: return 0
	}
}

export const normalizeRedactionBudget = (value: number | undefined, fallback: number): number => {
	if (value === undefined || !Number.isFinite(value)) return fallback
	return Math.max(0, Math.floor(value))
}

export const truncateUtf8 = (value: string, maxBytes: number): string => {
	const normalizedMaxBytes = normalizeRedactionBudget(maxBytes, 0)
	if (byteSize(value) <= normalizedMaxBytes) return value
	let bytes = 0
	let truncated = ''
	for (const character of value) {
		const characterBytes = byteSize(character)
		if (bytes + characterBytes > normalizedMaxBytes) break
		truncated += character
		bytes += characterBytes
	}
	return truncated
}

export const normalizeKey = (key: string): string =>
	key.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '')

export const testPattern = (pattern: RegExp, value: string): boolean => {
	pattern.lastIndex = 0
	try {
		return pattern.test(value)
	} finally {
		pattern.lastIndex = 0
	}
}

export const isObjectLike = (value: unknown): value is Record<string, unknown> | unknown[] =>
	value !== null && typeof value === 'object'

const safeSerialize = (value: unknown): string => {
	const serialized = stableStringifyFormattingValue(value)
	if (serialized.includes('"[Unserializable]"')) {
		throw new TypeError('Logging redaction refused unsafe hash input')
	}
	return serialized
}

export const hashValueFailClosed = (value: unknown): string => {
	try {
		return createStableHasher().hash(safeSerialize(value))
	} catch {
		return MASK_SYMBOL
	}
}

export const maskAttributesFailClosed = (attrs: LogAttributes): LogAttributes => {
	try {
		const masked = Object.create(null) as Record<string, unknown>
		for (const [index] of Object.keys(attrs).entries()) masked[`__redacted_key_${index}__`] = MASK_SYMBOL
		return masked as LogAttributes
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return {redactionFailed: MASK_SYMBOL} as LogAttributes
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}
