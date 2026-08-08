/**
 * @file JSON-safe serialization utilities.
 * Polymorphic serialization for errors and other values.
 */

import {containNativePromiseUnchecked} from '../../runtime/async/native-promise'
import {
	addNativeWeakSet,
	deleteNativeWeakSet,
	hasNativeWeakSet,
	pushNativeArray
} from '../../runtime/collections/native-collections'
import {hasSafePrototypeChain, isProxyObject} from '../safe-object'

/**
 * Options for serialization
 */
export interface SerializeOptions {
	/** Maximum depth for recursive serialization (default: 10, hard maximum: 32) */
	maxDepth?: number
	/** Whether to include stack traces (default: true) */
	includeStack?: boolean
}

const DEFAULT_SERIALIZE_DEPTH = 10
const MAX_SERIALIZE_DEPTH = 32
const MAX_ERROR_CAUSE_DEPTH = 8
const MAX_SERIALIZE_ENTRIES = 1_000
const MAX_SERIALIZE_NODES = 5_000
const MAX_SERIALIZE_CHARACTERS = 1_048_576
const MAX_SERIALIZED_STRING = 65_536
const trustedNativeErrorStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get
const nativeReflectApply = Reflect.apply
const nativeArrayIsArray = Array.isArray
const nativeDateGetTime = Date.prototype.getTime
const nativeDateToISOString = Date.prototype.toISOString
const nativeJsonStringify = JSON.stringify.bind(JSON)
const nativeMathMin = Math.min
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectCreate = Object.create
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectHasOwn = Object.hasOwn
const nativeObjectPrototype = Object.prototype
const nativeErrorPrototype = Error.prototype
const nativeErrorNameValue = nativeObjectGetOwnPropertyDescriptor(nativeErrorPrototype, 'name')?.value
const NativeWeakSet = WeakSet

interface SerializationBudget {
	nodes: number
	characters: number
}

function createSerializedError(name: string, message: string): Record<string, unknown> {
	const serialized = nativeObjectCreate(null) as Record<string, unknown>
	serialized.name = name
	serialized.message = message
	return serialized
}

function readOwnDataProperty(value: object, key: PropertyKey): unknown {
	containNativePromiseUnchecked(value)
	if (isProxyObject(value)) return undefined
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
		if (!descriptor || !('value' in descriptor)) return undefined
		containNativePromiseUnchecked(descriptor.value)
		return descriptor.value
	} catch { return undefined }
}

