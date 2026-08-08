/**
 * @file Stable, platform-independent hashing + stringify with a tiny factory.
 * - Deterministic stringify (sorted keys, circular tag)
 * - FNV-1a 32-bit with configurable seed
 * - Hex (default) or base64 output
 * - Reuses a single TextEncoder for perf
 *
 * Usage:
 *   const { hash, stringify } = createStableHasher()
 *   hash({a: 1})          // "e1ab34c9"
 *   stringify({b: 2})     // '{"b":2}'
 *
 * Convenience static also exported: hash32Hex(str)
 */

import {containNativePromiseUnchecked, isolateUnexpectedThenable} from '../../runtime/async/native-promise'
import {
	addNativeWeakSet,
	hasNativeWeakSet,
	pushNativeArray
} from '../../runtime/collections/native-collections'
import {hasSafePrototypeChain, isProxyObject} from '../safe-object'

export interface StableHashOptions {
	/** Initial FNV-1a seed (default 0x811c9dc5). */
	seed?: number
	/** Circular reference tag used during stringify (default: "[Circular]"). */
	circularTag?: string
	/** Output encoding for the 32-bit digest (default: "hex"). */
	encode?: 'hex' | 'base64'
	/** Custom encoder (mostly for exotic runtimes). */
	textEncoder?: {encode(input: string): Uint8Array}
}

export interface StableHasher {
	/** Deterministic stringify (sorted keys, circular-safe). */
	stringify(value: unknown): string
	/** Hash a JS value (via stringify) into a 32-bit digest string. */
	hash(value: unknown): string
	/** Hash a raw string directly. */
	hashString(input: string): string
}

/* ----------------------------- internals ---------------------------------- */

const FNV_OFFSET = 0x811c9dc5 >>> 0
const nativeReflectApply = Reflect.apply
const nativeJsonStringify = JSON.stringify.bind(JSON)
const nativeNumberToString = Number.prototype.toString
const nativeStringPadStart = String.prototype.padStart
const nativeStringSlice = String.prototype.slice
const nativeStringFromCharCode = String.fromCharCode
const NativeString = String
const nativeArrayIsArray = Array.isArray
const nativeArrayJoin = Array.prototype.join
const nativeArraySort = Array.prototype.sort
const nativeMathMin = Math.min
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectPrototype = Object.prototype
const NativeArrayBuffer = ArrayBuffer
const NativeUint8Array = Uint8Array
const NativeDataView = DataView
const NativeWeakSet = WeakSet
const nativeDataViewSetUint32 = DataView.prototype.setUint32
const NativeBuffer = typeof Buffer === 'undefined' ? undefined : Buffer
const nativeBufferFrom = NativeBuffer?.from
const nativeBufferToString = NativeBuffer?.prototype.toString
const nativeBtoa = typeof btoa === 'undefined' ? undefined : btoa
const NativeTextEncoder = typeof TextEncoder === 'undefined' ? undefined : TextEncoder
const nativeTextEncoderEncode = NativeTextEncoder?.prototype.encode
const defaultTextEncoder = NativeTextEncoder ? new NativeTextEncoder() : undefined
const nativeTypedArrayByteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype) as object,
	'byteLength'
)?.get

function fnv1a32(bytes: Uint8Array, seed = FNV_OFFSET, length = bytes.length): number {
	let h = seed >>> 0
	for (let i = 0; i < length; i++) {
		h ^= bytes[i]!
		// h *= 16777619 (FNV prime) using 32-bit overflow math
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
	}
	return h >>> 0
}

function encodeHex(u32: number): string {
	const hex = nativeReflectApply(nativeNumberToString, u32 >>> 0, [16]) as string
	return nativeReflectApply(nativeStringPadStart, hex, [8, '0']) as string
}

function encodeBase64(u32: number): string {
	// 4 bytes big-endian
	const buffer = new NativeArrayBuffer(4)
	const arr = new NativeUint8Array(buffer)
	nativeReflectApply(nativeDataViewSetUint32, new NativeDataView(buffer), [0, u32 >>> 0, false])
	if (NativeBuffer && nativeBufferFrom && nativeBufferToString) {
		const bytes = nativeReflectApply(nativeBufferFrom, NativeBuffer, [arr]) as Buffer
		return nativeReflectApply(nativeBufferToString, bytes, ['base64']) as string
	}
	if (nativeBtoa) {
		let s = ''
		for (let i = 0; i < 4; i++) {
			s += nativeReflectApply(nativeStringFromCharCode, String, [arr[i]!]) as string
		}
		return nativeReflectApply(nativeBtoa, globalThis, [s]) as string
	}
	// Last resort: fall back to hex
	return encodeHex(u32)
}

