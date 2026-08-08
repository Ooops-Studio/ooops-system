import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomPerformanceOptions} from './public/custom'
import type {DevelopmentPerformanceOptions} from './public/development'
import type {ProductionPerformanceOptions} from './public/production'
import type {ManagedPerformance} from './types/ports'
import {ignoreRuntimePromiseRejection, isRuntimeProxy} from './utils/safe-object'

export type PerformanceOptions =
	| {preset: 'development'; options?: Omit<DevelopmentPerformanceOptions, 'clock'>}
	| {preset: 'production'; options?: Omit<ProductionPerformanceOptions, 'clock'>}
	| {preset: 'custom'; options: Omit<CustomPerformanceOptions, 'clock'>}

const registrationsInProgress = new WeakSet<object>()
const ROOT_FIELDS = new Set(['preset', 'options'])
const STANDARD_FIELDS = new Set(['resource', 'errors', 'tracer', 'lifecycle'])
const CUSTOM_FIELDS = new Set([
	...STANDARD_FIELDS, 'budgets', 'n1Detection', 'runtimeMonitoring', 'destinations', 'delivery'
])
const REGISTRATION_CLEANUP_TIMEOUT_MS = 5_000

type ContainerMethod = (...args: never[]) => unknown

const captureContainerMethod = (container: object, key: PropertyKey): ContainerMethod | undefined => {
	if (isRuntimeProxy(container)) return undefined
	let current: object | null = container
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			if (isRuntimeProxy(current)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as ContainerMethod
				return (...args: never[]) => {
					const result = Reflect.apply(method, container, args)
					ignoreRuntimePromiseRejection(result)
					if ((key === 'has' || key === 'unbind') && typeof result !== 'boolean') throw new TypeError()
					if (key === 'bind' && result !== undefined) throw new TypeError()
					return result
				}
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch {
		return undefined
	}
	return undefined
}

const snapshotDataObject = (
	value: unknown,
	label: string,
	allowed: ReadonlySet<string>
): Readonly<Record<string, unknown>> => {
	try {
		if (!value || typeof value !== 'object' || isRuntimeProxy(value) || Array.isArray(value)) throw new TypeError()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError()
		const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		let inspected = 0
		for (const key in value) {
			if (inspected >= allowed.size || key.length > 64 || !allowed.has(key)) throw new TypeError()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError()
			inspected += 1
			snapshot[key] = descriptor.value
		}
		return Object.freeze(snapshot)
	} catch {
		throw new TypeError(`${label} must contain only stable plain data fields`)
	}
}

const snapshotRegistration = (value: unknown): PerformanceOptions => {
	const registration = snapshotDataObject(value, 'Performance registration options', ROOT_FIELDS)
	const preset = registration.preset
	if (preset !== 'development' && preset !== 'production' && preset !== 'custom') {
		throw new Error('Unknown performance preset')
	}
	if (registration.options === undefined) {
		if (preset === 'custom') throw new TypeError('Performance custom registration options are required')
		return Object.freeze({preset})
	}
	const options = snapshotDataObject(
		registration.options,
		`Performance ${preset} options`,
		preset === 'custom' ? CUSTOM_FIELDS : STANDARD_FIELDS
	)
	return Object.freeze({preset, options}) as PerformanceOptions
}

const cleanupPerformance = async(performance: ManagedPerformance): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			(async() => {
				try { await performance.shutdown?.() } catch { await performance.shutdown?.() }
			})(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('performance_registration_cleanup_timeout')),
					REGISTRATION_CLEANUP_TIMEOUT_MS
				)
			})
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