function readErrorDataProperty(value: object, key: 'name' | 'message'): unknown {
	let current: object | null = value
	try {
		for (let depth = 0; current && current !== nativeObjectPrototype && depth < 16; depth += 1) {
			if (isProxyObject(current)) return undefined
			if (current === nativeErrorPrototype) {
				return key === 'name' && typeof nativeErrorNameValue === 'string'
					? nativeErrorNameValue : undefined
			}
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, key)
			if (descriptor) {
				if (!('value' in descriptor)) return undefined
				containNativePromiseUnchecked(descriptor.value)
				return descriptor.value
			}
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function isNativeError(value: unknown): value is Error {
	if (!value || typeof value !== 'object') return false
	if (isProxyObject(value)) return false
	try {
		let prototype = nativeObjectGetPrototypeOf(value) as object | null
		for (let depth = 0; prototype && depth < 32; depth += 1) {
			if (isProxyObject(prototype)) return false
			if (prototype === nativeErrorPrototype) return true
			prototype = nativeObjectGetPrototypeOf(prototype) as object | null
		}
	} catch { return false }
	return false
}

function readNativeErrorStack(error: Error): string | undefined {
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(error, 'stack')
		if (!descriptor) return undefined
		if ('value' in descriptor) {
			containNativePromiseUnchecked(descriptor.value)
			return typeof descriptor.value === 'string' ? descriptor.value : undefined
		}
		if (!trustedNativeErrorStackGetter || descriptor.get !== trustedNativeErrorStackGetter) return undefined
		const stack = nativeReflectApply(trustedNativeErrorStackGetter, error, []) as unknown
		return typeof stack === 'string' ? stack : undefined
	} catch { return undefined }
}

function boundedString(value: string, budget: SerializationBudget): string {
	if (value.length > MAX_SERIALIZED_STRING) return '[DROPPED_OVERSIZED]'
	if (value.length > budget.characters) {
		budget.characters = 0
		return '[Truncated]'
	}
	budget.characters -= value.length
	return value
}

function readSerializeOptions(options: SerializeOptions): {
	maxDepth: number
	includeStack: boolean
} {
	containNativePromiseUnchecked(options)
	if (!options || typeof options !== 'object') {
		return {maxDepth: DEFAULT_SERIALIZE_DEPTH, includeStack: true}
	}
	const configuredDepth = readOwnDataProperty(options, 'maxDepth')
	const configuredStack = readOwnDataProperty(options, 'includeStack')
	const maxDepth = nativeNumberIsSafeInteger(configuredDepth) && (configuredDepth as number) >= 0
		? nativeMathMin(configuredDepth as number, MAX_SERIALIZE_DEPTH)
		: DEFAULT_SERIALIZE_DEPTH
	return {
		maxDepth,
		includeStack: typeof configuredStack === 'boolean' ? configuredStack : true
	}
}

function readDate(value: object, budget: SerializationBudget): string | undefined {
	try {
		const timestamp = nativeReflectApply(nativeDateGetTime, value, []) as unknown
		if (typeof timestamp !== 'number' || !nativeNumberIsFinite(timestamp)) return undefined
		const iso = nativeReflectApply(nativeDateToISOString, value, []) as unknown
		return typeof iso === 'string' ? boundedString(iso, budget) : undefined
	} catch { return undefined }
}

function snapshotValue(
	value: unknown,
	maxDepth: number,
	includeStack: boolean,
	budget: SerializationBudget,
	seen: WeakSet<object>,
	depth: number,
	inArray = false
): unknown {
	containNativePromiseUnchecked(value)
	if (budget.nodes-- <= 0 || budget.characters <= 0) throw new TypeError('Serialization budget exceeded')
	if (typeof value === 'string') return boundedString(value, budget)
	if (typeof value === 'number') return nativeNumberIsFinite(value) ? value : null
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'bigint') return '[BigInt]'
	if (value === undefined || typeof value === 'symbol' || typeof value === 'function') {
		return inArray ? null : undefined
	}
	if (typeof value !== 'object') return null
	if (isProxyObject(value)) throw new TypeError('Unsafe serialization input')
	if (depth >= maxDepth) return {'[MaxDepth]': '...'}
	if (hasNativeWeakSet(seen, value)) throw new TypeError('Circular reference detected')

	const date = readDate(value, budget)
	if (date !== undefined) return date
	if (isNativeError(value)) {
		return serializeErrorInternal(value, includeStack, budget, seen, 0)
	}

	addNativeWeakSet(seen, value)
	try {
		let array: boolean
		try { array = nativeArrayIsArray(value) } catch { throw new TypeError('Unsafe serialization input') }
		if (array) {
			const length = readOwnDataProperty(value, 'length')
			if (!nativeNumberIsSafeInteger(length) || (length as number) < 0
				|| (length as number) > MAX_SERIALIZE_ENTRIES) {
				throw new TypeError('Serialization array limit exceeded')
			}
			const result: unknown[] = []
			for (let index = 0; index < (length as number); index += 1) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(value, index)
				const item = descriptor && 'value' in descriptor ? descriptor.value : undefined
				pushNativeArray(result, snapshotValue(
					item, maxDepth, includeStack, budget, seen, depth + 1, true
				))
			}
			return result
		}

		if (!hasSafePrototypeChain(value)) throw new TypeError('Unsafe serialization input')
		const result = nativeObjectCreate(null) as Record<string, unknown>
		let entries = 0
		let scanned = 0
		for (const key in value) {
			if (!nativeObjectHasOwn(value, key)) break
			if (++scanned > MAX_SERIALIZE_ENTRIES) throw new TypeError('Serialization object limit exceeded')
			if (++entries > MAX_SERIALIZE_ENTRIES) throw new TypeError('Serialization object limit exceeded')
			if (key.length > MAX_SERIALIZED_STRING) throw new TypeError('Serialization key limit exceeded')
			const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) continue
			const snapshot = snapshotValue(
				descriptor.value, maxDepth, includeStack, budget, seen, depth + 1
			)
			if (snapshot !== undefined) {
				budget.characters -= key.length
				if (budget.characters < 0) throw new TypeError('Serialization budget exceeded')
				result[key] = snapshot
			}
		}
		return result
	} finally {
		deleteNativeWeakSet(seen, value)
	}
}

