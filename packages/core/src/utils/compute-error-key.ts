/**
 * @file Error key computation utility for error deduplication and policies.
 * Standardized key generation used across dedup, frequency, and escalation caches.
 */

import type {EnrichedError} from '../contracts/errors'
import {containNativePromiseUnchecked} from '../runtime/async/native-promise'

import {simpleHash} from './hashing/simple-hash'
import {isProxyObject} from './safe-object'

const MAX_ERROR_KEY_TEXT = 65_536
const MAX_ERROR_KEY_COMPONENT = 256
const nativeReflectApply = Reflect.apply
const nativeRegExpTest = RegExp.prototype.test
const nativeMathAbs = Math.abs
const nativeMathFloor = Math.floor
const nativeNumberToString = Number.prototype.toString
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeStringCharCodeAt = String.prototype.charCodeAt
const nativeStringSlice = String.prototype.slice
const SAFE_CATEGORY = /^[A-Za-z0-9_-]{1,64}$/u

function readStringField(value: unknown, key: PropertyKey): string | undefined {
	containNativePromiseUnchecked(value)
	if (!value || typeof value !== 'object') return undefined
	if (isProxyObject(value)) return undefined
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
		if (!descriptor || !('value' in descriptor)) return undefined
		containNativePromiseUnchecked(descriptor.value)
		return typeof descriptor.value === 'string' ? descriptor.value : undefined
	} catch { return undefined }
}

function boundedKeyText(value: string, maximum = MAX_ERROR_KEY_TEXT): string {
	if (value.length <= maximum) return value
	const half = nativeMathFloor(maximum / 2)
	return `${nativeReflectApply(nativeStringSlice, value, [0, half]) as string}[truncated:${value.length}]${
		nativeReflectApply(nativeStringSlice, value, [-half]) as string
	}`
}

function safeCategory(value: string | undefined): string {
	return value && nativeReflectApply(nativeRegExpTest, SAFE_CATEGORY, [value]) as boolean
		? value : 'UNKNOWN'
}

function appendHash(hash: number, char: number): number {
	return (((hash << 5) - hash) + char) | 0
}

/** Hashes the code-point-reversed string without allocating that string. */
function reverseSimpleHash(input: string): string {
	let hash = 0
	for (let index = input.length - 1; index >= 0;) {
		const trailing = nativeReflectApply(nativeStringCharCodeAt, input, [index]) as number
		if (trailing >= 0xDC00 && trailing <= 0xDFFF && index > 0) {
			const leading = nativeReflectApply(nativeStringCharCodeAt, input, [index - 1]) as number
			if (leading >= 0xD800 && leading <= 0xDBFF) {
				hash = appendHash(hash, leading)
				hash = appendHash(hash, trailing)
				index -= 2
				continue
			}
		}
		hash = appendHash(hash, trailing)
		index -= 1
	}
	return nativeReflectApply(nativeNumberToString, nativeMathAbs(hash), [36]) as string
}

/**
 * Hashing both directions plus the input length keeps redacted messages out of
 * cache keys while avoiding the common short collisions of the legacy digest.
 */
function errorKeyHash(input: string): string {
	return `${simpleHash(input)}.${reverseSimpleHash(input)}.${
		nativeReflectApply(nativeNumberToString, input.length, [36]) as string
	}`
}

/**
 * Options for computing error keys
 */
export interface ComputeErrorKeyOptions {
	/**
	 * Policy mode: if true, may use different key inputs for policy-specific caches.
	 * Default: false (deduplication mode - post-redaction hash)
	 */
	readonly policyMode?: boolean
}

/**
 * Compute standardized error key for caching.
 * CRITICAL: Hash kind + message + code + category post-redaction, not pre-redaction.
 * Respect privacy by default - never key on raw messages that might contain PII.
 * Assumes error has been redacted before deduplication.
 *
 * @param error - The enriched error to generate a key for
 * @param options - Optional key computation options
 * @returns Cache key string
 */
export function computeErrorKey(
	error: EnrichedError,
	_options?: ComputeErrorKeyOptions
): string {
	containNativePromiseUnchecked(error)
	containNativePromiseUnchecked(_options)

	// Hash kind + message + code + category (all should be redacted by this point).
	// Kind shares one digest segment with message to preserve the stable external
	// key shape while keeping distinct native failures out of the same TTL bucket.
	// Policy mode uses same logic for now, but allows future differentiation
	const kind = boundedKeyText(readStringField(error, 'kind') ?? '', MAX_ERROR_KEY_COMPONENT)
	const message = boundedKeyText(readStringField(error, 'message') ?? 'error')
	const code = readStringField(error, 'code')
	const category = safeCategory(readStringField(error, 'category'))
	const messageHash = errorKeyHash(`${kind}\0${message}`)
	const codeHash = code ? errorKeyHash(boundedKeyText(code, MAX_ERROR_KEY_COMPONENT)) : ''
	return `error:${category}:${messageHash}:${codeHash}`
}
