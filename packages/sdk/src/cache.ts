import type {CacheLoadOptions} from '@ooopsstudio/core/contracts/cache'
import type {CacheServicePort} from '@ooopsstudio/core/ports/cache'
import {createStableHasher} from '@ooopsstudio/core/utils/hashing/stable-hash'

import {runBoundedRuntimeReflection} from './reflection-flight'
import {isRuntimeProxy} from './runtime-object'

const MAX_CACHE_KEY_PART_DEPTH = 8
const MAX_CACHE_KEY_PART_NODES = 256
const MAX_CACHE_KEY_PART_BYTES = 64 * 1024
const MAX_CACHE_KEY_PREFIX_BYTES = 256
const keyPartEncoder = new TextEncoder()
const CACHE_NAMESPACE_OPTION_FIELDS = new Set([
	'namespace', 'version', 'ttlMs', 'staleTtlMs', 'negativeTtlMs', 'staleIfError'
])

function captureCacheCallback<TArguments extends unknown[], TResult>(
	callback: (...arguments_: TArguments) => TResult,
	receiver?: unknown
): (...arguments_: TArguments) => TResult {
	let activeCalls = 0
	let calls = 0
	return (...arguments_: TArguments): TResult => {
		if (!activeCalls) calls = 0
		if (calls++ >= 100) return undefined as TResult
		activeCalls++
		let result: TResult
		try { result = runBoundedRuntimeReflection(() => Reflect.apply(callback, receiver, arguments_)) }
		finally { activeCalls-- }
		try { void Reflect.apply(Promise.prototype.then, result, [undefined, () => undefined]) } catch { /* non-Promise */ }
		return result
	}
}

function captureCacheMethod<TArguments extends unknown[], TResult>(
	target: unknown,
	key: PropertyKey
): ((...arguments_: TArguments) => TResult) | undefined {
	if ((typeof target !== 'object' && typeof target !== 'function') || target === null || isRuntimeProxy(target)) return undefined
	try {
		return runBoundedRuntimeReflection(() => {
			let owner: object | null = target
			for (let depth = 16; owner && depth--;) {
				if (isRuntimeProxy(owner)) return undefined
				const descriptor = Object.getOwnPropertyDescriptor(owner, key)
				if (descriptor) {
					if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
					const method = descriptor.value as (...arguments_: TArguments) => TResult
					return captureCacheCallback(method, target)
				}
				owner = Object.getPrototypeOf(owner) as object | null
			}
			return undefined
		})
	} catch { return undefined }
}

function validateCacheNamespaceComponent(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
	let invalid = value.length === 0 || value.length > 256
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code < 32 || code === 127) { invalid = true; break }
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++index)
			if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
				throw new Error(`${label} contains invalid Unicode`)
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) throw new Error(`${label} contains invalid Unicode`)
	}
	if (invalid) throw new Error(`${label} must be 1-256 safe characters`)
}

function snapshotNamespaceDefaults<T extends Partial<CacheLoadOptions>>(
	value: T | undefined,
	stripVersion = false
): T | undefined {
	if (value === undefined) return undefined
	if (!value || typeof value !== 'object' || Array.isArray(value) || isRuntimeProxy(value)) {
		throw new TypeError('Cache namespace defaults must be a plain object')
	}
	const {prototype, keys} = runBoundedRuntimeReflection(() => ({
		prototype: Object.getPrototypeOf(value),
		keys: Reflect.ownKeys(value)
	}))
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('Cache namespace defaults must be a plain object')
	}
	if (keys.length > CACHE_NAMESPACE_OPTION_FIELDS.size
		|| keys.some((key) => typeof key !== 'string' || !CACHE_NAMESPACE_OPTION_FIELDS.has(key))) {
		throw new TypeError('Cache namespace defaults contain invalid or unexpected fields')
	}
	const snapshot = Object.create(null) as Record<string, unknown>
	for (const key of keys as string[]) {
		const descriptor = runBoundedRuntimeReflection(() => Object.getOwnPropertyDescriptor(value, key))
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new TypeError('Cache namespace defaults must contain enumerable data properties')
		}
		const current = descriptor.value
		if (current !== undefined && key !== 'namespace' && (!stripVersion || key !== 'version')) snapshot[key] = current
	}
	if (snapshot.namespace !== undefined) validateCacheNamespaceComponent(snapshot.namespace, 'Cache namespace')
	if (snapshot.version !== undefined) validateCacheNamespaceComponent(snapshot.version, 'Cache version')
	for (const [key, label] of [
		['ttlMs', 'Cache ttlMs'],
		['staleTtlMs', 'Cache staleTtlMs'],
		['negativeTtlMs', 'Cache negativeTtlMs']
	] as const) {
		const current = snapshot[key]
		if (current !== undefined && (!Number.isSafeInteger(current) || Number(current) <= 0 || Number(current) > 2_147_483_647)) {
			throw new Error(`${label} must be between 1 and 2147483647 milliseconds`)
		}
	}
	for (const key of ['staleIfError'] as const) {
		if (snapshot[key] !== undefined && typeof snapshot[key] !== 'boolean') {
			throw new TypeError(`Cache ${key} must be a boolean`)
		}
	}
	if (snapshot.staleTtlMs !== undefined && snapshot.ttlMs === undefined) throw new Error('Cache staleTtlMs requires ttlMs')
	return Object.freeze(snapshot) as T
}

