import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Container} from '@ooopsstudio/core/runtime'
import {
	addNativeWeakSet,
	deleteNativeWeakSet,
	hasNativeWeakSet
} from '@ooopsstudio/core/runtime/collections/native-collections'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomTracingOptions} from './public/custom'
import type {DevelopmentTracingOptions} from './public/development'
import {snapshotCustomOptions, snapshotDevelopmentOptions, snapshotProductionOptions} from './public/options'
import type {ProductionTracingOptions} from './public/production'
import type {ManagedTracing} from './public/types'
import {
	captureCapabilities,
	captureCapability,
	captureClock,
	snapshotDataFields
} from './utils/capabilities'
/**
 * Tracing registration options.
 * Supports all tracing presets via a discriminated union.
 */
export type TracingOptions =
	| {
		preset: 'custom'
		options: Omit<CustomTracingOptions, 'clock' | 'logger' | 'errors' | 'lifecycle' | 'metrics'>
	}
	| {
		preset: 'development'
		options?: Omit<DevelopmentTracingOptions, 'clock' | 'logger' | 'errors' | 'lifecycle' | 'metrics'>
	}
	| {
		preset: 'production'
		options: Omit<ProductionTracingOptions, 'clock' | 'logger' | 'errors' | 'lifecycle' | 'metrics'>
	}

const registrationsInProgress = new WeakSet<object>()
const CUSTOM_OPTION_KEYS = new Set([
	'sampling', 'destination', 'delivery', 'resource', 'redaction', 'limits'
])
const DEVELOPMENT_OPTION_KEYS = new Set(['resource'])
const PRODUCTION_OPTION_KEYS = new Set(['remote', 'sampling', 'resource'])

function snapshotTracingRegistration(value: unknown): TracingOptions {
	const top = snapshotPlainFields(value, new Set(['preset', 'options']), 'Tracing registration options')
	const preset = top.preset
	if (preset !== 'custom' && preset !== 'development' && preset !== 'production') {
		throw new Error(`Unknown tracing preset: ${typeof preset === 'string' ? preset : 'invalid'}`)
	}
	const rawOptions = top.options
	if (preset !== 'development' && rawOptions === undefined) {
		throw new TypeError(`Tracing ${preset} registration options are required`)
	}
	if (rawOptions === undefined) return {preset: 'development'}
	const allowed = preset === 'custom' ? CUSTOM_OPTION_KEYS
		: preset === 'production' ? PRODUCTION_OPTION_KEYS : DEVELOPMENT_OPTION_KEYS
	const shallowOptions = snapshotPlainFields(rawOptions, allowed, `Tracing ${preset} options`)
	const options = preset === 'custom' ? snapshotCustomOptions(shallowOptions)
		: preset === 'production' ? snapshotProductionOptions(shallowOptions)
			: snapshotDevelopmentOptions(shallowOptions)
	return {preset, options} as TracingOptions
}

function snapshotPlainFields(
	value: unknown,
	allowedKeys: ReadonlySet<string>,
	label: string
): Record<string, unknown> {
	try {
		return snapshotDataFields(value, allowedKeys.size, 64, allowedKeys) as Record<string, unknown>
	} catch {
		throw new TypeError(`${label} contains invalid, accessor-backed, or unexpected fields`)
	}
}
/**
 * Register tracing service with the container.
 * Resolves dependencies from container and binds the tracer.
 *
 * @param c - Dependency injection container
 * @param opts - Tracing configuration options
 */
export async function registerTracing(
	c: Container,
	opts: TracingOptions
): Promise<void> {
	if (!c || typeof c !== 'object') throw new TypeError('Tracing registration requires a container')
	if (hasNativeWeakSet(registrationsInProgress, c)) throw new Error('Tracing service is already registered')
	addNativeWeakSet(registrationsInProgress, c)
	try {
		// Configuration is caller-owned. Freeze it before invoking any container
		// callback, since those callbacks may synchronously mutate caller state.
		const safeOptions = snapshotTracingRegistration(opts)
		const has = captureCapability<[symbol], boolean>(c, 'has')
		const get = captureCapability<[symbol], unknown>(c, 'get')
		const tryGet = captureCapability<[symbol], unknown>(c, 'tryGet')
		const bind = captureCapability<[symbol, unknown], void>(c, 'bind')
		const unbind = captureCapability<[symbol], boolean>(c, 'unbind')
		if (!has || !get || !tryGet || !bind) {
			throw new TypeError('Tracing registration requires a valid container')
		}
		if (!unbind) throw new Error('Tracing registration requires reversible container bindings')
		if (has(TOK.Tracing)) throw new Error('Tracing service is already registered')
		await registerTracingUnlocked({has, get, tryGet, bind, unbind}, safeOptions)
	} finally {
		deleteNativeWeakSet(registrationsInProgress, c)
	}
}

