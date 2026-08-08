import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {ManagedLifecycle} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import {
	captureClock,
	snapshotRecord,
	snapshotResource
} from './core/lifecycle-handler-validation'
import type {CustomLifecycleOptions} from './types/lifecycle'

export type LifecycleOptions =
	| {readonly preset: 'development'; readonly options?: {readonly resource?: ObservabilityResource}}
	| {readonly preset: 'production'; readonly options?: {readonly resource?: ObservabilityResource}}
	| {readonly preset: 'custom'; readonly options: Omit<CustomLifecycleOptions, 'clock' | 'observability'>}

type StableContainer = Required<Pick<Container, 'bind' | 'unbind' | 'get' | 'tryGet' | 'has'>>
type ContainerMethod = (...args: never[]) => unknown
const registrationsInProgress = new WeakSet<object>()
const registrationAggregates = new WeakSet<object>()
const REGISTRATION_FIELDS = new Set(['preset', 'options'])
const STANDARD_FIELDS = new Set(['resource'])
const CUSTOM_FIELDS = new Set(['monotonicClock', 'resource', 'startup', 'shutdown', 'health'])
const STARTUP_FIELDS = new Set(['initTimeoutMs', 'warmTimeoutMs'])
const SHUTDOWN_FIELDS = new Set(['timeoutMs', 'hookTimeoutMs', 'flushTimeoutMs', 'drainGracePeriodMs', 'groups'])
const HEALTH_FIELDS = new Set(['intervalMs', 'checkTimeoutMs', 'runTimeoutMs', 'concurrency'])
const CLEANUP_TIMEOUT_MS = 5_000

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
	if (!bind || !unbind || !get || !tryGet || !has) {
		throw new TypeError('Lifecycle registration requires a valid reversible container')
	}
	return {bind, unbind, get, tryGet, has}
}

function snapshotGroups(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined
	if (!Array.isArray(value)) throw new TypeError('Lifecycle shutdown groups must be an array')
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > 64) throw new TypeError('Lifecycle shutdown groups are invalid')
	const groups: string[] = []
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
		if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
			throw new TypeError('Lifecycle shutdown groups must contain stable strings')
		}
		groups.push(descriptor.value)
	}
	return Object.freeze(groups)
}

function snapshotNested(
	value: unknown,
	label: string,
	fields: ReadonlySet<string>
): Record<string, unknown> | undefined {
	return value === undefined ? undefined : Object.freeze(snapshotRecord(value, label, fields))
}

function snapshotRegistration(value: unknown): LifecycleOptions {
	const root = snapshotRecord(value, 'Lifecycle registration options', REGISTRATION_FIELDS)
	const preset = root.preset
	if (preset !== 'development' && preset !== 'production' && preset !== 'custom') {
		throw new Error('Unsupported lifecycle preset')
	}
	if (preset !== 'custom') {
		if (root.options === undefined) return Object.freeze({preset})
		const options = snapshotRecord(root.options, 'Lifecycle standard registration options', STANDARD_FIELDS)
		const resource = snapshotResource(options.resource)
		return Object.freeze({preset, options: Object.freeze(resource ? {resource} : {})})
	}
	if (root.options === undefined) throw new TypeError('Lifecycle custom options are required')
	const options = snapshotRecord(root.options, 'Lifecycle custom registration options', CUSTOM_FIELDS)
	const startup = snapshotNested(options.startup, 'Lifecycle startup options', STARTUP_FIELDS)
	const shutdown = snapshotNested(options.shutdown, 'Lifecycle shutdown options', SHUTDOWN_FIELDS)
	const health = snapshotNested(options.health, 'Lifecycle health options', HEALTH_FIELDS)
	const groups = shutdown ? snapshotGroups(shutdown.groups) : undefined
	const resource = snapshotResource(options.resource)
	const monotonicClock = options.monotonicClock === undefined
		? undefined
		: captureClock(options.monotonicClock, 'Lifecycle monotonicClock')
	return Object.freeze({
		preset,
		options: Object.freeze({
			...(monotonicClock ? {monotonicClock} : {}),
			...(resource ? {resource} : {}),
			...(startup ? {startup} : {}),
			...(shutdown ? {shutdown: Object.freeze({...shutdown, ...(groups ? {groups} : {})})} : {}),
			...(health ? {health} : {})
		})
	}) as LifecycleOptions
}

