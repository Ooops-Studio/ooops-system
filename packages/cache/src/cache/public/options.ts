export function snapshotCachePresetOptions<T extends object>(
	value: unknown,
	allowedFields: ReadonlySet<string>,
	label: string
): T {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} options must be a plain object`)
	}
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.some((key) => typeof key !== 'string' || !allowedFields.has(key))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
			throw new TypeError()
		}
		const snapshot = Object.create(null) as Record<string, unknown>
		for (const key of keys as string[]) snapshot[key] = descriptors[key]!.value
		return Object.freeze(snapshot) as T
	} catch {
		throw new TypeError(`${label} options contain invalid or unexpected fields`)
	}
}