function snapshotCacheKeyParts(value: unknown): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || isRuntimeProxy(value)) {
		throw new TypeError('Cache key parts must be a plain object')
	}
	const ancestors = new WeakSet<object>()
	let nodes = 0
	let bytes = 0
	const addBytes = (text: string): void => {
		if (text.length > MAX_CACHE_KEY_PART_BYTES) throw new RangeError('Cache key parts exceed the byte limit')
		bytes += keyPartEncoder.encode(text).byteLength
		if (!Number.isSafeInteger(bytes) || bytes > MAX_CACHE_KEY_PART_BYTES) {
			throw new RangeError('Cache key parts exceed the byte limit')
		}
	}
	const visit = (current: unknown, depth: number): unknown => {
		if (++nodes > MAX_CACHE_KEY_PART_NODES) throw new RangeError('Cache key parts exceed the structural node limit')
		if (depth > MAX_CACHE_KEY_PART_DEPTH) throw new RangeError('Cache key parts exceed the depth limit')
		if (current === null || typeof current === 'boolean') return current
		if (typeof current === 'string') { addBytes(current); return current }
		if (typeof current === 'number') {
			if (!Number.isFinite(current)) throw new TypeError('Cache key parts must contain only finite numbers')
			return current
		}
		if (current === undefined || typeof current === 'bigint'
			|| typeof current === 'function' || typeof current === 'symbol') {
			throw new TypeError('Cache key parts must contain only JSON-compatible values')
		}
		if (typeof current !== 'object' || isRuntimeProxy(current)) {
			throw new TypeError('Cache key parts must contain only JSON-compatible values')
		}
		if (ancestors.has(current)) throw new TypeError('Cache key parts must not contain circular references')
		const isArray = Array.isArray(current)
		const {prototype, length} = runBoundedRuntimeReflection(() => ({
			prototype: Object.getPrototypeOf(current),
			length: isArray ? Object.getOwnPropertyDescriptor(current, 'length')?.value : undefined
		}))
		if (!isArray && prototype !== Object.prototype && prototype !== null) {
			throw new TypeError('Cache key parts must contain only plain objects and arrays')
		}
		ancestors.add(current)
		try {
			if (isArray && (!Number.isSafeInteger(length) || (length as number) < 0
				|| (length as number) > MAX_CACHE_KEY_PART_NODES - nodes)) {
				throw new RangeError('Cache key parts exceed the structural node limit')
			}
			const ownKeys = runBoundedRuntimeReflection(() => Reflect.ownKeys(current))
			if (ownKeys.some((key) => typeof key !== 'string')) {
				throw new TypeError('Cache key parts must not contain symbol keys')
			}
			if (isArray) {
				const result: unknown[] = []
				for (let index = 0; index < (length as number); index++) {
					const descriptor = runBoundedRuntimeReflection(() => Object.getOwnPropertyDescriptor(current, String(index)))
					if (!descriptor?.enumerable || !('value' in descriptor)) {
						throw new TypeError('Cache key parts must not contain sparse arrays')
					}
					result.push(visit(descriptor.value, depth + 1))
				}
				const allowed = new Set(['length', ...result.map((_item, index) => String(index))])
				if (ownKeys.some((key) => !allowed.has(String(key)))) {
					throw new TypeError('Cache key arrays must not contain custom properties')
				}
				return Object.freeze(result)
			}
			if (ownKeys.length > MAX_CACHE_KEY_PART_NODES - nodes) {
				throw new RangeError('Cache key parts exceed the structural node limit')
			}
			const result = Object.create(null) as Record<string, unknown>
			for (const key of ownKeys as string[]) {
				const descriptor = runBoundedRuntimeReflection(() => Object.getOwnPropertyDescriptor(current, key))
				if (!descriptor?.enumerable || !('value' in descriptor)) {
					throw new TypeError('Cache key parts must contain enumerable data properties')
				}
				addBytes(key)
				result[key] = visit(descriptor.value, depth + 1)
			}
			return Object.freeze(result)
		} finally { ancestors.delete(current) }
	}
	return visit(value, 0) as Readonly<Record<string, unknown>>
}