export async function registerPerformance(container: Container, config: PerformanceOptions): Promise<void> {
	if (!container || typeof container !== 'object') {
		throw new TypeError('Performance registration requires a valid container')
	}
	if (registrationsInProgress.has(container)) {
		throw new Error('performance_already_registered')
	}
	registrationsInProgress.add(container)
	try {
		const has = captureContainerMethod(container, 'has') as ((token: symbol) => boolean) | undefined
		const get = captureContainerMethod(container, 'get') as ((token: symbol) => unknown) | undefined
		const tryGet = captureContainerMethod(container, 'tryGet') as ((token: symbol) => unknown) | undefined
		const bind = captureContainerMethod(container, 'bind') as ((token: symbol, value: unknown) => void) | undefined
		const unbind = captureContainerMethod(container, 'unbind') as ((token: symbol) => boolean) | undefined
		if (!has || !get || !tryGet || !bind || !unbind) {
			throw new TypeError('Performance registration requires a valid reversible container')
		}
		let alreadyRegistered: boolean
		try {
			alreadyRegistered = has(TOK.Performance) || tryGet(TOK.Performance) !== undefined
		} catch {
			throw new Error('performance_container_lookup_failed')
		}
		if (alreadyRegistered) throw new Error('performance_already_registered')
		const registration = snapshotRegistration(config)
		await registerPerformanceUnlocked({has, get, tryGet, bind, unbind}, registration)
	} finally {
		registrationsInProgress.delete(container)
	}
}

async function registerPerformanceUnlocked(container: {
	has(token: symbol): boolean
	get(token: symbol): unknown
	tryGet(token: symbol): unknown
	bind(token: symbol, value: unknown): void
	unbind(token: symbol): boolean
}, config: PerformanceOptions): Promise<void> {
	let clock: Clock
	try {
		clock = container.get(TOK.Clock) as Clock
		if (clock === undefined || clock === null) throw new TypeError()
	} catch {
		throw new Error('performance_invalid_clock')
	}
	let errors: Errors | undefined
	let tracer: Tracing | undefined
	let lifecycle: LifecyclePort | undefined
	try {
		errors = container.tryGet(TOK.Errors) as Errors | undefined
		tracer = container.tryGet(TOK.Tracing) as Tracing | undefined
		lifecycle = container.tryGet(TOK.Lifecycle) as LifecyclePort | undefined
	} catch {
		throw new Error('performance_dependency_resolution_failed')
	}
	const presetDependencies = {
		clock,
		...(errors ? {errors} : {}),
		...(tracer ? {tracer} : {}),
		...(lifecycle ? {lifecycle} : {})
	}
	let performance: ManagedPerformance
	if (config.preset === 'development') {
		const {createDevelopmentPerformance} = await import('./public/development')
		performance = await createDevelopmentPerformance({...config.options, ...presetDependencies})
	} else if (config.preset === 'production') {
		const {createProductionPerformance} = await import('./public/production')
		performance = await createProductionPerformance({...config.options, ...presetDependencies})
	} else {
		const {createCustomPerformance} = await import('./public/custom')
		performance = await createCustomPerformance({...config.options, ...presetDependencies})
	}
	let bindAttempted = false
	const hasPerformanceBinding = (): boolean =>
		container.has(TOK.Performance) || container.tryGet(TOK.Performance) !== undefined
	try {
		if (hasPerformanceBinding()) {
			throw new Error('Performance service was registered during runtime creation')
		}
		bindAttempted = true
		container.bind(TOK.Performance, performance)
		if (!container.has(TOK.Performance) || container.tryGet(TOK.Performance) !== performance) {
			throw new Error('Performance container did not retain the expected binding')
		}
	} catch(error) {
		const cleanupErrors: unknown[] = []
		try {
			if (bindAttempted) {
				const retained = container.tryGet(TOK.Performance)
				if (retained === performance) {
					container.unbind(TOK.Performance)
					if (container.tryGet(TOK.Performance) === performance) {
						throw new Error('Performance registration rollback failed')
					}
				}
			}
		} catch(cleanupError) {
			cleanupErrors.push(cleanupError)
		}
		try { await cleanupPerformance(performance) } catch(cleanupError) { cleanupErrors.push(cleanupError) }
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], 'Performance registration and rollback failed')
		}
		throw error
	}
}

export type {DevelopmentPerformanceOptions} from './public/development'
export type {ProductionPerformanceOptions} from './public/production'
export type {CustomPerformanceOptions} from './public/custom'
export type {PerformanceEventExporterPort, PerformancePort} from '@ooopsstudio/core/ports/performance'
export type {ManagedPerformance, PerformanceRuntimeState, PerformanceSinkState, PerformanceStatus} from './types/ports'
