import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CacheBackendPort, CacheRedisPort} from '@ooopsstudio/core/ports/cache'

function readDataProperty(source: object, name: PropertyKey, label: string): unknown {
	let current: object | null = source
	try {
		for (let depth = 0; current && depth < 16; depth++) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if (!('value' in descriptor)) throw new Error()
				return descriptor.value
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { throw new Error(`${label} is not a readable data property`) }
	return undefined
}

/** Capture a callable capability once without invoking accessor-backed properties. */
export function captureCacheCapability<TArguments extends unknown[], TResult>(
	source: unknown,
	name: PropertyKey
): ((...arguments_: TArguments) => TResult) | undefined {
	if ((typeof source !== 'object' && typeof source !== 'function') || source === null) return undefined
	try {
		const value = readDataProperty(source, name, `Cache capability ${String(name)}`)
		if (typeof value !== 'function') return undefined
		const method = value as (...arguments_: TArguments) => TResult
		return (...arguments_: TArguments) => Reflect.apply(method, source, arguments_)
	} catch { return undefined }
}

function bindMethod<T extends (...args: never[]) => unknown>(
	source: object,
	name: PropertyKey,
	label: string,
	required: boolean
): T | undefined {
	const value = readDataProperty(source, name, label)
	if (value === undefined && !required) return undefined
	if (typeof value !== 'function') throw new Error(`${label} must be a function${required ? '' : ' when provided'}`)
	return value.bind(source) as T
}

/** Snapshot a clock capability so caller mutation cannot split cache time domains. */
export function bindCacheClock(source: unknown, label: string): Clock {
	if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`${label} requires a clock`)
	const now = bindMethod<Clock['now']>(source, 'now', `${label} clock now`, true)
	return Object.freeze({now: now!})
}

/** Snapshot an external backend's callable surface once, preserving method receivers. */
export function bindCacheBackendPort(source: unknown): CacheBackendPort {
	if (!source || typeof source !== 'object' || Array.isArray(source)) {
		throw new Error('Cache requires a complete backend')
	}
	const requiredNames = ['get', 'getMany', 'set', 'setMany', 'delete', 'invalidate'] as const
	type RequiredName = (typeof requiredNames)[number]
	const required = Object.create(null) as Record<RequiredName, (...args: never[]) => unknown>
	for (const methodName of requiredNames) {
		const method = readDataProperty(source, methodName, `Cache backend ${methodName}`)
		if (typeof method !== 'function') throw new Error('Cache requires a complete backend')
		required[methodName] = method.bind(source) as (...args: never[]) => unknown
	}
	const flush = bindMethod<NonNullable<CacheBackendPort['flush']>>(source, 'flush', 'Cache backend flush', false)
	const shutdown = bindMethod<NonNullable<CacheBackendPort['shutdown']>>(source, 'shutdown', 'Cache backend shutdown', false)
	return Object.freeze({
		...required,
		...(flush ? {flush} : {}),
		...(shutdown ? {shutdown} : {})
	}) as CacheBackendPort
}

/** Snapshot Redis transport methods so accessors or later mutation cannot bypass validation. */
export function bindCacheRedisPort(source: unknown): CacheRedisPort {
	if (!source || typeof source !== 'object' || Array.isArray(source)) {
		throw new Error('Production cache Redis requires eval() support')
	}
	const rawEvaluate = readDataProperty(source, 'eval', 'Production cache Redis eval()')
	if (typeof rawEvaluate !== 'function') throw new Error('Production cache requires an eval() primitive')
	const evaluate = rawEvaluate.bind(source) as CacheRedisPort['eval']
	return Object.freeze({eval: evaluate})
}
