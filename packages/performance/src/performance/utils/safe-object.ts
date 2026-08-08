import {types} from 'node:util'

/** Rejects runtime proxies before any operation that could invoke user traps. */
export const isRuntimeProxy = types.isProxy as (value: unknown) => boolean

/** Recognizes native promises without reading an arbitrary `then` property. */
export const isRuntimePromise = types.isPromise as (value: unknown) => boolean

/** Observes rejections from genuine promises without assimilating arbitrary thenables. */
export const ignoreRuntimePromiseRejection = (value: unknown): void => {
	if (!isRuntimePromise(value)) return
	try {
		void Reflect.apply(Promise.prototype.then, value, [undefined, () => undefined])
	} catch {
		// Observation is best-effort and must remain fail-safe.
	}
}

/** Recognizes native Error values without prototype-chain traversal. */
export const isRuntimeError = types.isNativeError as (value: unknown) => boolean

/** Walks an ordinary prototype chain while stopping before any Proxy hop. */
export const hasSafeRuntimePrototype = (value: unknown, expected: object): boolean => {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
	try {
		let owner: object | null = value
		for (let depth = 0; owner && depth < 32; depth += 1) {
			if (isRuntimeProxy(owner)) return false
			if (owner === expected) return true
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return false }
	return false
}
