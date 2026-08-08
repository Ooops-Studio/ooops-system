import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomLoggingOptions} from './public/custom'
import type {DevelopmentLoggingOptions} from './public/development'
import type {ProductionLoggingOptions} from './public/production'
import type {ManagedLogging, MutableLevelLogging} from './types/handler'
import {captureLoggingMethod, observeLoggingThenable, readLoggingDataProperty} from './utils/capabilities'
import {sanitizeLoggingErrorDiagnostic} from './utils/sanitize-diagnostic'

export type {Sink, SinkWriteOptions} from './types/sink'

export type LoggingOptions =
	| {
		readonly preset: 'development'
		readonly options?: Omit<DevelopmentLoggingOptions, 'clock' | 'errors' | 'metrics' | 'lifecycle' | 'providers' | 'resource'>
		readonly resource?: ObservabilityResource
		readonly traceCorrelation?: boolean
	}
	| {
		readonly preset: 'production'
		readonly options?: Omit<ProductionLoggingOptions, 'clock' | 'errors' | 'metrics' | 'lifecycle' | 'providers' | 'context' | 'resource'>
		readonly context?: ProductionLoggingOptions['context']
		readonly resource?: ObservabilityResource
		readonly traceCorrelation?: boolean
	}
	| {
		readonly preset: 'custom'
		readonly options: Omit<CustomLoggingOptions, 'clock' | 'errors' | 'metrics' | 'lifecycle'>
	}

const registrationsInProgress = new WeakSet<object>()

function rejectAsyncContainerResult<T>(value: T, capability: string): T {
	if (!observeLoggingThenable(value)) return value
	throw new TypeError(`Logging container ${capability}() must be synchronous`)
}

const MAX_REGISTRATION_FAILURE_NODES = 100
const MAX_REGISTRATION_FAILURE_DEPTH = 8

interface RegistrationFailureProjectionState {
	remaining: number
	readonly seen: WeakSet<object>
}

function sanitizeRegistrationFailure(
	error: unknown,
	state: RegistrationFailureProjectionState = {
		remaining: MAX_REGISTRATION_FAILURE_NODES,
		seen: new WeakSet<object>()
	},
	depth = 0
): Error {
	if (state.remaining <= 0) return new Error('[logging registration failure budget exhausted]')
	state.remaining -= 1
	if (error && (typeof error === 'object' || typeof error === 'function')) {
		if (state.seen.has(error as object)) return new Error('[circular logging registration failure]')
		state.seen.add(error as object)
	}
	const diagnostic = sanitizeLoggingErrorDiagnostic(error)
	if (depth >= MAX_REGISTRATION_FAILURE_DEPTH) return new Error(diagnostic)
	const members = readLoggingDataProperty<unknown>(error, 'errors')
	let memberArray = false
	try { memberArray = Array.isArray(members) } catch { /* Hostile proxies are treated as leaf diagnostics. */ }
	if (memberArray) {
		const sanitized: Error[] = []
		let length = 0
		try {
			const descriptor = Object.getOwnPropertyDescriptor(members as unknown[], 'length')
			const value = descriptor && 'value' in descriptor ? descriptor.value : 0
			if (Number.isSafeInteger(value) && value >= 0) length = Math.min(value, state.remaining)
		} catch { /* Hostile arrays are projected without members. */ }
		for (let index = 0; index < length; index += 1) {
			if (state.remaining <= 0) break
			try {
				const descriptor = Object.getOwnPropertyDescriptor(members as unknown[], String(index))
				if (descriptor && 'value' in descriptor) {
					sanitized.push(sanitizeRegistrationFailure(descriptor.value, state, depth + 1))
				}
			} catch { /* Skip hostile member descriptors. */ }
		}
		return new AggregateError(sanitized, diagnostic)
	}
	return new Error(diagnostic)
}

