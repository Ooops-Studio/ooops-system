import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {NormalizedError} from '@ooopsstudio/core/contracts/errors'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomErrorHandlerOptions} from './public/custom'
import {createCustomErrorHandler} from './public/custom'
import type {DevelopmentErrorHandlerOptions} from './public/development'
import {createDevelopmentErrorHandler} from './public/development'
import type {ProductionErrorHandlerOptions} from './public/production'
import {createProductionErrorHandler} from './public/production'
import type {ErrorHandlerOptions, ErrorsHandlerPort} from './types/error-handler'
import {captureErrorCapability} from './utils/capabilities'
import {snapshotErrorHandlerOptions} from './utils/options'

export type ErrorsOptions =
	| {preset: 'development'; options?: DevelopmentErrorHandlerOptions}
	| {preset: 'production'; options?: ProductionErrorHandlerOptions}
	| {preset: 'custom'; options?: CustomErrorHandlerOptions}

const registrationsInProgress = new WeakSet<object>()

/** Register the fixed development, production, or custom Errors service. */
export async function registerErrors(c: Container, opts: ErrorsOptions): Promise<void> {
	if (!c || typeof c !== 'object') throw new Error('errors_invalid_container')
	// Own registration before inspecting caller-controlled descriptors. Proxy
	// traps can re-enter this async function synchronously, before its first await.
	if (registrationsInProgress.has(c)) throw new Error('errors_already_registered')
	registrationsInProgress.add(c)
	try {
		let has: Container['has']
		let get: Container['get']
		let tryGet: Container['tryGet']
		let bind: Container['bind']
		let unbind: NonNullable<Container['unbind']> | undefined
		try {
			has = captureErrorCapability(c, 'has') as Container['has']
			get = captureErrorCapability(c, 'get') as Container['get']
			tryGet = captureErrorCapability(c, 'tryGet') as Container['tryGet']
			bind = captureErrorCapability(c, 'bind') as Container['bind']
			unbind = captureErrorCapability(c, 'unbind') as NonNullable<Container['unbind']> | undefined
			if (typeof has !== 'function' || typeof get !== 'function'
			|| typeof tryGet !== 'function' || typeof bind !== 'function'
			|| typeof unbind !== 'function') throw new Error('invalid')
		} catch {
			throw new Error('errors_invalid_container')
		}
		const stableContainer: Container = {
			has: (token) => has.call(c, token),
			get: <T>(token: symbol): T => get.call(c, token) as T,
			tryGet: <T>(token: symbol): T | undefined => tryGet.call(c, token) as T | undefined,
			bind: <T>(token: symbol, value: T): void => { bind.call(c, token, value) },
			unbind: (token: symbol): boolean => unbind!.call(c, token)
		}
		let preset: unknown
		let providedOptions: unknown
		let validRegistrationShape = false
		try {
			if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
				const prototype = Object.getPrototypeOf(opts)
				if (prototype !== Object.prototype && prototype !== null) throw new Error()
				const keys = Reflect.ownKeys(opts)
				const presetDescriptor = Object.getOwnPropertyDescriptor(opts, 'preset')
				const optionsDescriptor = Object.getOwnPropertyDescriptor(opts, 'options')
				validRegistrationShape = keys.every((key) => key === 'preset' || key === 'options')
					&& presetDescriptor?.enumerable === true && 'value' in presetDescriptor
					&& (optionsDescriptor === undefined
						|| (optionsDescriptor.enumerable === true && 'value' in optionsDescriptor))
				if (validRegistrationShape) {
					preset = presetDescriptor && 'value' in presetDescriptor
						? presetDescriptor.value
						: undefined
					providedOptions = optionsDescriptor && 'value' in optionsDescriptor
						? optionsDescriptor.value
						: undefined
				}
			}
		} catch { preset = undefined }
		if (!validRegistrationShape || !['development', 'production', 'custom'].includes(preset as string)) {
			throw new Error('Unknown errors preset: invalid')
		}
		const safeOptions = snapshotErrorHandlerOptions(providedOptions as ErrorHandlerOptions | undefined)
		const configuration = {preset, options: safeOptions} as ErrorsOptions
		let alreadyRegistered: boolean
		try {
			alreadyRegistered = stableContainer.has(TOK.Errors)
				|| stableContainer.tryGet(TOK.Errors) !== undefined
		} catch {
			throw new Error('errors_container_lookup_failed')
		}
		if (alreadyRegistered) throw new Error('errors_already_registered')
		await registerErrorsUnlocked(stableContainer, configuration)
	} finally { registrationsInProgress.delete(c) }
}

