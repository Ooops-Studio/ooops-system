/**
 * @file UTF-8 byte size calculation utility.
 * Cross-platform implementation that works in Node.js and browser environments.
 */

import {containNativePromiseUnchecked} from '../runtime/async/native-promise'

const nativeReflectApply = Reflect.apply
const nativeStringCharCodeAt = String.prototype.charCodeAt

/**
 * Calculate UTF-8 byte size of a string using inline encoder.
 * Fallback for environments without TextEncoder or Buffer.
 * @param s - String to measure
 * @returns Number of UTF-8 bytes
 */
function utf8ByteSizeFallback(s: string): number {
	let size = 0
	for (let i = 0; i < s.length; i++) {
		const code = nativeReflectApply(nativeStringCharCodeAt, s, [i]) as number
		if (code < 0x80) {
			// ASCII: 1 byte
			size += 1
		} else if (code < 0x800) {
			// 2-byte sequence: 0x80-0x7FF
			size += 2
		} else if (code >= 0xD800 && code <= 0xDFFF) {
			// Surrogate pair: 4 bytes
			// High surrogate (0xD800-0xDBFF) followed by low surrogate (0xDC00-0xDFFF)
			if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
				const low = nativeReflectApply(nativeStringCharCodeAt, s, [i + 1]) as number
				if (low >= 0xDC00 && low <= 0xDFFF) {
					// Valid surrogate pair - 4 bytes
					size += 4
					i++ // Skip the low surrogate
					continue
				}
			}
			// Invalid surrogate - treat as 3-byte sequence
			size += 3
		} else {
			// 3-byte sequence: 0x800-0xFFFF (excluding surrogates)
			size += 3
		}
	}
	return size
}

/**
 * Calculate UTF-8 byte size of a string.
 * Works in both Node.js and browser environments.
 * @param s - String to measure
 * @returns Number of UTF-8 bytes
 */
export function byteSize(s: string): number {
	containNativePromiseUnchecked(s)
	if (typeof s !== 'string') throw new TypeError('byteSize input must be a string')
	// Count directly instead of allocating a second, UTF-8-sized buffer. This is
	// important at hostile-input boundaries where an already-large string must
	// not transiently double or quadruple retained memory just to measure it.
	return utf8ByteSizeFallback(s)
}
