/**
 * @file Simple, fast hash function for string keys (djb2 variant).
 * Returns base36-encoded hash suitable for cache keys and deduplication.
 * Different from stable hash which is for complex objects.
 */

import {containNativePromiseUnchecked} from '../../runtime/async/native-promise'

const nativeMathAbs = Math.abs
const nativeNumberToString = Number.prototype.toString
const nativeReflectApply = Reflect.apply
const nativeStringCharCodeAt = String.prototype.charCodeAt

/**
 * Simple, fast hash function for string keys (djb2 variant).
 * Returns base36-encoded hash suitable for cache keys.
 *
 * @param input - String to hash
 * @returns Base36-encoded hash string
 */
export function simpleHash(input: string): string {
	containNativePromiseUnchecked(input)
	if (typeof input !== 'string' || input.length > 1_000_000) {
		throw new RangeError('Simple hash input must be a string of at most 1000000 characters')
	}

	let hash = 0
	for (let i = 0; i < input.length; i++) {
		const char = nativeReflectApply(nativeStringCharCodeAt, input, [i]) as number
		hash = ((hash << 5) - hash) + char
		hash = hash & hash // Convert to 32-bit integer
	}

	return nativeReflectApply(nativeNumberToString, nativeMathAbs(hash), [36]) as string
}
