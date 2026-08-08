import type {LogAttributes, LogContext} from '@ooopsstudio/core/contracts/logging'

import type {MergeContextOptions} from '../types/enriching'

import {inspectLoggingProperty, isPlainLoggingObject, readLoggingDataProperty} from './capabilities'

const UNSERIALIZABLE = '[Unserializable]'
const MAX_CONTEXT_TAGS = 100
const MAX_CONTEXT_ATTRIBUTES = 1_000
const MAX_CONTEXT_DEPTH = 8
const MAX_CONTEXT_NODES = 2_000
const MAX_CONTEXT_CHARACTERS = 32_768
const MAX_CONTEXT_KEY_LENGTH = 256
const MAX_CONTEXT_TAG_LENGTH = 256
const MAX_CONTEXT_NAMESPACE_LENGTH = 1_024
const TRUNCATED = '[Truncated]'

interface ContextSnapshotState {
	remainingCharacters: number
	remainingNodes: number
	readonly seen: WeakSet<object>
}

function safeRead<T>(value: object | undefined, key: string): T | undefined {
	return readLoggingDataProperty<T>(value, key)
}

function snapshotContextString(value: string, state: ContextSnapshotState, maximum: number): string {
	const readable = Math.min(value.length, maximum, state.remainingCharacters)
	const result = value.slice(0, readable)
	state.remainingCharacters -= readable
	return readable < value.length ? `${result}${TRUNCATED}` : result
}

function snapshotContextValue(value: unknown, state: ContextSnapshotState, depth: number): unknown {
	if (state.remainingNodes <= 0) return TRUNCATED
	state.remainingNodes -= 1
	if (typeof value === 'string') return snapshotContextString(value, state, MAX_CONTEXT_CHARACTERS)
	if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value
	if (typeof value !== 'object') return UNSERIALIZABLE
	if (depth >= MAX_CONTEXT_DEPTH) return TRUNCATED
	if (state.seen.has(value)) return '[Circular]'
	state.seen.add(value)
	if (Array.isArray(value)) {
		const inspectedLength = inspectLoggingProperty<unknown>(value, 'length')
		if (!inspectedLength.safe || !Number.isSafeInteger(inspectedLength.value)
			|| (inspectedLength.value as number) < 0) return UNSERIALIZABLE
		const length = inspectedLength.value as number
		const out: unknown[] = []
		for (let index = 0; index < Math.min(length, MAX_CONTEXT_ATTRIBUTES); index += 1) {
			const inspected = inspectLoggingProperty<unknown>(value, String(index))
			out.push(inspected.safe
				? snapshotContextValue(inspected.value, state, depth + 1)
				: UNSERIALIZABLE)
		}
		if (length > MAX_CONTEXT_ATTRIBUTES) out.push(TRUNCATED)
		return out
	}
	if (!isPlainLoggingObject(value)) return UNSERIALIZABLE
	const out = Object.create(null) as Record<string, unknown>
	let index = 0
	try {
		for (const key in value) {
			if (index++ >= MAX_CONTEXT_ATTRIBUTES) break
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor) continue
			const safeKey = key.length <= MAX_CONTEXT_KEY_LENGTH ? key : `__truncated_key_${index}__`
			out[safeKey] = 'value' in descriptor
				? snapshotContextValue(descriptor.value, state, depth + 1) : UNSERIALIZABLE
		}
		if (index > MAX_CONTEXT_ATTRIBUTES) out.__truncated__ = TRUNCATED
	} catch { return UNSERIALIZABLE }
	return out
}

export function copyLogAttributes(attributes: LogAttributes | undefined): LogAttributes | undefined {
	if (!attributes) return undefined
	const snapshot = snapshotContextValue(attributes, {
		remainingCharacters: MAX_CONTEXT_CHARACTERS,
		remainingNodes: MAX_CONTEXT_NODES,
		seen: new WeakSet<object>()
	}, 0)
	return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
		? snapshot as LogAttributes
		: {unserializableAttributes: UNSERIALIZABLE}
}

