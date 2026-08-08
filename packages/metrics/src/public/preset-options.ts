import {ConfigValidationError} from '../utils/config-validation'

export function snapshotPresetOptions(
	value: unknown,
	allowedFields: ReadonlySet<string>,
	label: string
): Record<string, unknown> {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null
			|| Object.getOwnPropertySymbols(value).length > 0) throw new Error()
		const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (key.length > 128 || !allowedFields.has(key)
				|| !descriptor.enumerable || !('value' in descriptor)) throw new Error()
			snapshot[key] = descriptor.value
		}
		return snapshot
	} catch {
		throw new ConfigValidationError(`${label} must contain only stable known data fields`)
	}
}
