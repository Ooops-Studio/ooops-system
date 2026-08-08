import type {NormalizedError} from '../../contracts/errors'
import {containNativePromiseUnchecked} from '../../runtime/async/native-promise'
import {
	addNativeWeakSet,
	deleteNativeWeakSet,
	hasNativeSet,
	hasNativeWeakSet,
	pushNativeArray
} from '../../runtime/collections/native-collections'
import {hasSafePrototypeChain, isProxyObject} from '../safe-object'

const MAX_NORMALIZED_STRING = 65_536
const MAX_NORMALIZED_DEPTH = 8
const MAX_NORMALIZED_ENTRIES = 200
const MAX_NORMALIZED_NODES = 2_000
const MAX_NORMALIZED_CHARACTERS = 131_072
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const trustedNativeErrorStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get
const nativeReflectApply = Reflect.apply
const nativeJsonStringify = JSON.stringify.bind(JSON)
const NativeString = String
const nativeArrayIsArray = Array.isArray
const nativeMathMin = Math.min
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectCreate = Object.create
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectHasOwn = Object.hasOwn
const nativeObjectPrototype = Object.prototype
const NativeWeakSet = WeakSet
const nativeErrorPrototype = Error.prototype
const nativeErrorNameValue = nativeObjectGetOwnPropertyDescriptor(nativeErrorPrototype, 'name')?.value

interface NormalizationBudget {
	nodes: number
	characters: number
}

function createNormalizedError(
	kind: string,
	message: string,
	stack?: string,
	code?: string,
	data?: Readonly<Record<string, unknown>>,
	cause?: NormalizedError
): NormalizedError {
	const normalized = nativeObjectCreate(null) as {
		kind: string
		message: string
		stack?: string
		code?: string
		data?: Readonly<Record<string, unknown>>
		cause?: NormalizedError
	}
	normalized.kind = kind
	normalized.message = message
	if (stack !== undefined) normalized.stack = stack
	if (code !== undefined) normalized.code = code
	if (data !== undefined) normalized.data = data
	if (cause !== undefined) normalized.cause = cause
	return normalized
}

function dataProperty(value: object, key: PropertyKey): unknown {
	containNativePromiseUnchecked(value)
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
		if (!descriptor || !('value' in descriptor)) return undefined
		containNativePromiseUnchecked(descriptor.value)
		return descriptor.value
	} catch { return undefined }
}

function safePlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object') return false
	try {
		if (isProxyObject(value)) return false
		if (nativeArrayIsArray(value)) return false
		const prototype = nativeObjectGetPrototypeOf(value)
		return prototype === nativeObjectPrototype || prototype === null
	} catch { return false }
}

function safeArrayKind(value: object): boolean | undefined {
	try { return nativeArrayIsArray(value) } catch { return undefined }
}

function safeNativeError(value: unknown): value is Error {
	if (!value || typeof value !== 'object') return false
	if (isProxyObject(value)) return false
	try {
		let prototype: object | null = nativeObjectGetPrototypeOf(value) as object | null
		for (let depth = 0; prototype && depth < 32; depth += 1) {
			if (isProxyObject(prototype)) return false
			if (prototype === nativeErrorPrototype) return true
			prototype = nativeObjectGetPrototypeOf(prototype) as object | null
		}
	} catch { return false }
	return false
}

