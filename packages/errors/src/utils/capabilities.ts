export type ErrorRuntimeMethod = (...args: unknown[]) => unknown

export interface ErrorCapability {
	readonly present: boolean
	readonly method?: ErrorRuntimeMethod
}

/**
 * Reads a method without invoking accessors. Prototype methods remain
 * supported, while hostile proxies and accessor-backed capabilities are
 * treated as unavailable.
 */
export function inspectErrorCapability(value: unknown, key: PropertyKey): ErrorCapability {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return {present: false}
	let current: object | null = value as object
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) {
				if (!('value' in descriptor)) return {present: true}
				return typeof descriptor.value === 'function'
					? {present: true, method: descriptor.value as ErrorRuntimeMethod}
					: {present: true}
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch {
		return {present: true}
	}
	return {present: false}
}

export function captureErrorCapability(value: unknown, key: PropertyKey): ErrorRuntimeMethod | undefined {
	return inspectErrorCapability(value, key).method
}