export interface CacheNamespaceDefinition<
	TValue = unknown,
	TLoadOptions extends Partial<CacheLoadOptions> = Partial<CacheLoadOptions>
> {
	readonly name: string
	readonly defaults?: Omit<TLoadOptions, 'namespace'>
	readonly __value?: TValue
}

export function defineCacheNamespace<
	TValue = unknown,
	TLoadOptions extends Partial<CacheLoadOptions> = Partial<CacheLoadOptions>
>(
	name: string,
	defaults?: TLoadOptions
): CacheNamespaceDefinition<TValue, TLoadOptions> {
	validateCacheNamespaceComponent(name, 'Cache namespace')
	const defaultsSnapshot = snapshotNamespaceDefaults(defaults)
	const definition = {
		name,
		...(defaultsSnapshot ? {defaults: defaultsSnapshot} : {})
	}
	return Object.freeze(definition)
}

export function createCacheKeyBuilder(prefix?: string | ((parts: Readonly<Record<string, unknown>>) => string)) {
	if (prefix !== undefined && typeof prefix !== 'string' && typeof prefix !== 'function') {
		throw new TypeError('Cache key builder prefix must be a string or function')
	}
	if (typeof prefix === 'string') {
		if (prefix.length > MAX_CACHE_KEY_PREFIX_BYTES
			|| keyPartEncoder.encode(prefix).byteLength > MAX_CACHE_KEY_PREFIX_BYTES) {
			throw new RangeError('Cache key builder prefix exceeds the byte limit')
		}
	}
	const hasher = createStableHasher()
	const secondHasher = createStableHasher({seed: 0x9e37_79b9})
	const safePrefix = typeof prefix === 'function'
		? captureCacheCallback(prefix)
		: undefined
	let invalidPrefixResult = false
	const validateBuiltKey = (key: unknown): string => {
		if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
			throw new RangeError('Cache key builders must return 1-256 characters')
		}
		for (let index = 0; index < key.length; index++) {
			const code = key.charCodeAt(index)
			if (code < 32 || code === 127) throw new Error('Cache key builders must return safe characters')
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = key.charCodeAt(++index)
				if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
					throw new Error('Cache key builders must return valid Unicode')
				}
			} else if (code >= 0xdc00 && code <= 0xdfff) {
				throw new Error('Cache key builders must return valid Unicode')
			}
		}
		return key
	}
	const build = (parts: Readonly<Record<string, unknown>>): string => {
		const snapshot = snapshotCacheKeyParts(parts)
		const serializedSnapshot = hasher.stringify(snapshot)
		if (serializedSnapshot.length > MAX_CACHE_KEY_PART_BYTES
			|| keyPartEncoder.encode(serializedSnapshot).byteLength > MAX_CACHE_KEY_PART_BYTES) {
			throw new RangeError('Cache key parts exceed the byte limit')
		}
		if (safePrefix) {
			if (invalidPrefixResult) throw new TypeError('Cache key builder callback returned an invalid value')
			const key = safePrefix(snapshot)
			if (typeof key !== 'string') invalidPrefixResult = true
			return validateBuiltKey(key)
		}
		const keys = Object.keys(snapshot).sort()
		if (keys.length > 50) throw new RangeError('Cache key builders accept at most 50 fields')
		const flattened = keys.map((key) => {
			const safeKey = /^[a-z][a-z0-9_-]{0,31}$/iu.test(key)
				? key
				: `field-${hasher.hash(key)}${secondHasher.hash(key)}`
			return `${safeKey}:${hasher.hash(snapshot[key])}${secondHasher.hash(snapshot[key])}`
		})
		const readableLength = flattened.reduce((length, part) => length + part.length + 1, prefix?.length ?? -1)
		const readable = readableLength > 0 && readableLength <= 256
			? [prefix, ...flattened].filter(Boolean).join(':')
			: ''
		if (readable.length > 0 && readable.length <= 256) return validateBuiltKey(readable)
		const bounded = `key:${hasher.hash(prefix)}${secondHasher.hash(prefix)}:${hasher.hashString(serializedSnapshot)}${secondHasher.hashString(serializedSnapshot)}`
		return validateBuiltKey(bounded)
	}
	let activeBuilds = 0
	let buildCalls = 0
	return (parts: Readonly<Record<string, unknown>>): string => {
		if (!activeBuilds) buildCalls = 0
		if (buildCalls++ >= 100) return undefined as never
		activeBuilds++
		try { return build(parts) } finally { activeBuilds-- }
	}
}

