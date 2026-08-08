import {types as utilTypes} from 'node:util'

import {
	addNativeWeakSet,
	hasNativeWeakSet
} from '../runtime/collections/native-collections'

const nativeIsProxy = utilTypes.isProxy
const nativeReflectApply = Reflect.apply
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const NativeWeakSet = WeakSet

/** Detect proxies before enumeration can materialize an attacker-controlled,
 * unbounded property list or execute an enumeration trap. */
export function isProxyObject(value: unknown): boolean {
	return ((typeof value === 'object' && value !== null) || typeof value === 'function')
		&& nativeReflectApply(nativeIsProxy, utilTypes, [value])
}

/** Prove that bounded prototype traversal cannot reach a Proxy or a cycle. */
export function hasSafePrototypeChain(value: unknown, maximumDepth = 32): value is object {
	if ((!value || typeof value !== 'object') && typeof value !== 'function') return false
	let current: object | null = value as object
	const seen = new NativeWeakSet<object>()
	try {
		for (let depth = 0; current && depth < maximumDepth; depth += 1) {
			if (isProxyObject(current) || hasNativeWeakSet(seen, current)) return false
			addNativeWeakSet(seen, current)
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
		return current === null
	} catch { return false }
}
