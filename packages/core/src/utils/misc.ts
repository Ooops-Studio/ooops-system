/**
 * @file Miscellaneous utility functions.
 * General-purpose utilities used across services.
 */

import {
	containNativePromiseUnchecked,
	createNativePromise,
	isolateUnexpectedThenable
} from '../runtime/async/native-promise'

import {hasSafePrototypeChain} from './safe-object'

const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeArrayIsArray = Array.isArray
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeArrayPush = Array.prototype.push

/**
 * Sleep for a given number of milliseconds
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
	containNativePromiseUnchecked(ms)
	if (!nativeNumberIsSafeInteger(ms) || ms < 0 || ms > 2_147_483_647) {
		return createNativePromise((_resolve, reject) => {
			reject(new RangeError('Sleep duration must be a non-negative safe integer of at most 2147483647 milliseconds'))
		})
	}
	return createNativePromise((resolve, reject) => {
		try {
			const timer = setTimeout(resolve, ms)
			if (isolateUnexpectedThenable(timer)) {
				reject(new TypeError('Sleep timer must be allocated synchronously'))
			}
		} catch(error) { reject(error) }
	})
}

const MAX_ERROR_CONTEXT_FIELDS = 64
const MAX_ERROR_CONTEXT_SCAN = 256
const MAX_ERROR_CONTEXT_KEY = 128
const MAX_ERROR_CONTEXT_VALUE = 1_024
const MAX_FORMATTED_ERROR_MESSAGE = 32_768
const nativeReflectApply = Reflect.apply
const nativeStringCharCodeAt = String.prototype.charCodeAt
const nativeStringSlice = String.prototype.slice
const nativeArrayJoin = Array.prototype.join

function boundedDiagnosticText(value: string, maxLength: number): string {
	let output = ''
	let consumed = 0
	for (let index = 0; index < value.length && consumed < maxLength;) {
		const code = nativeReflectApply(nativeStringCharCodeAt, value, [index]) as number
		let width = 1
		if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
			const trailing = nativeReflectApply(nativeStringCharCodeAt, value, [index + 1]) as number
			if (trailing >= 0xDC00 && trailing <= 0xDFFF) width = 2
		}
		const character = nativeReflectApply(nativeStringSlice, value, [index, index + width]) as string
		index += width
		if (code <= 31 || code === 127) {
			const escaped = code === 10 ? '\\n' : code === 13 ? '\\r' : code === 9 ? '\\t' : '?'
			if (consumed + escaped.length > maxLength) break
			output += escaped
			consumed += escaped.length
		} else {
			if (consumed + character.length > maxLength) break
			output += character
			consumed += character.length
		}
	}
	return output
}

/**
 * Format error message with consistent context
 * @param message - Error message
 * @param context - Additional context (operation, metric name, etc.)
 * @returns Formatted error message
 */
export function formatErrorMessage(
	message: string,
	context?: Record<string, string>
): string {
	containNativePromiseUnchecked(message)
	containNativePromiseUnchecked(context)
	const safeStandaloneMessage = typeof message === 'string'
		? boundedDiagnosticText(message, MAX_FORMATTED_ERROR_MESSAGE)
		: 'Error'
	if (!context || typeof context !== 'object' || nativeArrayIsArray(context)) return safeStandaloneMessage
	const fields: string[] = []
	let scanned = 0
	let fieldCharacters = 0
	try {
		if (!hasSafePrototypeChain(context)) return safeStandaloneMessage
		for (const key in context) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(context, key)
			if (!descriptor) break
			if (++scanned > MAX_ERROR_CONTEXT_SCAN || fields.length >= MAX_ERROR_CONTEXT_FIELDS) break
			if (descriptor && 'value' in descriptor) containNativePromiseUnchecked(descriptor.value)
			if (key.length === 0 || key.length > MAX_ERROR_CONTEXT_KEY
				|| key === '__proto__' || key === 'prototype' || key === 'constructor') continue
			if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') continue
			const safeKey = boundedDiagnosticText(key, MAX_ERROR_CONTEXT_KEY)
			const safeValue = boundedDiagnosticText(descriptor.value, MAX_ERROR_CONTEXT_VALUE)
			const field = `${safeKey}=${safeValue}`
			const separatorLength = fields.length > 0 ? 2 : 0
			if (fieldCharacters + separatorLength + field.length > MAX_FORMATTED_ERROR_MESSAGE / 2 - 4) break
			nativeReflectApply(nativeArrayPush, fields, [field])
			fieldCharacters += separatorLength + field.length
		}
	} catch { /* Return the safely captured prefix. */ }
	if (fields.length === 0) return safeStandaloneMessage
	const safeMessage = boundedDiagnosticText(safeStandaloneMessage, MAX_FORMATTED_ERROR_MESSAGE / 2)
	return `${safeMessage} (${nativeReflectApply(nativeArrayJoin, fields, [', ']) as string})`
}
