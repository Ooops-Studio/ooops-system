type CapabilityMethod = (...arguments_: never[]) => unknown

function isObject(value: unknown): value is object {
	return value !== null && (typeof value === 'object' || typeof value === 'function')
}

export function captureBridgeMethod<T extends CapabilityMethod>(
	target: unknown,
	key: PropertyKey
): T | undefined {
	if (!isObject(target)) return undefined
	try {
		let owner: object | null = target
		for (let depth = 0; owner && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				return ((...arguments_: never[]) =>
					Reflect.apply(descriptor.value, target, arguments_)) as T
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { /* hostile capability */ }
	return undefined
}

export function snapshotBridgeOptions<T extends readonly string[]>(
	value: unknown,
	fields: T
): Readonly<Partial<Record<T[number], unknown>>> {
	if (!isObject(value) || Array.isArray(value)) return Object.freeze({})
	const result = Object.create(null) as Partial<Record<T[number], unknown>>
	try {
		const allowed = new Set<string>(fields)
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError('BRIDGE_OPTIONS_INVALID')
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('BRIDGE_OPTIONS_INVALID')
			;(result as Record<string, unknown>)[key] = descriptor.value
		}
	} catch(error) {
		if (error instanceof TypeError && error.message === 'BRIDGE_OPTIONS_INVALID') throw error
		throw new TypeError('BRIDGE_OPTIONS_INVALID')
	}
	return Object.freeze(result)
}

export function createBoundedBridgeInvoker<T extends CapabilityMethod>(method: T | undefined): T {
	let pending = false
	return ((...arguments_: never[]) => {
		if (!method || pending) return undefined
		let result: unknown
		try { result = method(...arguments_) } catch { return undefined }
		if (!(result instanceof Promise)) return result
		pending = true
		void result.then(() => { pending = false }, () => { pending = false })
		return undefined
	}) as T
}