function getDefaultEncoder(): {encode(input: string): Uint8Array} {
	if (defaultTextEncoder && nativeTextEncoderEncode) return {
		encode: (input: string) => nativeReflectApply(
			nativeTextEncoderEncode, defaultTextEncoder, [input]
		) as Uint8Array
	}
	// Node fallback
	return {
		encode: (s: string) =>

			(NativeBuffer && nativeBufferFrom
				? nativeReflectApply(nativeBufferFrom, NativeBuffer, [s, 'utf8'])
				: new NativeUint8Array([])) as unknown as Uint8Array
	}
}

/* ----------------------------- stringify ---------------------------------- */

const MAX_STABLE_HASH_DEPTH = 32
const MAX_STABLE_HASH_NODES = 10_000
const MAX_STABLE_HASH_ENTRIES = 1_000
const MAX_STABLE_HASH_CHARACTERS = 1_000_000
// Streaming truncation may append one final JSON string marker after consuming
// the input-character budget. Keep that bounded serializer overhead separate
// from the public raw-string contract so hash(value) cannot reject a value that
// stringify(value) already contained successfully.
const MAX_STABLE_HASH_SERIALIZED_CHARACTERS = MAX_STABLE_HASH_CHARACTERS + 20

function stableJsonStringify(value: unknown, circularTag = '[Circular]'): string {
	const seen = new NativeWeakSet<object>()
	const output: string[] = []
	let nodes = MAX_STABLE_HASH_NODES
	let characters = MAX_STABLE_HASH_CHARACTERS
	const append = (text: string): void => {
		if (characters <= 0) return
		const fragment = text.length <= characters ? text
			: nativeReflectApply(nativeStringSlice, text, [0, characters]) as string
		pushNativeArray(output, fragment)
		characters -= fragment.length
	}
	const appendJsonString = (text: string): void => {
		append(nativeJsonStringify(text.length <= characters ? text
			: nativeReflectApply(nativeStringSlice, text, [0, characters]) as string))
	}
	const walk = (current: unknown, depth: number): void => {
		containNativePromiseUnchecked(current)
		if (characters <= 0) return
		if (nodes-- <= 0) { appendJsonString('[MaxNodes]'); return }
		const type = typeof current
		if (current === null) { append('null'); return }
		if (current === undefined) { append('undefined'); return }
		if (type === 'number' || type === 'boolean') {
			append(nativeReflectApply(NativeString, undefined, [current]) as string)
			return
		}
		if (type === 'string') { appendJsonString(current as string); return }
		if (type !== 'object') { appendJsonString(`[${type}]`); return }
		const object = current as object
		if (isProxyObject(object)) { appendJsonString('[Uninspectable]'); return }
		if (!hasSafePrototypeChain(object)) { appendJsonString('[Uninspectable]'); return }
		if (hasNativeWeakSet(seen, object)) { appendJsonString(circularTag); return }
		if (depth >= MAX_STABLE_HASH_DEPTH) { appendJsonString('[MaxDepth]'); return }
		addNativeWeakSet(seen, object)
		let array = false
		try { array = nativeArrayIsArray(object) } catch { appendJsonString('[Uninspectable]'); return }
		if (array) {
			append('[')
			let length = 0
			try {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(object, 'length')
				const observed = descriptor && 'value' in descriptor ? descriptor.value : 0
				length = nativeNumberIsSafeInteger(observed) && observed >= 0
					? nativeMathMin(observed, MAX_STABLE_HASH_ENTRIES) : 0
			} catch { appendJsonString('[Uninspectable]'); append(']'); return }
			for (let index = 0; index < length && characters > 0; index += 1) {
				if (index > 0) append(',')
				try {
					const descriptor = nativeObjectGetOwnPropertyDescriptor(object, index)
					if (descriptor && 'value' in descriptor) walk(descriptor.value, depth + 1)
					else appendJsonString('[Unavailable]')
				} catch { appendJsonString('[Uninspectable]') }
			}
			try {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(object, 'length')
				const observed = descriptor && 'value' in descriptor ? descriptor.value : 0
				if (typeof observed === 'number' && observed > length) {
					if (length > 0) append(',')
					appendJsonString('[Truncated]')
				}
			} catch { /* The inspected prefix remains deterministic. */ }
			append(']')
			return
		}
		const entries: Array<[string, PropertyDescriptor]> = []
		let truncated = false
		let scanned = 0
		try {
			for (const key in object) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(object, key)
				if (!descriptor) break
				if (++scanned > MAX_STABLE_HASH_ENTRIES) { truncated = true; break }
				if (!descriptor?.enumerable || !('value' in descriptor)) continue
				if (entries.length >= MAX_STABLE_HASH_ENTRIES) { truncated = true; break }
				pushNativeArray(entries, [key, descriptor])
			}
			nativeReflectApply(nativeArraySort, entries, [
				(left: [string, PropertyDescriptor], right: [string, PropertyDescriptor]) =>
					left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
			])
		} catch { appendJsonString('[Uninspectable]'); return }
		append('{')
		let emitted = 0
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index]!
			const key = entry[0]
			const descriptor = entry[1]
			if (emitted++ > 0) append(',')
			appendJsonString(key)
			append(':')
			walk(descriptor.value, depth + 1)
		}
		if (truncated) {
			if (emitted > 0) append(',')
			appendJsonString('[truncated]')
			append(':true')
		}
		append('}')
	}
	walk(value, 0)
	if (characters === 0) pushNativeArray(output, '"[Truncated]"')
	return nativeReflectApply(nativeArrayJoin, output, ['']) as string
}

