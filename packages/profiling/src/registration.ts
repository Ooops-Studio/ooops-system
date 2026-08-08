import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomProfilingOptions, ProductionProfilingOptions, StandardProfilingOptions} from './public/types'
import type {ManagedProfiling} from './types'

export type ProfilingRegistrationOptions =
	| {readonly preset: 'development'; readonly options?: StandardProfilingOptions}
	| {readonly preset: 'production'; readonly options: ProductionProfilingOptions}
	| {readonly preset: 'custom'; readonly options: Omit<CustomProfilingOptions, 'clock'> & {readonly clock?: Clock}}

type StableContainer = Required<Pick<Container, 'bind' | 'unbind' | 'get' | 'tryGet' | 'has'>>
type ContainerMethod = (...args: never[]) => unknown

const registrations = new WeakSet<object>()
const registrationAggregates = new WeakSet<object>()
const ROOT_FIELDS = new Set(['preset', 'options'])
const STANDARD_FIELDS = new Set(['clock', 'resource', 'lifecycle'])
const PRODUCTION_FIELDS = new Set([...STANDARD_FIELDS, 'continuous'])
const CUSTOM_FIELDS = new Set([
	...STANDARD_FIELDS,
	'profiler',
	'continuous',
	'destinations',
	'manualCapture',
	'operationTimeoutMs',
	'shutdownTimeoutMs'
])
const CLEANUP_TIMEOUT_MS = 5_000
const SAFE_FAILURES = new Set([
	'profiling_already_registered',
	'profiling_container_binding_failed',
	'profiling_invalid_container',
	'profiling_invalid_registration',
	'profiling_registered_during_creation'
])

function captureContainerMethod(container: object, key: PropertyKey): ContainerMethod | undefined {
	let current: object | null = container
	const visited = new Set<object>()
	try {
		while (current && !visited.has(current) && visited.size < 32) {
			visited.add(current)
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function'
				? ((...args: never[]) => Reflect.apply(descriptor.value as ContainerMethod, container, args))
				: undefined
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function captureContainer(container: object): StableContainer {
	const bind = captureContainerMethod(container, 'bind') as StableContainer['bind'] | undefined
	const unbind = captureContainerMethod(container, 'unbind') as StableContainer['unbind'] | undefined
	const get = captureContainerMethod(container, 'get') as StableContainer['get'] | undefined
	const tryGet = captureContainerMethod(container, 'tryGet') as StableContainer['tryGet'] | undefined
	const has = captureContainerMethod(container, 'has') as StableContainer['has'] | undefined
	if (!bind || !unbind || !get || !tryGet || !has) throw new TypeError('profiling_invalid_container')
	const pending = (result: unknown): Promise<unknown> | undefined => {
		if (!result || (typeof result !== 'object' && typeof result !== 'function')) return undefined
		const then = captureContainerMethod(result, 'then')
		if (!then) return undefined
		return new Promise((resolve, reject) => {
			try { then(resolve as never, reject as never) } catch(error) { reject(error) }
		})
	}
	const sync = <T extends ContainerMethod>(method: T): T => ((...args: never[]) => {
		const result = method(...args)
		const physical = pending(result)
		if (physical) {
			void physical.catch(() => undefined)
			throw new TypeError('profiling_invalid_container')
		}
		return result
	}) as T
	const stableUnbind = sync(unbind); const stableTryGet = sync(tryGet)
	const stableBind = ((token: symbol, value: unknown) => {
		const result = (bind as (...args: unknown[]) => unknown)(token, value)
		const physical = pending(result)
		if (physical) {
			const rollback = () => {
				try { if (stableTryGet(token) === value) stableUnbind(token) } catch { /* late rollback is best effort */ }
			}
			void physical.then(rollback, rollback)
			throw new TypeError('profiling_invalid_container')
		}
		return result
	}) as StableContainer['bind']
	return {bind: stableBind, unbind: stableUnbind, get: sync(get), tryGet: stableTryGet, has: sync(has)}
}

function snapshotRecord(value: unknown, fields: ReadonlySet<string>): Readonly<Record<string, unknown>> {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const keys = Reflect.ownKeys(value)
		if (keys.length > fields.size || keys.some((key) => typeof key !== 'string')) throw new TypeError()
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const key of keys as string[]) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!fields.has(key) || !descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError()
			result[key] = descriptor.value
		}
		return Object.freeze(result)
	} catch { throw new TypeError('profiling_invalid_registration') }
}