function nativeErrorName(value: object): string | undefined {
	let current: object | null = value
	try {
		for (let depth = 0; current && depth < 8; depth += 1) {
			if (isProxyObject(current)) return undefined
			if (current === nativeErrorPrototype) {
				return typeof nativeErrorNameValue === 'string' ? nativeErrorNameValue : 'Error'
			}
			if (current === nativeObjectPrototype) return undefined
			const name = dataProperty(current, 'name')
			if (typeof name === 'string') return name
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function nativeErrorStack(value: object): string | undefined {
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(value, 'stack')
		if (!descriptor) return undefined
		if ('value' in descriptor) {
			containNativePromiseUnchecked(descriptor.value)
			return typeof descriptor.value === 'string' ? descriptor.value : undefined
		}
		if (!trustedNativeErrorStackGetter || descriptor.get !== trustedNativeErrorStackGetter) return undefined
		const stack = nativeReflectApply(trustedNativeErrorStackGetter, value, []) as unknown
		return typeof stack === 'string' ? stack : undefined
	} catch { return undefined }
}

function boundedString(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback
	if (value.length === 0) return fallback
	return value.length <= MAX_NORMALIZED_STRING ? value : '[DROPPED_OVERSIZED]'
}

function boundedSnapshotString(value: string, budget: NormalizationBudget): string {
	if (value.length > MAX_NORMALIZED_STRING) return '[DROPPED_OVERSIZED]'
	if (value.length > budget.characters) {
		budget.characters = 0
		return '[Truncated]'
	}
	budget.characters -= value.length
	return value
}

function snapshotValue(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
	budget: NormalizationBudget
): unknown {
	containNativePromiseUnchecked(value)
	if (budget.nodes <= 0) return '[Truncated]'
	budget.nodes--
	if (typeof value === 'string') return boundedSnapshotString(value, budget)
	if (typeof value === 'bigint') return '[BigInt]'
	if (typeof value === 'number') return nativeNumberIsFinite(value) ? value
		: nativeReflectApply(NativeString, undefined, [value]) as string
	if (value === null || typeof value === 'boolean') return value
	if (value === undefined || typeof value === 'symbol' || typeof value === 'function') return null
	if (typeof value !== 'object') return null
	if (isProxyObject(value)) return '[Unserializable]'
	if (depth >= MAX_NORMALIZED_DEPTH) return '[MaxDepth]'
	if (hasNativeWeakSet(seen, value)) return '[Circular]'
	addNativeWeakSet(seen, value)
	try {
		const arrayKind = safeArrayKind(value)
		if (arrayKind === undefined) return '[Unserializable]'
		if (arrayKind) {
			const lengthValue = dataProperty(value, 'length')
			const length = nativeNumberIsSafeInteger(lengthValue) && (lengthValue as number) >= 0
				? nativeMathMin(lengthValue as number, MAX_NORMALIZED_ENTRIES)
				: 0
			const result: unknown[] = []
			for (let index = 0; index < length; index += 1) {
				pushNativeArray(result, snapshotValue(dataProperty(value, index), seen, depth + 1, budget))
			}
			return result
		}
		if (!hasSafePrototypeChain(value)) return '[Unserializable]'
		const output = nativeObjectCreate(null) as Record<string, unknown>
		let entries = 0
		let scanned = 0
		try {
			for (const key in value) {
				if (!nativeObjectHasOwn(value, key)) break
				if (++scanned > MAX_NORMALIZED_ENTRIES) break
				if (++entries > MAX_NORMALIZED_ENTRIES) break
				if (key.length === 0 || key.length > 128 || hasNativeSet(FORBIDDEN_KEYS, key)) continue
				let descriptor: PropertyDescriptor | undefined
				try { descriptor = nativeObjectGetOwnPropertyDescriptor(value, key) } catch { continue }
				if (!descriptor?.enumerable || !('value' in descriptor)) continue
				output[key] = snapshotValue(descriptor.value, seen, depth + 1, budget)
			}
		} catch { return '[Unserializable]' }
		return output
	} finally {
		deleteNativeWeakSet(seen, value)
	}
}

function safeSnapshotMessage(value: unknown): string {
	try {
		const serialized = nativeJsonStringify(value)
		return serialized && serialized.length <= MAX_NORMALIZED_STRING ? serialized : '[Object]'
	} catch { return '[Object]' }
}

/**
 * Minimal error-like shape for safely reading message/name/stack without instanceof.
 * @example
 * const e: ErrorLike = { message: 'oops', name: 'Failure' }
 */
export type ErrorLike = {
	name?: unknown
	message?: unknown
	stack?: unknown
	[k: string]: unknown
}

/**
 * Tests whether a value is an Error instance or a plain object with error-like fields.
 * @param value the candidate value
 * @returns true when `value` is an Error or carries a string message/name
 * @example
 * isErrorLike(new Error('boom')) // true
 * isErrorLike({message: 'oops'}) // true
 */
export function isErrorLike(value: unknown): value is ErrorLike {
	containNativePromiseUnchecked(value)
	if (value === null || value === undefined) return false
	if (safeNativeError(value)) return true
	if (typeof value !== 'object') return false
	if (!safePlainObject(value)) return false
	return typeof dataProperty(value, 'message') === 'string' || typeof dataProperty(value, 'name') === 'string'
}

/**
 * Normalize any error-like value into a consistent NormalizedError shape.
 * Handles native Error instances, error-like objects, plain objects, and primitives.
 * @param input - Any value that might represent an error
 * @returns NormalizedError with consistent structure
 */
export function normalizeError(input: unknown): NormalizedError {
	return normalizeErrorInternal(input, new NativeWeakSet<object>(), 0, {
		nodes: MAX_NORMALIZED_NODES,
		characters: MAX_NORMALIZED_CHARACTERS
	})
}

function normalizeErrorInternal(
	input: unknown,
	seen: WeakSet<object>,
	depth: number,
	budget: NormalizationBudget
): NormalizedError {
	containNativePromiseUnchecked(input)
	if (input === null) return createNormalizedError('UnknownError', 'null')
	if (input && typeof input === 'object') {
		if (isProxyObject(input)) return createNormalizedError('UnknownError', '[Object]')
		if (depth >= MAX_NORMALIZED_DEPTH) return createNormalizedError('UnknownError', '[MaxDepth]')
		if (hasNativeWeakSet(seen, input)) return createNormalizedError('UnknownError', '[Circular]')
		addNativeWeakSet(seen, input)
		try {
			const native = safeNativeError(input)
			const ownName = dataProperty(input, 'name')
			const ownMessage = dataProperty(input, 'message')
			const stack = dataProperty(input, 'stack') ?? (native ? nativeErrorStack(input) : undefined)
			const code = dataProperty(input, 'code')
			const cause = dataProperty(input, 'cause')
			const data = dataProperty(input, 'data')
			const plain = safePlainObject(input)
			const errorLike = typeof ownName === 'string' || typeof ownMessage === 'string'
			if (plain && !errorLike) {
				const snapshot = snapshotValue(input, new NativeWeakSet<object>(), 0, budget) as Readonly<Record<string, unknown>>
				return createNormalizedError('UnknownError', safeSnapshotMessage(snapshot), undefined, undefined, snapshot)
			}
			if (native || plain) {
				const kind = boundedString(ownName, native ? boundedString(nativeErrorName(input), 'Error') : 'UnknownError')
				const message = boundedString(ownMessage, native ? 'error' : '[Object]')
				const dataSnapshot = data && typeof data === 'object' && safeArrayKind(data) === false
					? snapshotValue(data, new NativeWeakSet<object>(), 0, budget)
					: undefined
				const safeData = dataSnapshot && typeof dataSnapshot === 'object' && !nativeArrayIsArray(dataSnapshot)
					? dataSnapshot as Readonly<Record<string, unknown>>
					: undefined
				return createNormalizedError(
					kind,
					message,
					typeof stack === 'string' && stack.length <= MAX_NORMALIZED_STRING ? stack : undefined,
					typeof code === 'string' && code.length <= MAX_NORMALIZED_STRING ? code : undefined,
					safeData,
					cause !== undefined ? normalizeErrorInternal(cause, seen, depth + 1, budget) : undefined
				)
			}
			return createNormalizedError('UnknownError', '[Object]')
		} finally {
			deleteNativeWeakSet(seen, input)
		}
	}
	if (typeof input === 'string') return createNormalizedError('UnknownError', boundedString(input, 'error'))
	if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'undefined') {
		return createNormalizedError('UnknownError', `${input}`)
	}
	if (typeof input === 'bigint') return createNormalizedError('UnknownError', '[BigInt]')
	if (typeof input === 'symbol') return createNormalizedError('UnknownError', '[Symbol]')
	if (typeof input === 'function') return createNormalizedError('UnknownError', '[Function]')
	return createNormalizedError('UnknownError', '[Unavailable]')
}