function safeMessage(error: unknown): string {
	try {
		if (!error || (typeof error !== 'object' && typeof error !== 'function')) return 'Lifecycle registration failed'
		const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
		if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
			return 'Lifecycle registration failed'
		}
		return descriptor.value.slice(0, 512).replace(
			/(password|token|secret|authorization)\s*[=:]\s*(?:bearer\s+)?[^\s,;]+|bearer\s+[^\s,;]+/giu,
			'$1=[REDACTED]'
		)
	} catch { return 'Lifecycle registration failed' }
}

function registrationFailure(error: unknown): Error {
	const message = safeMessage(error)
	return /^(Lifecycle|Unsupported lifecycle)/u.test(message)
		? new Error(message)
		: new Error('Lifecycle registration failed')
}

async function boundedCleanup(action: () => Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			action(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Lifecycle registration cleanup timed out')), CLEANUP_TIMEOUT_MS)
			})
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function observabilityFrom(container: StableContainer): {
	errors?: Errors
	logger?: Logging
	metrics?: MetricsPort
	tracer?: Tracing
} {
	const errors = container.tryGet<Errors>(TOK.Errors)
	const logger = container.tryGet<Logging>(TOK.Logging)
	const metrics = container.tryGet<MetricsPort>(TOK.Metrics)
	const tracer = container.tryGet<Tracing>(TOK.Tracing)
	return {
		...(errors ? {errors} : {}),
		...(logger ? {logger} : {}),
		...(metrics ? {metrics} : {}),
		...(tracer ? {tracer} : {})
	}
}

export async function registerLifecycle(
	container: Container,
	options: LifecycleOptions
): Promise<void> {
	if (!container || typeof container !== 'object') {
		throw new TypeError('Lifecycle registration requires a valid container')
	}
	if (registrationsInProgress.has(container)) throw new Error('Lifecycle service is already registered')
	registrationsInProgress.add(container)
	try {
		const stable = captureContainer(container)
		const registration = snapshotRegistration(options)
		if (stable.has(TOK.Lifecycle) || stable.tryGet(TOK.Lifecycle) !== undefined) {
			throw new Error('Lifecycle service is already registered')
		}
		const clock = stable.get<Clock>(TOK.Clock)
		const observability = observabilityFrom(stable)
		let lifecycle: ManagedLifecycle
		if (registration.preset === 'development') {
			const {createDevelopmentLifecycle} = await import('./public/development')
			lifecycle = createDevelopmentLifecycle({...registration.options, observability})
		} else if (registration.preset === 'production') {
			const {createProductionLifecycle} = await import('./public/production')
			lifecycle = createProductionLifecycle({...registration.options, observability})
		} else {
			const {createCustomLifecycle} = await import('./public/custom')
			lifecycle = createCustomLifecycle({...registration.options, clock, observability})
		}
		try {
			if (stable.has(TOK.Lifecycle) || stable.tryGet(TOK.Lifecycle) !== undefined) {
				throw new Error('Lifecycle service was registered during runtime creation')
			}
			stable.bind(TOK.Lifecycle, lifecycle)
			if (!stable.has(TOK.Lifecycle) || stable.tryGet(TOK.Lifecycle) !== lifecycle) {
				throw new Error('Lifecycle container did not retain the registered runtime')
			}
		} catch(error) {
			const failures: Error[] = [registrationFailure(error)]
			try {
				if (stable.tryGet(TOK.Lifecycle) === lifecycle) {
					if (!stable.unbind(TOK.Lifecycle) || stable.tryGet(TOK.Lifecycle) !== undefined) {
						throw new Error('Lifecycle registration rollback could not remove its binding')
					}
				}
			} catch { failures.push(new Error('Lifecycle registration rollback failed')) }
			try { await boundedCleanup(async() => await lifecycle.shutdown('error')) } catch {
				failures.push(new Error('Lifecycle registration cleanup failed'))
			}
			if (failures.length > 1) {
				const aggregate = new AggregateError(failures, 'Lifecycle registration and rollback failed')
				registrationAggregates.add(aggregate)
				throw aggregate
			}
			throw failures[0]
		}
	} catch(error) {
		if (error && (typeof error === 'object' || typeof error === 'function')
			&& registrationAggregates.has(error)) throw error
		throw registrationFailure(error)
	} finally {
		registrationsInProgress.delete(container)
	}
}

export * from './public/types'