async function registerErrorsUnlocked(c: Container, opts: ErrorsOptions): Promise<void> {
	let clock: Clock
	try { clock = c.get<Clock>(TOK.Clock) } catch { throw new Error('errors_invalid_clock') }
	let logger: Logging | undefined
	let lifecycle: LifecyclePort | undefined
	let metrics: MetricsPort | undefined
	let tracer: Tracing | undefined
	try {
		logger = c.tryGet<Logging>(TOK.Logging)
		lifecycle = c.tryGet<LifecyclePort>(TOK.Lifecycle)
		metrics = c.tryGet<MetricsPort>(TOK.Metrics)
		tracer = c.tryGet<Tracing>(TOK.Tracing)
	} catch {
		throw new Error('errors_dependency_resolution_failed')
	}
	const ports: NonNullable<ErrorHandlerOptions['ports']> = {
		...(logger ? {logger} : {}),
		...(metrics ? {metrics} : {}),
		...(tracer ? {tracer} : {}),
		...(lifecycle ? {lifecycle} : {})
	}
	const mergePorts = (provided?: ErrorHandlerOptions['ports']): NonNullable<ErrorHandlerOptions['ports']> => {
		const merged = {...ports} as Record<string, unknown>
		for (const [key, value] of Object.entries(provided ?? {})) {
			if (value !== undefined) merged[key] = value
		}
		return merged as NonNullable<ErrorHandlerOptions['ports']>
	}
	const providedOptions = opts.options as ErrorHandlerOptions
	const configuredClock: unknown = Object.hasOwn(providedOptions, 'clock')
		? providedOptions.clock
		: undefined
	// Preserve malformed explicit values for the preset/kernel validator. A
	// nullish fallback here previously converted `clock: null` into the container
	// clock and registered a service with configuration the caller did not supply.
	if (configuredClock === undefined && clock === undefined) throw new Error('errors_invalid_clock')
	const selectedClock = configuredClock === undefined ? clock : configuredClock as Clock

	let handler: ErrorsHandlerPort
	switch (opts.preset) {
		case 'development':
			handler = await createDevelopmentErrorHandler({
				...providedOptions,
				clock: selectedClock,
				ports: mergePorts(providedOptions.ports)
			})
			break
		case 'production':
			handler = await createProductionErrorHandler({
				...providedOptions,
				clock: selectedClock,
				ports: mergePorts(providedOptions.ports)
			})
			break
		case 'custom':
			handler = await createCustomErrorHandler({
				...providedOptions,
				clock: selectedClock,
				ports: mergePorts(providedOptions.ports)
			})
			break
	}

	const service = {
		report(error: NormalizedError, context?: LogAttributes): void {
			void Promise.resolve(handler.handle(error, context as Record<string, unknown> | undefined))
				.catch(() => undefined)
		},
		handle: handler.handle,
		normalize: handler.normalize,
		classify: handler.classify,
		flush: handler.flush,
		shutdown: handler.shutdown
	}
	let bindAttempted = false
	const hasErrorBinding = (): boolean => c.has(TOK.Errors) || c.tryGet(TOK.Errors) !== undefined
	let publicRegistrationFailure: Error | undefined
	try {
		// Preset factories are asynchronous. Another owner may bind Errors while
		// the factory is being constructed; never overwrite that newer value.
		if (hasErrorBinding()) {
			publicRegistrationFailure = new Error('errors_already_registered')
			throw publicRegistrationFailure
		}
		bindAttempted = true
		c.bind(TOK.Errors, service)
		// Custom containers may silently ignore a bind. Registration is complete
		// only when both lookup contracts expose the exact registered instance.
		if (!c.has(TOK.Errors) || c.tryGet(TOK.Errors) !== service) {
			publicRegistrationFailure = new Error('errors_registration_not_retained')
			throw publicRegistrationFailure
		}
	} catch {
		// Container implementations are an external trust boundary. Never expose a
		// thrown bind/lookup value (or its nested AggregateError data) to callers.
		const registrationFailure = publicRegistrationFailure
			?? new Error('errors_registration_failed')
		const cleanupFailures: Error[] = []
		// The final check and bind are synchronous, with no await between them. If
		// bind was attempted, any binding now present was introduced by that failed
		// attempt and the original, verified-unbound state must be restored. Always
		// attempt the rollback first: a broken post-bind `has()` implementation must
		// not prevent `unbind()` from removing a value that `bind()` already stored.
		try {
			if (bindAttempted) {
				c.unbind!(TOK.Errors)
				if (hasErrorBinding()) throw new Error('errors_registration_rollback_failed')
			}
		} catch { cleanupFailures.push(new Error('errors_registration_rollback_failed')) }
		try { await handler.shutdown() } catch { cleanupFailures.push(new Error('errors_registration_cleanup_failed')) }
		if (cleanupFailures.length > 0) {
			throw new AggregateError(
				[registrationFailure, ...cleanupFailures],
				'Errors registration and rollback failed.'
			)
		}
		throw registrationFailure
	}
}
