/**
 * Capture a callable capability without evaluating accessors. Logging accepts
 * user supplied clocks, lifecycle ports and sinks, so ordinary property access
 * at these boundaries can otherwise execute arbitrary getters during setup.
 */
export function captureLoggingMethod<T>(
	value: unknown,
	key: PropertyKey
): T | undefined {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	let current: object | null = value as object
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) {
				return 'value' in descriptor && typeof descriptor.value === 'function'
					? descriptor.value as T
					: undefined
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch {
		return undefined
	}
	return undefined
}

/** Observe an invalid async result returned by a sync logging capability. */
export function observeLoggingThenable(value: unknown): boolean {
	if (!captureLoggingMethod(value, 'then')) return false
	void Promise.resolve(value).catch(() => undefined)
	return true
}

/** Read a data property without invoking a getter. */
export function readLoggingDataProperty<T>(value: unknown, key: PropertyKey): T | undefined {
	const inspected = inspectLoggingProperty<T>(value, key)
	return inspected.safe ? inspected.value : undefined
}

export function inspectLoggingProperty<T>(
	value: unknown,
	key: PropertyKey
): {found: boolean; safe: boolean; value?: T} {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
		return {found: false, safe: true}
	}
	let current: object | null = value as object
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) return 'value' in descriptor
				? {found: true, safe: true, value: descriptor.value as T}
				: {found: true, safe: false}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch {
		return {found: true, safe: false}
	}
	return {found: false, safe: true}
}

/** Accept only records whose prototype cannot attach serialization behavior. */
export function isPlainLoggingObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	try {
		const prototype = Object.getPrototypeOf(value)
		return prototype === Object.prototype || prototype === null
	} catch {
		return false
	}
}