function snapshotRegistration(value: unknown): ProfilingRegistrationOptions {
	const root = snapshotRecord(value, ROOT_FIELDS)
	const preset = root.preset
	if (preset !== 'development' && preset !== 'production' && preset !== 'custom') {
		throw new TypeError('profiling_invalid_registration')
	}
	if (root.options === undefined) {
		if (preset !== 'development') throw new TypeError('profiling_invalid_registration')
		return Object.freeze({preset})
	}
	const fields = preset === 'custom' ? CUSTOM_FIELDS : preset === 'production' ? PRODUCTION_FIELDS : STANDARD_FIELDS
	const options = snapshotRecord(root.options, fields)
	return Object.freeze({preset, options: Object.freeze({...options})}) as ProfilingRegistrationOptions
}

function safeFailure(error: unknown): Error {
	try {
		if (!error || (typeof error !== 'object' && typeof error !== 'function')) return new Error('profiling_registration_failed')
		const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
		if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
			return new Error('profiling_registration_failed')
		}
		const message = descriptor.value.slice(0, 256)
		if (SAFE_FAILURES.has(message)) return new Error(message)
	} catch { /* return the generic sanitized failure */ }
	return new Error('profiling_registration_failed')
}

async function boundedCleanup(runtime: ManagedProfiling): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const attempt = async(): Promise<void> => {
		try { await runtime.shutdown() } catch { await runtime.shutdown() }
	}
	try {
		await Promise.race([
			attempt(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('profiling_registration_cleanup_timeout')), CLEANUP_TIMEOUT_MS)
			})
		])
	} finally { if (timer) clearTimeout(timer) }
}

function withContainerRuntime(
	options: StandardProfilingOptions | undefined,
	clock: Clock | undefined,
	lifecycle: LifecyclePort | undefined
): StandardProfilingOptions {
	return Object.freeze({
		...options,
		...(clock !== undefined ? {clock} : {}),
		...(lifecycle !== undefined ? {lifecycle} : {})
	})
}

export async function registerProfilingImplementation(
	container: Container,
	configuration: ProfilingRegistrationOptions
): Promise<void> {
	if (!container || typeof container !== 'object') throw new TypeError('profiling_invalid_container')
	if (registrations.has(container)) throw new Error('profiling_already_registered')
	registrations.add(container)
	try {
		const stable = captureContainer(container)
		const registration = snapshotRegistration(configuration)
		if (stable.has(TOK.Profiling) || stable.tryGet(TOK.Profiling) !== undefined) {
			throw new Error('profiling_already_registered')
		}
		let clock: Clock | undefined
		let lifecycle: LifecyclePort | undefined
		try {
			clock = stable.tryGet<Clock>(TOK.Clock)
			lifecycle = stable.tryGet<LifecyclePort>(TOK.Lifecycle)
		} catch { throw new TypeError('profiling_invalid_registration') }
		const standard = withContainerRuntime(
			registration.options as StandardProfilingOptions | undefined,
			clock,
			lifecycle
		)
		let runtime: ManagedProfiling
		if (registration.preset === 'development') {
			const {createDevelopmentProfiling} = await import('./public/development')
			runtime = await createDevelopmentProfiling(standard)
		} else if (registration.preset === 'production') {
			const {createProductionProfiling} = await import('./public/production')
			runtime = await createProductionProfiling({
				...standard,
				continuous: registration.options.continuous
			} as ProductionProfilingOptions)
		} else {
			const {createCustomProfiling} = await import('./public/custom')
			runtime = await createCustomProfiling(standard as CustomProfilingOptions)
		}

		try {
			if (stable.has(TOK.Profiling) || stable.tryGet(TOK.Profiling) !== undefined) {
				throw new Error('profiling_registered_during_creation')
			}
			let bindError: unknown
			try { stable.bind(TOK.Profiling, runtime) } catch(error) { bindError = error }
			if (!stable.has(TOK.Profiling) || stable.tryGet(TOK.Profiling) !== runtime) {
				throw bindError ?? new Error('profiling_container_binding_failed')
			}
		} catch(error) {
			const failures: Error[] = [safeFailure(error)]
			try {
				if (stable.tryGet(TOK.Profiling) !== undefined) stable.unbind(TOK.Profiling)
				if (stable.has(TOK.Profiling) || stable.tryGet(TOK.Profiling) !== undefined) {
					throw new Error('profiling_container_rollback_failed')
				}
			} catch { failures.push(new Error('profiling_container_rollback_failed')) }
			try { await boundedCleanup(runtime) } catch { failures.push(new Error('profiling_registration_cleanup_failed')) }
			if (failures.length > 1) {
				const aggregate = new AggregateError(failures, 'profiling_registration_and_rollback_failed')
				registrationAggregates.add(aggregate)
				throw aggregate
			}
			throw failures[0]
		}
	} catch(error) {
		if (error && (typeof error === 'object' || typeof error === 'function') && registrationAggregates.has(error)) throw error
		throw safeFailure(error)
	} finally { registrations.delete(container) }
}
