import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {ManagedRateLimit} from '@ooopsstudio/core/ports/ratelimit'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomRateLimitOptions} from './public/custom'
import type {DevelopmentRateLimitOptions} from './public/development'
import type {ProductionRateLimitOptions} from './public/production'
import {isRateLimitProxy} from './utils/safe-object'

type DistributedOmit<T, TKeys extends PropertyKey> = T extends unknown ? Omit<T, TKeys> : never
type Injected = 'clock' | 'lifecycle'

export type RateLimitOptions =
	| {readonly preset: 'development'; readonly options?: Omit<DevelopmentRateLimitOptions, 'clock' | 'lifecycle'>}
	| {readonly preset: 'production'; readonly options: Omit<ProductionRateLimitOptions, Injected>}
	| {readonly preset: 'custom'; readonly options: DistributedOmit<CustomRateLimitOptions, Injected>}

const registrationsInProgress = new WeakSet<object>()

interface BoundRateLimitContainer {
	readonly identity: object
	readonly bind: (token: symbol, value: unknown) => void
	readonly unbind?: (token: symbol) => boolean
	readonly get: (token: symbol) => unknown
	readonly tryGet: (token: symbol) => unknown
	readonly has: (token: symbol) => boolean
}

function captureMethod<TArguments extends unknown[], TResult>(
	source: object,
	name: PropertyKey
): ((...args: TArguments) => TResult) | undefined {
	if (isRateLimitProxy(source)) return undefined
	let current: object | null = source
	try {
		for (let depth = 0; current && depth < 16; depth++) {
			if (isRateLimitProxy(current)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...args: TArguments) => TResult
				return (...args: TArguments) => Reflect.apply(method, source, args)
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function bindRateLimitContainer(container: Container): BoundRateLimitContainer {
	if (!container || typeof container !== 'object' || isRateLimitProxy(container)) throw new TypeError('Rate limit registration requires a container')
	const bind = captureMethod<[symbol, unknown], void>(container, 'bind')
	const unbind = captureMethod<[symbol], boolean>(container, 'unbind')
	const get = captureMethod<[symbol], unknown>(container, 'get')
	const tryGet = captureMethod<[symbol], unknown>(container, 'tryGet')
	const has = captureMethod<[symbol], boolean>(container, 'has')
	if (!bind || !get || !tryGet || !has) throw new TypeError('Rate limit registration requires a valid container')
	return {identity: container, bind, ...(unbind ? {unbind} : {}), get, tryGet, has}
}

function snapshotRegistration(value: unknown): RateLimitOptions {
	if (!value || typeof value !== 'object' || isRateLimitProxy(value) || Array.isArray(value)) throw new TypeError('Rate limit registration config must be an object')
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || (key !== 'preset' && key !== 'options'))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		const preset = descriptors.preset?.value
		if (preset !== 'development' && preset !== 'production' && preset !== 'custom') throw new Error(`Unknown rate limit preset: ${String(preset)}`)
		const rawOptions = descriptors.options?.value
		if (rawOptions === undefined) {
			if (preset !== 'development') throw new TypeError(`Rate limit ${preset} registration requires options`)
			return {preset}
		}
		if (!rawOptions || typeof rawOptions !== 'object' || isRateLimitProxy(rawOptions) || Array.isArray(rawOptions)) throw new TypeError()
		const optionsPrototype = Object.getPrototypeOf(rawOptions)
		if (optionsPrototype !== Object.prototype && optionsPrototype !== null) throw new TypeError()
		const optionDescriptors = Object.getOwnPropertyDescriptors(rawOptions)
		if (Object.values(optionDescriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		const options = Object.create(null) as Record<string, unknown>
		for (const [key, descriptor] of Object.entries(optionDescriptors)) options[key] = descriptor.value
		return {preset, options} as RateLimitOptions
	} catch(error) {
		if (error instanceof Error && (error.message.startsWith('Unknown rate limit preset:') || error.message.endsWith('registration requires options'))) throw error
		throw new TypeError('Rate limit registration config contains invalid or accessor-backed fields')
	}
}

export async function registerRateLimit(container: Container, config: RateLimitOptions): Promise<void> {
	const boundContainer = bindRateLimitContainer(container)
	if (registrationsInProgress.has(boundContainer.identity)) throw new Error('RATE_LIMIT_ALREADY_REGISTERED')
	registrationsInProgress.add(boundContainer.identity)
	try {
		await registerRateLimitOnce(boundContainer, snapshotRegistration(config))
	} finally { registrationsInProgress.delete(boundContainer.identity) }
}

async function registerRateLimitOnce(container: BoundRateLimitContainer, snapshot: RateLimitOptions): Promise<void> {
	if (container.has(TOK.RateLimit)) throw new Error('RATE_LIMIT_ALREADY_REGISTERED')
	const unbind = container.unbind
	if (!unbind) throw new TypeError('Rate limit registration requires a reversible container')
	const lifecycle = container.tryGet(TOK.Lifecycle) as LifecyclePort | undefined
	const common = {
		clock: container.get(TOK.Clock) as Clock,
		...(lifecycle ? {lifecycle} : {})
	}
	let runtime: ManagedRateLimit
	if (snapshot.preset === 'development') {
		runtime = (await import('./public/development')).createDevelopmentRateLimit({...snapshot.options, ...common})
	} else if (snapshot.preset === 'production') {
		runtime = (await import('./public/production')).createProductionRateLimit({...snapshot.options, ...common})
	} else {
		const options = snapshot.options as DistributedOmit<CustomRateLimitOptions, Injected>
		runtime = (await import('./public/custom')).createCustomRateLimit({...options, ...common} as CustomRateLimitOptions)
	}
	let bindingPhaseStarted = false
	try {
		if (container.has(TOK.RateLimit)) throw new Error('RATE_LIMIT_REGISTERED_DURING_CREATION')
		bindingPhaseStarted = true
		container.bind(TOK.RateLimit, runtime)
		if (container.tryGet(TOK.RateLimit) !== runtime) throw new Error('Rate limit container did not retain the runtime')
	} catch(error) {
		const failures: unknown[] = []
		try {
			if (bindingPhaseStarted && container.has(TOK.RateLimit)) unbind(TOK.RateLimit)
			if (bindingPhaseStarted && container.has(TOK.RateLimit)) throw new Error('Rate limit rollback could not remove binding')
		} catch(cleanupError) { failures.push(cleanupError) }
		try { await runtime.shutdown() } catch(cleanupError) { failures.push(cleanupError) }
		if (failures.length) throw new AggregateError([error, ...failures], 'Rate limit registration and rollback failed')
		throw error
	}
}

export * from './public/types'
