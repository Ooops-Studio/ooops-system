import {isRateLimitProxy} from '../utils/safe-object'

export function snapshotRateLimitOptions<T extends object>(
	value: unknown,
	allowed: ReadonlySet<string>,
	label: string
): T {
	if (!value || typeof value !== 'object' || isRateLimitProxy(value) || Array.isArray(value)) throw new TypeError(`${label} options must be a plain object`)
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		const snapshot = Object.create(null) as Record<string, unknown>
		for (const [key, descriptor] of Object.entries(descriptors)) snapshot[key] = descriptor.value
		return Object.freeze(snapshot) as T
	} catch {
		throw new TypeError(`${label} options contain invalid, accessor-backed, or unexpected fields`)
	}
}
