import {isRuntimePromise, isRuntimeProxy} from './safe-object'

type RuntimeMethod = (...args: unknown[]) => unknown

/** Captures safe methods while permitting only one unresolved integration call. */
export const createSingleFlightMethodCapture = (): ((
	target: unknown,
	key: PropertyKey
) => RuntimeMethod | undefined) => {
	const pendingMethods = new WeakMap<object, Set<PropertyKey>>()
	return (target, key) => {
		if (!target || (typeof target !== 'object' && typeof target !== 'function') || isRuntimeProxy(target)) return undefined
		try {
			let owner: object | null = target
			for (let depth = 0; owner && depth < 16; depth += 1) {
				if (isRuntimeProxy(owner)) return undefined
				const descriptor = Object.getOwnPropertyDescriptor(owner, key)
				if (descriptor) {
					if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
					const method = descriptor.value as RuntimeMethod
					return (...args) => {
						const targetObject = target as object
						const active = pendingMethods.get(targetObject) ?? new Set<PropertyKey>()
						if (active.has(key)) return undefined
						active.add(key)
						pendingMethods.set(targetObject, active)
						const release = () => {
							active.delete(key)
							if (active.size === 0 && pendingMethods.get(targetObject) === active) {
								pendingMethods.delete(targetObject)
							}
						}
						let result: unknown
						try {
							result = Reflect.apply(method, target, args)
						} catch(error) {
							release()
							throw error
						}
						if (isRuntimePromise(result)) {
							try { void Reflect.apply(Promise.prototype.then, result, [release, release]) } catch { release() }
						} else release()
						return result
					}
				}
				owner = Object.getPrototypeOf(owner) as object | null
			}
		} catch { return undefined }
		return undefined
	}
}