/* ------------------------------ factory ----------------------------------- */

function readHasherOption(options: unknown, key: keyof StableHashOptions): unknown {
	containNativePromiseUnchecked(options)
	if (!options || typeof options !== 'object') return undefined
	if (isProxyObject(options)) throw new TypeError('Stable hash options must not be a Proxy')
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(options, key)
		if (!descriptor) return undefined
		if (!('value' in descriptor)) throw new TypeError('Stable hash options must use data properties')
		containNativePromiseUnchecked(descriptor.value)
		return descriptor.value
	} catch(error) {
		if (error instanceof TypeError) throw error
		throw new TypeError('Stable hash options cannot be inspected safely')
	}
}

export function createStableHasher(options: StableHashOptions = {}): StableHasher {
	if (isolateUnexpectedThenable(options)) throw new TypeError('Stable hash options must be synchronous')
	const seed = readHasherOption(options, 'seed') ?? FNV_OFFSET
	const circularTag = readHasherOption(options, 'circularTag') ?? '[Circular]'
	const encode = readHasherOption(options, 'encode') ?? 'hex'
	const encoder = readHasherOption(options, 'textEncoder') ?? getDefaultEncoder()
	if (isolateUnexpectedThenable(encoder)) throw new TypeError('Stable hash encoder must be synchronous')
	if (typeof seed !== 'number' || !nativeNumberIsSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
		throw new TypeError('Stable hash seed must be a 32-bit unsigned integer')
	}
	if (typeof circularTag !== 'string' || circularTag.length > 256) {
		throw new TypeError('Stable hash circularTag must be a string of at most 256 characters')
	}
	if (encode !== 'hex' && encode !== 'base64') throw new TypeError('Stable hash encoding is invalid')
	let encodeMethod: ((input: string) => Uint8Array) | undefined
	try {
		if (!encoder || typeof encoder !== 'object' || isProxyObject(encoder)) throw new TypeError()
		const prototype = nativeObjectGetPrototypeOf(encoder) as object | null
		if (prototype && isProxyObject(prototype)) throw new TypeError()
		const descriptor = nativeObjectGetOwnPropertyDescriptor(encoder, 'encode')
			?? (prototype && prototype !== nativeObjectPrototype
				? nativeObjectGetOwnPropertyDescriptor(prototype, 'encode') : undefined)
		if (descriptor && 'value' in descriptor) containNativePromiseUnchecked(descriptor.value)
		if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new TypeError()
		const method = descriptor.value as (this: object, input: string) => Uint8Array
		encodeMethod = (input) => {
			try { return nativeReflectApply(method, encoder, [input]) as Uint8Array }
			catch(error) { containNativePromiseUnchecked(error); throw error }
		}
	} catch { throw new TypeError('Stable hash textEncoder must expose a stable encode method') }

	const stringify = (value: unknown) => stableJsonStringify(value, circularTag)

	const digestToString = (u32: number) => (encode === 'hex' ? encodeHex(u32) : encodeBase64(u32))

	const hashBoundedString = (input: string, maximumCharacters: number) => {
		if (typeof input !== 'string' || input.length > maximumCharacters) {
			throw new RangeError(`Stable hash input must be a string of at most ${maximumCharacters} characters`)
		}
		const bytes = encodeMethod(input)
		if (isolateUnexpectedThenable(bytes)) {
			throw new TypeError('Stable hash encoder must return Uint8Array synchronously')
		}
		let byteLength: number
		try {
			if (isProxyObject(bytes) || !nativeTypedArrayByteLength) throw new TypeError()
			byteLength = nativeReflectApply(nativeTypedArrayByteLength, bytes, []) as number
		} catch {
			throw new TypeError('Stable hash encoder must return Uint8Array')
		}
		if (byteLength > maximumCharacters * 4) {
			throw new RangeError('Stable hash encoded input exceeds the bounded UTF-8 size')
		}
		return digestToString(fnv1a32(bytes, seed, byteLength))
	}

	const hashString = (input: string) => hashBoundedString(input, MAX_STABLE_HASH_CHARACTERS)

	const hash = (value: unknown) => hashBoundedString(
		stringify(value), MAX_STABLE_HASH_SERIALIZED_CHARACTERS
	)

	return {
		stringify,
		hash,
		hashString
	}
}

/* ------------------------ convenience exports ------------------------------ */

/** Hash a UTF-8 string into a 32-bit hex digest (FNV-1a). */
export const hash32Hex = (input: string): string => {
	const {hashString} = createStableHasher()
	return hashString(input)
}
