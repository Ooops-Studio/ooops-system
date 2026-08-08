/** Snapshot a public Jobs option record without executing accessors or proxy values. */
export function snapshotJobsOptions<T extends object>(
	value: unknown,
	allowed: ReadonlySet<string>,
	label: string
): T {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	try {
		prototype = Object.getPrototypeOf(value)
		descriptors = Object.getOwnPropertyDescriptors(value)
	} catch { throw new Error(`${label} must expose stable data properties`) }
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain data object`)
	const snapshot: Record<string, unknown> = {}
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`${label} contains unsupported fields`)
		const descriptor = descriptors[key]
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new Error(`${label} must expose stable data properties`)
		}
		snapshot[key] = descriptor.value
	}
	return snapshot as T
}
