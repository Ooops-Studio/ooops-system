import {isRuntimeProxy} from './safe-object'

/** Snapshots a preset's shallow dependency options without invoking accessors. */
export function snapshotPerformancePresetOptions(
	value: unknown,
	allowedFields: ReadonlySet<string>,
	label: string
): Readonly<Record<string, unknown>> {
	try {
		if (!value || typeof value !== 'object' || isRuntimeProxy(value) || Array.isArray(value)) throw new TypeError()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError()
		const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		let inspected = 0
		for (const key in value) {
			if (inspected >= allowedFields.size) throw new TypeError()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (key.length > 64 || !descriptor?.enumerable || !('value' in descriptor) || !allowedFields.has(key)) {
				throw new TypeError()
			}
			inspected += 1
			snapshot[key] = descriptor.value
		}
		return Object.freeze(snapshot)
	} catch {
		throw new TypeError(`${label} must be a closed plain data object`)
	}
}