/** Serialize any value into a bounded JSON string without invoking accessors. */
export function serialize(value: unknown, options: SerializeOptions = {}): string {
	const {maxDepth, includeStack} = readSerializeOptions(options)
	const budget: SerializationBudget = {
		nodes: MAX_SERIALIZE_NODES,
		characters: MAX_SERIALIZE_CHARACTERS
	}
	try {
		const snapshot = snapshotValue(value, maxDepth, includeStack, budget, new NativeWeakSet<object>(), 0)
		return nativeJsonStringify(snapshot ?? null)
	} catch {
		return nativeJsonStringify('[Circular or non-serializable]')
	}
}

/** Serialize an error to a bounded JSON-safe object. */
export function serializeError(error: Error, includeStack = true): Record<string, unknown> {
	containNativePromiseUnchecked(error)
	containNativePromiseUnchecked(includeStack)
	const budget: SerializationBudget = {
		nodes: MAX_SERIALIZE_NODES,
		characters: MAX_SERIALIZE_CHARACTERS
	}
	try {
		if (!isNativeError(error)) return createSerializedError('Error', 'error')
		return serializeErrorInternal(error, includeStack === true, budget, new NativeWeakSet<object>(), 0)
	} catch {
		return createSerializedError('Error', '[Circular or non-serializable]')
	}
}

function serializeErrorInternal(
	error: Error,
	includeStack: boolean,
	budget: SerializationBudget,
	seen: WeakSet<object>,
	depth: number
): Record<string, unknown> {
	if (budget.nodes-- <= 0 || budget.characters <= 0) throw new TypeError('Serialization budget exceeded')
	if (hasNativeWeakSet(seen, error)) return createSerializedError('Error', '[Circular]')

	const name = readErrorDataProperty(error, 'name')
	const message = readErrorDataProperty(error, 'message')
	const serialized = createSerializedError(
		typeof name === 'string' ? boundedString(name, budget) : 'Error',
		typeof message === 'string' ? boundedString(message, budget) : 'error'
	)
	const stack = readOwnDataProperty(error, 'stack') ?? readNativeErrorStack(error)
	if (includeStack && typeof stack === 'string' && stack.length > 0) {
		serialized.stack = boundedString(stack, budget)
	}

	addNativeWeakSet(seen, error)
	try {
		const cause = readOwnDataProperty(error, 'cause')
		if (cause !== undefined) {
			containNativePromiseUnchecked(cause)
			if (depth >= MAX_ERROR_CAUSE_DEPTH) serialized.cause = '[MaxDepth]'
			else if (isNativeError(cause)) {
				serialized.cause = serializeErrorInternal(cause, includeStack, budget, seen, depth + 1)
			} else {
				serialized.cause = snapshotValue(
					cause, MAX_ERROR_CAUSE_DEPTH, false, budget, seen, depth + 1
				)
			}
		}
	} catch {
		serialized.cause = '[Circular or non-serializable]'
	} finally {
		deleteNativeWeakSet(seen, error)
	}

	const code = readOwnDataProperty(error, 'code')
	if (typeof code === 'string') serialized.code = boundedString(code, budget)
	return serialized
}
