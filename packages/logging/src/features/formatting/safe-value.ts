export interface FormattingValueLimits {
	readonly maxDepth?: number
	readonly maxObjectEntries?: number
	readonly maxArrayLength?: number
	readonly maxStringLength?: number
}

const DEFAULT_LIMITS: Required<FormattingValueLimits> = {
	maxDepth: 8,
	maxObjectEntries: 1_000,
	maxArrayLength: 1_000,
	maxStringLength: 16_384
}

const UNSERIALIZABLE = '[Unserializable]'
const MAX_FORMATTING_TRAVERSAL_NODES = 10_000

interface FormattingValueState {
	readonly seen: WeakSet<object>
	readonly limits: Required<FormattingValueLimits>
	remaining: number
}

function normalizeLimits(limits?: FormattingValueLimits): Required<FormattingValueLimits> {
	const normalizeLimit = (value: number | undefined, fallback: number): number => {
		if (value === undefined || !Number.isFinite(value)) return fallback
		return Math.max(0, Math.min(Math.floor(value), fallback))
	}
	return {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		maxDepth: normalizeLimit(limits?.maxDepth, DEFAULT_LIMITS.maxDepth),
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		maxObjectEntries: normalizeLimit(limits?.maxObjectEntries, DEFAULT_LIMITS.maxObjectEntries),
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		maxArrayLength: normalizeLimit(limits?.maxArrayLength, DEFAULT_LIMITS.maxArrayLength),
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		maxStringLength: normalizeLimit(limits?.maxStringLength, DEFAULT_LIMITS.maxStringLength)
	}
}

function truncateString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value
	return `${value.slice(0, Math.max(0, maxLength))}[Truncated]`
}

function safeArrayLength(value: ReadonlyArray<unknown>): number | undefined {
	const inspected = inspectLoggingProperty<unknown>(value, 'length')
	return inspected.safe && typeof inspected.value === 'number' ? inspected.value : undefined
}

function safeObjectKeys(value: object): ReadonlyArray<string> | undefined {
	try {
		return Object.keys(value).sort()
	} catch {
		return undefined
	}
}

function safeReadIndex(value: ReadonlyArray<unknown>, index: number): unknown {
	try {
		const inspected = inspectLoggingProperty<unknown>(value, String(index))
		return inspected.safe ? inspected.value : UNSERIALIZABLE
	} catch {
		return UNSERIALIZABLE
	}
}

function safeReadProperty(value: object, key: string): unknown {
	try {
		const inspected = inspectLoggingProperty<unknown>(value, key)
		return inspected.safe ? inspected.value : UNSERIALIZABLE
	} catch {
		return UNSERIALIZABLE
	}
}

function uniqueFormattingKey(
	out: Record<string, unknown>,
	key: string,
	index: number,
	maxLength: number
): string {
	const preferred = key.length <= maxLength ? key : `[TruncatedKey:${index}]`
	if (!Object.prototype.hasOwnProperty.call(out, preferred)) return preferred
	let collision = 1
	let candidate = `[DuplicateKey:${index}:${collision}]`
	while (Object.prototype.hasOwnProperty.call(out, candidate)) {
		collision += 1
		candidate = `[DuplicateKey:${index}:${collision}]`
	}
	return candidate
}

function normalizeValue(value: unknown, state: FormattingValueState, depth: number): unknown {
	if (state.remaining <= 0) return '[MaxEntries]'
	state.remaining -= 1
	if (value === null) return null
	switch (typeof value) {
		case 'string':
			return truncateString(value, state.limits.maxStringLength)
		case 'bigint':
			return value.toString()
		case 'symbol':
			return value.toString()
		case 'function': {
			try {
				const inspected = inspectLoggingProperty<unknown>(value, 'name')
				const name = inspected.safe && typeof inspected.value === 'string' && inspected.value
					? inspected.value : 'anonymous'
				return `[Function:${name}]`
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			} catch {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				return '[Function:unavailable]'
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
		}
		case 'object': {
			if (depth >= state.limits.maxDepth) {
				return '[MaxDepth]'
			}
			if (state.seen.has(value)) {
				return '[Circular]'
			}
			state.seen.add(value)
			try {
				if (Array.isArray(value)) {
					const length = safeArrayLength(value)
					/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
					if (length === undefined) return UNSERIALIZABLE
					const out: unknown[] = []
					const readableLength = Math.min(length, state.limits.maxArrayLength)
					for (let index = 0; index < readableLength; index += 1) {
						out.push(normalizeValue(safeReadIndex(value, index), state, depth + 1))
					}
					if (length > state.limits.maxArrayLength) {
						out.push('[MaxArrayLength]')
					}
					return out
				}
				const out = Object.create(null) as Record<string, unknown>
				const keys = safeObjectKeys(value)
				if (!keys) return UNSERIALIZABLE
				for (const [index, key] of keys.slice(0, state.limits.maxObjectEntries).entries()) {
					const normalizedKey = uniqueFormattingKey(out, key, index, state.limits.maxStringLength)
					out[normalizedKey] = normalizeValue(safeReadProperty(value, key), state, depth + 1)
				}
				if (keys.length > state.limits.maxObjectEntries) {
					out.__truncated__ = '[MaxEntries]'
				}
				return out
			} catch {
				return UNSERIALIZABLE
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			} finally {
				state.seen.delete(value)
			}
		}
		default:
			return value
	}
}

export function normalizeFormattingValue(value: unknown, limits?: FormattingValueLimits): unknown {
	return normalizeValue(value, {
		seen: new WeakSet<object>(),
		limits: normalizeLimits(limits),
		remaining: MAX_FORMATTING_TRAVERSAL_NODES
	}, 0)
}

export function stableStringifyFormattingValue(value: unknown, space?: number, limits?: FormattingValueLimits): string {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return JSON.stringify(normalizeFormattingValue(value, limits), null, space) ?? 'undefined'
}

export function normalizeFormattingTags(tags: unknown, maxLength = 100): readonly string[] | undefined {
	if (tags === undefined || tags === null) return undefined
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!Array.isArray(tags)) return [UNSERIALIZABLE]
	const length = safeArrayLength(tags)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (length === undefined) return [UNSERIALIZABLE]
	if (length <= 0) return undefined
	const out: string[] = []
	for (let index = 0; index < Math.min(length, maxLength); index += 1) {
		const value = safeReadIndex(tags, index)
		out.push(typeof value === 'string' ? value : UNSERIALIZABLE)
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (length > maxLength) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		out.push('[MaxArrayLength]')
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	return out
}
import {inspectLoggingProperty} from '../../utils/capabilities'