export function copyLogTags(tags: readonly string[] | undefined): readonly string[] | undefined {
	if (!tags) return undefined
	const inspectedLength = inspectLoggingProperty<unknown>(tags, 'length')
	if (!inspectedLength.safe || typeof inspectedLength.value !== 'number') return [UNSERIALIZABLE]
	const length = inspectedLength.value
	const out: string[] = []
	for (let index = 0; index < Math.min(length, MAX_CONTEXT_TAGS); index += 1) {
		const inspected = inspectLoggingProperty<unknown>(tags, String(index))
		out.push(inspected.safe && typeof inspected.value === 'string'
			? inspected.value.length <= MAX_CONTEXT_TAG_LENGTH
				? inspected.value
				: `${inspected.value.slice(0, MAX_CONTEXT_TAG_LENGTH)}${TRUNCATED}`
			: UNSERIALIZABLE)
	}
	if (length > MAX_CONTEXT_TAGS) out.push(TRUNCATED)
	return out
}

function boundMergedTags(tags: readonly string[]): readonly string[] {
	return tags.length <= MAX_CONTEXT_TAGS ? tags : [...tags.slice(0, MAX_CONTEXT_TAGS), TRUNCATED]
}

export const mergeAttributes = (
	base: LogAttributes | undefined,
	patch: LogAttributes | undefined
): LogAttributes | undefined => {
	if (!patch) return copyLogAttributes(base)
	const nextPatch = copyLogAttributes(patch) as LogAttributes
	if (!base) return nextPatch
	const nextBase = copyLogAttributes(base) as LogAttributes
	return {...nextBase, ...nextPatch} as LogAttributes
}

export const mergeTags = (
	base: readonly string[] | undefined,
	patch: readonly string[] | undefined, dedupe = true
): readonly string[] | undefined => {
	if (!patch) return copyLogTags(base)
	const nextPatch = copyLogTags(patch) as readonly string[]
	if (!nextPatch.length) return base
	const nextBase = copyLogTags(base)
	if (!nextBase?.length) return nextPatch
	if (!dedupe) return boundMergedTags([...nextBase, ...nextPatch])
	const set = new Set<string>([...nextBase, ...nextPatch])
	return boundMergedTags(Array.from(set))
}

/** Immutable merge for LogContext. */
export const mergeContext = (
	base: Readonly<LogContext> | undefined,
	patch: Partial<LogContext>,
	opts: MergeContextOptions = {}
): LogContext => {
	const dedupeTags = opts.dedupeTags ?? true
	const result = Object.create(null) as Record<string, unknown>
	const baseNamespace = safeRead<string>(base, 'namespace')
	const patchNamespace = safeRead<string>(patch, 'namespace')
	const baseAttributes = safeRead<LogAttributes>(base, 'attributes')
	const patchAttributes = safeRead<LogAttributes>(patch, 'attributes')
	const baseTags = safeRead<readonly string[]>(base, 'tags')
	const patchTags = safeRead<readonly string[]>(patch, 'tags')
	if (patchNamespace !== undefined || baseNamespace !== undefined) {
		const namespace = (patchNamespace ?? baseNamespace) as string
		result.namespace = namespace.length <= MAX_CONTEXT_NAMESPACE_LENGTH
			? namespace
			: `${namespace.slice(0, MAX_CONTEXT_NAMESPACE_LENGTH)}${TRUNCATED}`
	}
	if (patchAttributes !== undefined || baseAttributes !== undefined) {
		result.attributes = mergeAttributes(baseAttributes, patchAttributes)
	}
	if (patchTags !== undefined || baseTags !== undefined) {
		result.tags = mergeTags(baseTags, patchTags, dedupeTags)
	}
	return result as LogContext
}

/** Snapshot a caller-owned context before any asynchronous factory boundary. */
export function snapshotLogContext(context: Readonly<LogContext> | undefined): LogContext | undefined {
	if (context === undefined) return undefined
	if (!context || typeof context !== 'object' || Array.isArray(context)) {
		throw new TypeError('Logging context must be an object')
	}
	try {
		const prototype = Object.getPrototypeOf(context)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(context)
		const keys = Reflect.ownKeys(descriptors)
		const allowed = new Set(['namespace', 'attributes', 'tags'])
		if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))
			|| Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
			throw new TypeError()
		}
		const namespace = descriptors.namespace?.value
		const attributes = descriptors.attributes?.value
		const tags = descriptors.tags?.value
		if (namespace !== undefined && typeof namespace !== 'string') throw new TypeError()
		if (attributes !== undefined && (!attributes || typeof attributes !== 'object' || Array.isArray(attributes))) throw new TypeError()
		if (tags !== undefined && !Array.isArray(tags)) throw new TypeError()
		return mergeContext(undefined, context)
	} catch {
		throw new TypeError('Logging context contains invalid or unexpected fields')
	}
}
