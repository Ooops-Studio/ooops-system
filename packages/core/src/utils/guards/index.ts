/**
 * @file Provides tiny, pure type guards used internally by engines utilities.
 * These guards are used internally and not exported as part of the public API.
 */

import {containNativePromiseUnchecked} from '../../runtime/async/native-promise'
import {isProxyObject} from '../safe-object'
import {serialize} from '../serialization/serialize-error'

const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectPrototype = Object.prototype

/**
 * Tests that a value is a plain object (prototype is Object.prototype or null).
 * @param value the candidate value
 * @returns true when `value` is a plain object
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	containNativePromiseUnchecked(value)
	if (value === null || typeof value !== 'object') return false
	if (isProxyObject(value)) return false
	try {
		const prototype = nativeObjectGetPrototypeOf(value)
		return prototype === nativeObjectPrototype || prototype === null
	} catch { return false }
}

export function safeStringify(v: unknown): string {
	return serialize(v)
}
