import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomMetricsOptions} from './public/custom'
import type {DevelopmentMetricsOptions} from './public/development'
import type {ProductionMetricsOptions} from './public/production'
import type {ManagedMetrics} from './public/types'

export type {
	ManagedMetrics,
	MetricBatch,
	MetricExporter,
	MetricExportResult,
	MetricInstrumentDefinition,
	MetricInstrumentKind,
	MetricLabels,
	MetricRecord,
	MetricsRuntimeState,
	MetricsSinkState,
	MetricsStatus,
	PrometheusManagedMetrics,
	PrometheusScrapeSource
} from './public/types'

/**
 * Metrics registration options.
 * Supports all metrics presets via a discriminated union.
 */
export type MetricsOptions =
	| {
		preset: 'custom'
		options: Omit<CustomMetricsOptions, 'clock'> & {readonly clock?: never}
	}
	| {
		preset: 'development'
		options?: DevelopmentMetricsOptions
	}
	| {
		preset: 'production'
		options: ProductionMetricsOptions
	}

const registrationsInProgress = new WeakSet<object>()

type ContainerMethod = (...args: never[]) => unknown

function captureContainerMethod(container: object, key: PropertyKey): ContainerMethod | undefined {
	let current: object | null = container
	const visited = new Set<object>()
	try {
		while (current && !visited.has(current) && visited.size < 32) {
			visited.add(current)
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) {
				return 'value' in descriptor && typeof descriptor.value === 'function'
					? descriptor.value.bind(container) as ContainerMethod
					: undefined
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

const describePreset = (value: unknown): string => typeof value === 'string'
	? value.slice(0, 64)
	: `<${value === null ? 'null' : typeof value}>`

function snapshotDataFields(value: unknown, label: string): Record<string, unknown> {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error()
		const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable || !('value' in descriptor)) throw new Error()
			snapshot[key] = descriptor.value
		}
		return snapshot
	} catch {
		throw new TypeError(`${label} must contain only stable data fields`)
	}
}

function snapshotRegistration(value: unknown): MetricsOptions {
	if (!value || typeof value !== 'object') throw new Error('Metrics registration options are required')
	const registration = snapshotDataFields(value, 'Metrics registration options')
	if (Object.keys(registration).some((key) => key !== 'preset' && key !== 'options')) {
		throw new TypeError('Metrics registration options contain unexpected fields')
	}
	const preset = registration.preset
	if (preset !== 'development' && preset !== 'production' && preset !== 'custom') {
		throw new Error(`Unsupported metrics preset: ${describePreset(preset)}`)
	}
	if (registration.options === undefined) {
		if (preset !== 'development') throw new TypeError(`Metrics ${preset} registration options are required`)
		return {preset}
	}
	const options = snapshotDataFields(registration.options, `Metrics ${preset} options`)
	return {preset, options} as MetricsOptions
}
/**
 * Register metrics service with the container.
 * Resolves dependencies from container and binds the metrics handler.
 *
 * @param c - Dependency injection container
 * @param opts - Metrics configuration options
 */