async function registerTracingUnlocked(
	c: {
		has(token: symbol): boolean
		get(token: symbol): unknown
		tryGet(token: symbol): unknown
		bind(token: symbol, value: unknown): void
		unbind(token: symbol): boolean
	},
	opts: TracingOptions
): Promise<void> {
	let clock: Clock
	try { clock = captureClock(c.get(TOK.Clock) as Clock) }
	catch { throw new Error('Tracing registration requires the container Clock service') }
	const logger = captureCapabilities(c.tryGet(TOK.Logging), ['warn']) as Logging | undefined
	const errors = captureCapabilities(c.tryGet(TOK.Errors), ['report']) as Errors | undefined
	const lifecycle = captureCapabilities(
		c.tryGet(TOK.Lifecycle),
		['registerShutdownHook', 'registerFlushHook']
	) as LifecyclePort | undefined
	const metrics = captureCapabilities(c.tryGet(TOK.Metrics), ['increment', 'record']) as MetricsPort | undefined
	let tracer: ManagedTracing
	switch (opts.preset) {
		case 'custom': {
			const {createCustomTracing} = await import('./public/custom')
			tracer = await createCustomTracing({
				...opts.options,
				clock,
				...(logger ? {logger} : {}),
				...(errors ? {errors} : {}),
				...(metrics ? {metrics} : {}),
				...(lifecycle ? {lifecycle} : {})
			})
			break
		}
		case 'development': {
			const {createDevelopmentTracing} = await import('./public/development')
			tracer = await createDevelopmentTracing({
				...opts.options,
				...(logger ? {logger} : {}),
				...(errors ? {errors} : {}),
				...(metrics ? {metrics} : {}),
				...(lifecycle ? {lifecycle} : {}),
				clock
			})
			break
		}
		case 'production': {
			const {createProductionTracing} = await import('./public/production')
			tracer = await createProductionTracing({
				...opts.options,
				...(logger ? {logger} : {}),
				...(errors ? {errors} : {}),
				...(metrics ? {metrics} : {}),
				...(lifecycle ? {lifecycle} : {}),
				clock
			})
			break
		}
		default: {
			const invalidPreset = (opts as {preset?: unknown}).preset
			throw new Error(`Unknown tracing preset: ${String(invalidPreset)}`)
		}
	}
	// Bind tracer to container
	let ownBindingObserved = false
	try {
		if (c.has(TOK.Tracing)) throw new Error('Tracing was registered during runtime creation')
		try {
			c.bind(TOK.Tracing, tracer)
		} catch(error) {
			try { ownBindingObserved = c.tryGet(TOK.Tracing) === tracer }
			catch { /* preserve the bind failure */ }
			throw error
		}
		ownBindingObserved = c.tryGet(TOK.Tracing) === tracer
		if (!c.has(TOK.Tracing) || c.tryGet(TOK.Tracing) !== tracer) {
			throw new Error('Tracing container did not install the expected binding')
		}
	} catch(error) {
		let rollbackError: unknown
		if (ownBindingObserved) {
			try {
				// Remove only this runtime's identity. A re-entrant container may have
				// published a newer foreign binding, which this rollback must preserve.
				if (c.tryGet(TOK.Tracing) === tracer) {
					c.unbind(TOK.Tracing)
					if (c.tryGet(TOK.Tracing) === tracer) {
						rollbackError = new Error('Tracing registration rollback did not remove its partial binding')
					}
				}
			} catch(cause) {
				rollbackError = new Error('Tracing registration rollback failed', {cause})
			}
		}
		let shutdownError: unknown
		try { await tracer.shutdown() } catch(cause) { shutdownError = cause }
		if (rollbackError !== undefined) {
			throw new AggregateError([error, rollbackError, ...(shutdownError ? [shutdownError] : [])], 'Tracing registration and rollback both failed')
		}
		if (shutdownError !== undefined) throw new AggregateError([error, shutdownError], 'Tracing registration and cleanup both failed')
		throw error
	}
}
// The family root contains registration and public contracts only.
export * from './public/types'
