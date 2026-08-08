/** Inspect a plain object without evaluating accessors or proxy-backed fields. */
export function getPlainDataDescriptors(value: unknown, maximumFields = 64): PropertyDescriptorMap | undefined {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return undefined
		const keys = Reflect.ownKeys(value)
		if (keys.length > maximumFields) return undefined
		const descriptors: PropertyDescriptorMap = Object.create(null) as PropertyDescriptorMap
		for (const key of keys) {
			if (typeof key !== 'string') return undefined
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
			descriptors[key] = descriptor
		}
		return descriptors
	} catch {
		return undefined
	}
}

export function copyDataDescriptorValues(descriptors: PropertyDescriptorMap): Record<string, unknown> {
	const snapshot = Object.create(null) as Record<string, unknown>
	for (const [key, descriptor] of Object.entries(descriptors)) snapshot[key] = descriptor.value
	return snapshot
}