function snapshotRegistrationOptions(value: unknown): LoggingOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Logging registration options are required')
	}
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.some((key) => typeof key !== 'string')) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
			throw new TypeError()
		}
		const preset = descriptors.preset?.value
		if (preset !== 'development' && preset !== 'production' && preset !== 'custom') {
			throw new Error(`Unknown logging preset: ${typeof preset === 'string' ? preset : 'invalid'}`)
		}
		const allowed = preset === 'custom'
			? new Set(['preset', 'options'])
			: preset === 'production'
				? new Set(['preset', 'options', 'context', 'resource', 'traceCorrelation'])
				: new Set(['preset', 'options', 'resource', 'traceCorrelation'])
		if (keys.some((key) => !allowed.has(key as string))) throw new TypeError()
		const rawOptions = descriptors.options?.value
		const traceCorrelation = descriptors.traceCorrelation?.value
		if (traceCorrelation !== undefined && typeof traceCorrelation !== 'boolean') throw new TypeError()
		if (preset === 'custom' && (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions))) {
			throw new TypeError()
		}
		if (rawOptions !== undefined && (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions))) {
			throw new TypeError()
		}
		const snapshot = Object.create(null) as Record<string, unknown>
		for (const key of keys as string[]) snapshot[key] = descriptors[key]!.value
		if (rawOptions) {
			const optionsPrototype = Object.getPrototypeOf(rawOptions)
			if (optionsPrototype !== Object.prototype && optionsPrototype !== null) throw new TypeError()
			const optionDescriptors = Object.getOwnPropertyDescriptors(rawOptions)
			if (Reflect.ownKeys(optionDescriptors).some((key) => typeof key !== 'string')
				|| Object.values(optionDescriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
				throw new TypeError()
			}
			const optionSnapshot = Object.create(null) as Record<string, unknown>
			for (const [key, descriptor] of Object.entries(optionDescriptors)) optionSnapshot[key] = descriptor.value
			snapshot.options = optionSnapshot
		}
		return snapshot as unknown as LoggingOptions
	} catch(error) {
		const message = readLoggingDataProperty<unknown>(error, 'message')
		if (typeof message === 'string' && message.startsWith('Unknown logging preset:')) throw error
		throw new TypeError('Logging registration options contain invalid or unexpected fields')
	}
}

export async function registerLogging(container: Container, options: LoggingOptions): Promise<void> {
	if (registrationsInProgress.has(container)) {
		throw new Error('Logging service is already registered')
	}
	registrationsInProgress.add(container)
	try {
		const registration = snapshotRegistrationOptions(options)
		const has = captureLoggingMethod<Container['has']>(container, 'has')
		const get = captureLoggingMethod<Container['get']>(container, 'get')
		const tryGet = captureLoggingMethod<Container['tryGet']>(container, 'tryGet')
		const bind = captureLoggingMethod<Container['bind']>(container, 'bind')
		const unbind = captureLoggingMethod<NonNullable<Container['unbind']>>(container, 'unbind')
		if (!has || !get || !tryGet || !bind) throw new Error('Logging registration requires a valid container')
		if (!unbind) throw new Error('Logging registration requires reversible container bindings')
		const stableContainer: Container = {
			has: (token) => rejectAsyncContainerResult(has.call(container, token), 'has'),
			get: <T>(token: symbol) => rejectAsyncContainerResult(get.call(container, token), 'get') as T,
			tryGet: <T>(token: symbol) => rejectAsyncContainerResult(
				tryGet.call(container, token), 'tryGet'
			) as T | undefined,
			bind: <T>(token: symbol, value: T) => {
				rejectAsyncContainerResult(bind.call(container, token, value), 'bind')
			},
			unbind: (token) => rejectAsyncContainerResult(unbind.call(container, token), 'unbind')
		}
		if (stableContainer.has(TOK.Logging)) throw new Error('Logging service is already registered')
		await registerLoggingUnlocked(stableContainer, registration, stableContainer.unbind!)
	} catch(error) {
		throw sanitizeRegistrationFailure(error)
	} finally {
		registrationsInProgress.delete(container)
	}
}

