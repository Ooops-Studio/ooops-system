import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomCacheOptions} from './public/custom'
import type {DevelopmentCacheOptions} from './public/development'
import type {ProductionCacheOptions} from './public/production'

type Injected = 'clock' | 'lifecycle'
export type CacheOptions =
	| {preset: 'development'; options?: Omit<DevelopmentCacheOptions, Injected>}
	| {preset: 'production'; options: Omit<ProductionCacheOptions, Injected>}
	| {preset: 'custom'; options: Omit<CustomCacheOptions, Injected>}

const registrationsInProgress = new WeakSet<object>()

interface BoundCacheContainer {
	readonly identity: object
	readonly bind: (token: symbol, value: unknown) => void
	readonly unbind?: (token: symbol) => boolean
	readonly get: (token: symbol) => unknown
	readonly tryGet: (token: symbol) => unknown
	readonly has: (token: symbol) => boolean
}

function captureContainerCapability<TArguments extends unknown[], TResult>(
	source: object,
	name: PropertyKey
): ((...arguments_: TArguments) => TResult) | undefined {
	let current: object | null = source
	try {
		for (let depth = 0; current && depth < 16; depth++) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...arguments_: TArguments) => TResult
				return (...arguments_: TArguments) => Reflect.apply(method, source, arguments_)
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function bindCacheContainer(container: Container): BoundCacheContainer {
	if (!container || typeof container !== 'object') throw new Error('Cache registration requires a valid container')
	const bind = captureContainerCapability<[symbol, unknown], void>(container, 'bind')
	const unbind = captureContainerCapability<[symbol], boolean>(container, 'unbind')
	const get = captureContainerCapability<[symbol], unknown>(container, 'get')
	const tryGet = captureContainerCapability<[symbol], unknown>(container, 'tryGet')
	const has = captureContainerCapability<[symbol], boolean>(container, 'has')
	if (!bind || !get || !tryGet || !has) throw new Error('Cache registration requires a valid container')
	return {identity: container, bind, ...(unbind ? {unbind} : {}), get, tryGet, has}
}

function snapshotCacheRegistrationConfig(value: unknown): CacheOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Cache registration config must be an object')
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.some((key) => typeof key !== 'string' || (key !== 'preset' && key !== 'options'))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		const preset = descriptors.preset?.value
		if (preset !== 'development' && preset !== 'production' && preset !== 'custom') {
			throw new Error(`Unknown cache preset: ${typeof preset === 'string' ? preset : 'invalid'}`)
		}
		const rawOptions = descriptors.options?.value
		if (rawOptions === undefined) {
			if (preset !== 'development') throw new TypeError(`Cache ${preset} registration requires options`)
			return {preset}
		}
		if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) throw new TypeError()
		const optionsPrototype = Object.getPrototypeOf(rawOptions)
		if (optionsPrototype !== Object.prototype && optionsPrototype !== null) throw new TypeError()
		const allowed = preset === 'development'
			? new Set(['namespace'])
			: preset === 'production'
				? new Set(['redis', 'namespace'])
				: new Set(['backend', 'defaultNamespace'])
		const optionDescriptors = Object.getOwnPropertyDescriptors(rawOptions)
		const optionKeys = Reflect.ownKeys(optionDescriptors)
		if (optionKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw new TypeError()
		if (Object.values(optionDescriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		const options = Object.create(null) as Record<string, unknown>
		for (const key of optionKeys as string[]) options[key] = optionDescriptors[key]!.value
		return {preset, options} as CacheOptions
	} catch(error) {
		if (error instanceof Error && error.message.startsWith('Unknown cache preset:')) throw error
		if (error instanceof Error && error.message.startsWith('Cache ') && error.message.endsWith(' registration requires options')) throw error
		throw new TypeError('Cache registration config contains invalid or unexpected fields')
	}
}

export async function registerCache(container: Container, config: CacheOptions): Promise<void> {
	const boundContainer = bindCacheContainer(container)
	if (boundContainer.has(TOK.Cache) || registrationsInProgress.has(boundContainer.identity)) throw new Error('cache_already_registered')
	const unbind = boundContainer.unbind
	if (!unbind) throw new Error('Cache registration requires reversible container bindings')
	registrationsInProgress.add(boundContainer.identity)
	try {
		await registerCacheUnlocked(boundContainer, snapshotCacheRegistrationConfig(config), unbind)
	} finally { registrationsInProgress.delete(boundContainer.identity) }
}

async function registerCacheUnlocked(
	container: BoundCacheContainer,
	config: CacheOptions,
	unbind: (token: symbol) => boolean
): Promise<void> {
	const lifecycle = container.tryGet(TOK.Lifecycle) as LifecyclePort | undefined
	const common = {
		clock: container.get(TOK.Clock) as Clock,
		...(lifecycle ? {lifecycle} : {})
	}
	const cache = config.preset === 'development'
		? (await import('./public/development')).createDevelopmentCache({...config.options, ...common})
		: config.preset === 'production'
			? (await import('./public/production')).createProductionCache({...config.options, ...common})
			: (await import('./public/custom')).createCustomCache({...config.options, ...common})
	let bindAttempted = false
	try {
		if (container.has(TOK.Cache)) throw new Error('cache_registered_during_runtime_creation')
		bindAttempted = true
		container.bind(TOK.Cache, cache)
		if (container.tryGet(TOK.Cache) !== cache) {
			throw new Error('Cache container did not retain the registered runtime')
		}
	} catch(error) {
		const cleanupFailures: unknown[] = []
		try {
			if (bindAttempted && container.has(TOK.Cache)) {
				if (!unbind(TOK.Cache) || container.has(TOK.Cache)) {
					throw new Error('Cache registration rollback could not restore the original unbound state')
				}
			}
		} catch(cleanupError) { cleanupFailures.push(cleanupError) }
		try { await cache.shutdown() } catch(cleanupError) { cleanupFailures.push(cleanupError) }
		if (cleanupFailures.length > 0) {
			throw new AggregateError([error, ...cleanupFailures], 'Cache registration and rollback failed')
		}
		throw error
	}
}

// The root family entry is registration/types only. Import factories from subpaths.
export * from './public/types'