export async function registerMetrics(
	c: Container,
	opts: MetricsOptions
): Promise<void> {
	if (!c || typeof c !== 'object') throw new TypeError('Metrics registration requires a valid container')
	// Own the registration before inspecting caller-controlled descriptors. A
	// proxy trap can re-enter synchronously before this function reaches an await.
	if (registrationsInProgress.has(c)) throw new Error('Metrics service is already registered')
	registrationsInProgress.add(c)
	try {
		const has = captureContainerMethod(c, 'has') as ((token: symbol) => boolean) | undefined
		const get = captureContainerMethod(c, 'get') as ((token: symbol) => unknown) | undefined
		const tryGet = captureContainerMethod(c, 'tryGet') as ((token: symbol) => unknown) | undefined
		const bind = captureContainerMethod(c, 'bind') as ((token: symbol, value: unknown) => void) | undefined
		const unbind = captureContainerMethod(c, 'unbind') as ((token: symbol) => boolean) | undefined
		if (!has || !get || !tryGet || !bind || !unbind) {
			throw new TypeError('Metrics registration requires a valid reversible container')
		}
		const stableContainer = {has, get, tryGet, bind, unbind}
		const registration = snapshotRegistration(opts)
		let alreadyRegistered: boolean
		try {
			alreadyRegistered = stableContainer.has(TOK.Metrics)
				|| stableContainer.tryGet(TOK.Metrics) !== undefined
		} catch {
			throw new Error('Metrics container lookup failed')
		}
		if (alreadyRegistered) throw new Error('Metrics service is already registered')
		await registerMetricsUnlocked(stableContainer, registration)
	} finally {
		registrationsInProgress.delete(c)
	}
}

async function registerMetricsUnlocked(
	c: {
		has(token: symbol): boolean
		get(token: symbol): unknown
		tryGet(token: symbol): unknown
		bind(token: symbol, value: unknown): void
		unbind(token: symbol): boolean
	},
	opts: MetricsOptions
): Promise<void> {

	let clock: Clock
	let logger: Logging | undefined
	let errors: Errors | undefined
	let lifecycle: LifecyclePort | undefined
	try {
		clock = c.get(TOK.Clock) as Clock
		logger = c.tryGet(TOK.Logging) as Logging | undefined
		errors = c.tryGet(TOK.Errors) as Errors | undefined
		lifecycle = c.tryGet(TOK.Lifecycle) as LifecyclePort | undefined
	} catch {
		throw new Error('Metrics dependency resolution failed')
	}
	const containerDefaults = {
		clock,
		...(logger ? {logger} : {}),
		...(errors ? {errors} : {}),
		...(lifecycle ? {lifecycle} : {})
	}

	let metrics: ManagedMetrics

	switch (opts.preset) {
		case 'custom': {
			const {createCustomMetrics} = await import('./public/custom')
			metrics = await createCustomMetrics({
				...opts.options,
				...containerDefaults
			})
			break
		}
		case 'development': {
			const {createDevelopmentMetrics} = await import('./public/development')
			metrics = await createDevelopmentMetrics({
				...opts.options,
				...containerDefaults
			})
			break
		}
		case 'production': {
			const {createProductionMetrics} = await import('./public/production')
			metrics = await createProductionMetrics({
				...opts.options,
				...containerDefaults
			})
			break
		}
	}

	let bindAttempted = false
	let publicRegistrationFailure: Error | undefined
	const hasMetricsBinding = (): boolean => c.has(TOK.Metrics) || c.tryGet(TOK.Metrics) !== undefined
	try {
		if (hasMetricsBinding()) {
			publicRegistrationFailure = new Error('Metrics service was registered during runtime creation')
			throw publicRegistrationFailure
		}
		bindAttempted = true
		c.bind(TOK.Metrics, metrics)
		if (!c.has(TOK.Metrics) || c.tryGet(TOK.Metrics) !== metrics) {
			publicRegistrationFailure = new Error('Metrics container did not retain the expected binding')
			throw publicRegistrationFailure
		}
	} catch {
		const registrationFailure = publicRegistrationFailure ?? new Error('Metrics registration failed')
		const cleanupErrors: Error[] = []
		try {
			if (bindAttempted) {
				c.unbind(TOK.Metrics)
				if (hasMetricsBinding()) {
					throw new Error('Metrics registration rollback failed')
				}
			}
		} catch {
			cleanupErrors.push(new Error('Metrics registration rollback failed'))
		}
		try {
			await metrics.shutdown()
		} catch {
			cleanupErrors.push(new Error('Metrics registration cleanup failed'))
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[registrationFailure, ...cleanupErrors],
				'Metrics registration and rollback failed'
			)
		}
		throw registrationFailure
	}
}