async function registerLoggingUnlocked(
	container: Container,
	options: LoggingOptions,
	unbind: (token: symbol) => boolean
): Promise<void> {
	const clock = container.get<Clock>(TOK.Clock)
	const errors = container.tryGet<Errors>(TOK.Errors)
	const lifecycle = container.tryGet<LifecyclePort>(TOK.Lifecycle)
	const metrics = container.tryGet<MetricsPort>(TOK.Metrics)
	const tracing = container.tryGet<Tracing>(TOK.Tracing)
	const traceCorrelationEnabled = options.preset !== 'custom' && options.traceCorrelation !== false
	let logger: ManagedLogging | MutableLevelLogging

	if (options.preset === 'development') {
		const [{createDevelopmentLogging}, {buildObservabilityLogContext, createTraceCorrelationProvider}] = await Promise.all([
			import('./public/development'),
			import('./public/observability')
		])
		const correlatedProviders = traceCorrelationEnabled && tracing
			? [createTraceCorrelationProvider(tracing)]
			: []
		const context = buildObservabilityLogContext(options.options?.context, options.resource)
		logger = await createDevelopmentLogging({
			...options.options,
			clock,
			...(context ? {context} : {}),
			providers: correlatedProviders,
			...(errors ? {errors} : {}),
			...(metrics ? {metrics} : {}),
			...(lifecycle ? {lifecycle} : {})
		})
	} else if (options.preset === 'production') {
		const [{createProductionLogging}, {buildObservabilityLogContext, createTraceCorrelationProvider}] = await Promise.all([
			import('./public/production'),
			import('./public/observability')
		])
		const correlatedProviders = traceCorrelationEnabled && tracing
			? [createTraceCorrelationProvider(tracing)]
			: []
		const context = buildObservabilityLogContext(options.context, options.resource)
		logger = await createProductionLogging({
			...options.options,
			clock,
			...(context ? {context} : {}),
			providers: correlatedProviders,
			...(errors ? {errors} : {}),
			...(metrics ? {metrics} : {}),
			...(lifecycle ? {lifecycle} : {})
		})
	} else {
		const {createCustomLogging} = await import('./public/custom')
		logger = await createCustomLogging({
			...options.options,
			clock,
			...(errors ? {errors} : {}),
			...(metrics ? {metrics} : {}),
			...(lifecycle ? {lifecycle} : {})
		})
	}
	let bindingCompleted = false
	let bindingAttempted = false
	try {
		if (container.has(TOK.Logging)) throw new Error('Logging service was registered during runtime creation')
		bindingAttempted = true
		container.bind(TOK.Logging, logger)
		bindingCompleted = true
		if (container.tryGet(TOK.Logging) !== logger) {
			throw new Error('Logging container did not retain the registered runtime')
		}
		if (logger.getStatus().state !== 'running') {
			throw new Error('Logging runtime became unavailable during registration')
		}
	} catch(error) {
		const cleanupFailures: unknown[] = []
		try {
			let ownsBinding = bindingCompleted
			try { ownsBinding = container.tryGet(TOK.Logging) === logger } catch {
				// A bind may mutate the container and then lose its acknowledgement.
				// With ownership unreadable, the synchronous attempt is the strongest
				// available boundary; roll it back rather than strand a closed runtime.
				ownsBinding = bindingAttempted
			}
			if (ownsBinding && !unbind(TOK.Logging)) {
				throw new Error('Logging registration rollback could not remove its binding')
			}
		} catch(cleanupError) { cleanupFailures.push(cleanupError) }
		try { await logger.shutdown() } catch(cleanupError) { cleanupFailures.push(cleanupError) }
		if (cleanupFailures.length > 0) {
			throw new AggregateError([error, ...cleanupFailures], 'Logging registration and rollback failed')
		}
		throw error
	}
}

export type {CustomLoggingOptions} from './public/custom'
export type {DevelopmentLoggingOptions} from './public/development'
export type {ProductionLoggingOptions, ProductionLoggingRemote} from './public/production'
export type {
	LoggingRuntimeState,
	LoggingSamplingPolicy,
	LoggingSinkState,
	LoggingStatus,
	ManagedLogging,
	MutableLevelLogging
} from './types/handler'
