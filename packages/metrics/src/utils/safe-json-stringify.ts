const MAX_JSON_DEPTH = 64

function serialize(value: unknown, ancestors: ReadonlySet<object>, depth: number): string | undefined {
	if (value === null) return 'null'
	if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
	if (typeof value === 'bigint') throw new TypeError('Metrics JSON data must not contain bigint values')
	if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
	if (depth >= MAX_JSON_DEPTH) throw new TypeError('Metrics JSON data exceeds the maximum nesting depth')
	if (ancestors.has(value)) throw new TypeError('Metrics JSON data must not contain cycles')

	let descriptors: PropertyDescriptorMap
	try {
		descriptors = Object.getOwnPropertyDescriptors(value)
	} catch {
		throw new TypeError('Metrics JSON data must expose stable data fields')
	}
	const nextAncestors = new Set(ancestors)
	nextAncestors.add(value)
	if (Array.isArray(value)) {
		const length = descriptors.length?.value
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new TypeError('Metrics JSON arrays must expose a stable length')
		}
		const items: string[] = []
		for (let index = 0; index < length; index += 1) {
			const descriptor = descriptors[String(index)]
			if (descriptor && !('value' in descriptor)) {
				throw new TypeError('Metrics JSON data must expose stable data fields')
			}
			items.push(descriptor
				? serialize(descriptor.value, nextAncestors, depth + 1) ?? 'null'
				: 'null')
		}
		return `[${items.join(',')}]`
	}

	const fields: string[] = []
	for (const key of Object.keys(descriptors)) {
		const descriptor = descriptors[key]
		if (!descriptor?.enumerable) continue
		if (!('value' in descriptor)) throw new TypeError('Metrics JSON data must expose stable data fields')
		const encoded = serialize(descriptor.value, nextAncestors, depth + 1)
		if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`)
	}
	return `{${fields.join(',')}}`
}

/** JSON encoding that never consults inherited properties such as prototype toJSON hooks. */
export function safeJsonStringify(value: unknown): string {
	const encoded = serialize(value, new Set(), 0)
	if (encoded === undefined) throw new TypeError('Metrics JSON root must be serializable')
	return encoded
}