export function bindCacheNamespace<TValue, TLoadOptions extends Partial<CacheLoadOptions>>(
	cache: CacheServicePort,
	definition: CacheNamespaceDefinition<TValue, TLoadOptions>
) {
	if (!definition || typeof definition !== 'object' || Array.isArray(definition) || isRuntimeProxy(definition)) {
		throw new TypeError('Cache namespace definition must be an object')
	}
	let name: unknown
	let defaults: unknown
	try {
		const {prototype, keys} = runBoundedRuntimeReflection(() => ({
			prototype: Object.getPrototypeOf(definition),
			keys: Reflect.ownKeys(definition)
		}))
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		if (keys.length > 2
			|| keys.some((key) => typeof key !== 'string' || (key !== 'name' && key !== 'defaults'))) throw new TypeError()
		for (const key of keys as string[]) {
			const descriptor = runBoundedRuntimeReflection(() => Object.getOwnPropertyDescriptor(definition, key))
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError()
			if (key === 'name') name = descriptor.value
			else defaults = descriptor.value
		}
		if (name === undefined) throw new TypeError()
	} catch {
		throw new TypeError('Cache namespace definition contains invalid or unexpected fields')
	}
	const safeDefinition = defineCacheNamespace<TValue, TLoadOptions>(
		name as string,
		defaults as TLoadOptions | undefined
	)
	const namespace = captureCacheMethod<Parameters<CacheServicePort['namespace']>, ReturnType<CacheServicePort['namespace']>>(
		cache,
		'namespace'
	)
	if (!namespace) throw new TypeError('Cache service must provide a namespace method')
	const scoped = namespace(
		safeDefinition.name,
		safeDefinition.defaults as Partial<CacheLoadOptions> | undefined
	)
	const get = captureCacheMethod<Parameters<CacheServicePort['get']>, ReturnType<CacheServicePort['get']>>(scoped, 'get')
	const load = captureCacheMethod<Parameters<CacheServicePort['load']>, ReturnType<CacheServicePort['load']>>(scoped, 'load')
	if (!get || !load) throw new TypeError('Namespaced cache service must provide get and load methods')
	return {
		get: (key: string) => get(key) as Promise<TValue | undefined>,
		load: (
			key: string,
			loader: () => Promise<TValue>,
			options?: Omit<TLoadOptions, 'namespace' | 'version'>
		) => {
			let operation: Promise<TValue> | undefined
			const invokeOnce = (): Promise<TValue> => {
				operation ??= Promise.resolve().then(loader)
				return operation
			}
			return load(key, invokeOnce, snapshotNamespaceDefaults(
				options as Partial<CacheLoadOptions> | undefined, true
			)) as Promise<TValue | undefined>
		}
	}
}
