/**
 * @file Browser-side Grafana Faro helpers.
 * Keeps browser telemetry contracts in sdk instead of core.
 */

import {
	CSPInstrumentation,
	ConsoleInstrumentation,
	ErrorsInstrumentation,
	getWebInstrumentations,
	initializeFaro,
	NavigationInstrumentation,
	PerformanceInstrumentation,
	SessionInstrumentation,
	type BrowserConfig,
	type EventAttributes,
	type Instrumentation,
	LogLevel,
	type MetaAttributes,
	type MetaUser,
	type PushErrorOptions,
	type PushLogOptions,
	UserActionInstrumentation,
	ViewInstrumentation,
	WebVitalsInstrumentation
} from '@grafana/faro-web-sdk'
import type {PerformancePort} from '@ooopsstudio/core/ports/performance'

import {captureSingleFlightCallback} from './callback-flight'
import {getFaroBrowserState, setFaroBrowserState} from './faro-browser-state'
import type {FaroBrowserClient} from './faro-browser-types'
import {
	startBrowserObservers,
	type BrowserObserverStartOptions
} from './performance-browser'
import {isSafeTelemetryLabelKey} from './performance-browser-runtime'
import {ignorePromiseRejection} from './performance-port-method'
import {isRuntimeProxy} from './runtime-object'

const FARO_INIT_FIELDS = [
	'config', 'enableDefaultInstrumentations', 'captureConsole',
	'enablePerformanceInstrumentation', 'enableContentSecurityPolicyInstrumentation',
	'enableErrorsInstrumentation', 'enableUserActionInstrumentation'
]
const FARO_CONFIG_FIELDS = ['url', 'apiKey', 'app']
const FARO_APP_FIELDS = ['name', 'version', 'environment']
const FARO_EVENT_FIELDS = ['name', 'attributes', 'domain', 'timestamp']
const FARO_ERROR_FIELDS = ['type', 'attributes']
const FARO_LOG_FIELDS = ['attributes']
const FARO_USER_FIELDS = ['id', 'email', 'username', 'attributes']
const FARO_BRIDGE_FIELDS = ['dedupeLifecycleEvents']
const FARO_OBSERVER_FIELDS = [
	'client', 'bridgeOptions', 'preset', 'webVitals', 'longTasks', 'resourceFailures',
	'aggregationIntervalMs', 'maxAggregationKeys', 'route', 'hostKind', 'labels'
]
type FaroApiMethodName = keyof FaroBrowserClient['api']
type CapturedFaroApiMethod = {api: object; method: (...args: never[]) => unknown}
const invalidFaroInit = (): never => { throw new TypeError('SDK_FARO_INIT_OPTIONS_INVALID') }
const runFaroSetup = captureSingleFlightCallback(((setup: () => unknown) => setup()) as (
	...args: never[]
) => unknown) as <T>(setup: () => T) => T | undefined
const captureFaroSetup = (setup: () => unknown): void => {
	try { runFaroSetup(setup) } catch { /* telemetry delivery is observational */ }
}

const faroString = (value: unknown, maximum: number, optional = false): string | undefined => {
	ignorePromiseRejection(value)
	if (value === undefined && optional) return undefined
	return typeof value === 'string' && (optional || value) && value.length <= maximum ? value : invalidFaroInit()
}

const faroFlag = (value: unknown): boolean | undefined => {
	ignorePromiseRejection(value)
	return value === undefined || typeof value === 'boolean' ? value : invalidFaroInit()
}

const telemetryString = (value: unknown, maximum: number, required = false): string | undefined => {
	ignorePromiseRejection(value)
	return typeof value === 'string' && value.length <= maximum && (!required || value) ? value : undefined
}

const telemetryDimension = (value: unknown): string | undefined => {
	ignorePromiseRejection(value)
	return typeof value === 'string' && !value[256] && /^[a-z][\w.-]*$/i.test(value) ? value : undefined
}

export interface FaroBrowserTransportConfig {
	readonly url: string
	readonly apiKey?: string
	readonly app: {
		readonly name: string
		readonly version?: string
		readonly environment?: string
	}
}

export interface FaroBrowserUser {
	readonly id?: string
	readonly email?: string
	readonly username?: string
	readonly attributes?: Record<string, unknown>
}

export interface FaroBrowserEvent {
	readonly name: string
	readonly attributes?: Record<string, unknown>
	readonly domain?: string
	readonly timestamp?: string
}

export interface FaroBrowserErrorContext {
	readonly type?: string
	readonly attributes?: Record<string, unknown>
}

export interface FaroBrowserLogContext {
	readonly attributes?: Record<string, unknown>
}

export interface FaroBrowserInitOptions {
	readonly config: FaroBrowserTransportConfig
	readonly enableDefaultInstrumentations?: boolean
	readonly captureConsole?: boolean
	readonly enablePerformanceInstrumentation?: boolean
	readonly enableContentSecurityPolicyInstrumentation?: boolean
	/** Enables global error and unhandled-rejection capture. */
	readonly enableErrorsInstrumentation?: boolean
	/** Enables automatic DOM user-action capture. */
	readonly enableUserActionInstrumentation?: boolean
}

export interface FaroBrowserPerformanceBridgeOptions {
	readonly dedupeLifecycleEvents?: boolean
}

type FaroPerformanceBridge = {
	captureLifecycleEvent(name: LifecycleEventName, attributes?: Record<string, unknown>): void
	captureCustomEvent(name: string, attributes?: Record<string, unknown>): void
}

export interface FaroBrowserObserverStartOptions extends Omit<BrowserObserverStartOptions, 'performance'> {
	readonly client: FaroBrowserClient
	readonly bridgeOptions?: FaroBrowserPerformanceBridgeOptions
}

type LifecycleEventName = 'browser.page_load' | 'browser.navigation'

export type {FaroBrowserClient} from './faro-browser-types'

const snapshotFaroRecord = (
	value: unknown,
	allowed: readonly string[]
): Readonly<Record<string, unknown>> => {
	ignorePromiseRejection(value)
	if (!value || typeof value !== 'object' || isRuntimeProxy(value)) {
		return invalidFaroInit()
	}
	try {
		const keys = Reflect.ownKeys(value)
		if (keys.length > allowed.length) throw new TypeError()
		const snapshot: Record<string, unknown> = {}
		for (const key of keys) {
			if (typeof key !== 'string' || !allowed.includes(key)) throw new TypeError()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError()
			snapshot[key] = descriptor.value
		}
		return snapshot
	} catch {
		return invalidFaroInit()
	}
}

const snapshotFaroInitOptions = (value: FaroBrowserInitOptions): FaroBrowserInitOptions => {
	const input = snapshotFaroRecord(value, FARO_INIT_FIELDS)
	const configInput = snapshotFaroRecord(input.config, FARO_CONFIG_FIELDS)
	const appInput = snapshotFaroRecord(configInput.app, FARO_APP_FIELDS)
	return {
		config: {
			url: faroString(configInput.url, 2_048),
			apiKey: faroString(configInput.apiKey, 4_096, true),
			app: {
				name: faroString(appInput.name, 256),
				version: faroString(appInput.version, 256, true),
				environment: faroString(appInput.environment, 256, true)
			}
		},
		enableDefaultInstrumentations: faroFlag(input.enableDefaultInstrumentations),
		captureConsole: faroFlag(input.captureConsole),
		enablePerformanceInstrumentation: faroFlag(input.enablePerformanceInstrumentation),
		enableContentSecurityPolicyInstrumentation: faroFlag(input.enableContentSecurityPolicyInstrumentation),
		enableErrorsInstrumentation: faroFlag(input.enableErrorsInstrumentation),
		enableUserActionInstrumentation: faroFlag(input.enableUserActionInstrumentation)
	} as FaroBrowserInitOptions
}

function stringifyAttributeValue(value: unknown): string {
	if (typeof value === 'string') {
		return value.slice(0, 4_096)
	}
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value)
	}
	if (value == null) {
		return ''
	}
	return '[unserializable]'
}

function toMetaAttributes(attributes?: Record<string, unknown>): MetaAttributes | undefined {
	if (!attributes) return undefined
	ignorePromiseRejection(attributes)
	const result: Record<string, string> = {}
	try {
		if (isRuntimeProxy(attributes)) throw new TypeError()
		const keys = Reflect.ownKeys(attributes)
		if (keys.length > 32 || keys.some((key) => typeof key !== 'string')) throw new TypeError()
		for (const key of keys as string[]) {
			const descriptor = Object.getOwnPropertyDescriptor(attributes, key)
			if (isSafeTelemetryLabelKey(key) && descriptor?.enumerable && 'value' in descriptor) {
				result[key] = stringifyAttributeValue(descriptor.value)
			}
		}
	} catch { return undefined }
	return Object.keys(result).length ? result : undefined
}

function buildInitKey(options: FaroBrowserInitOptions): string {
	return JSON.stringify({
		url: options.config.url,
		apiKey: options.config.apiKey,
		app: options.config.app,
		enableDefaultInstrumentations: !!options.enableDefaultInstrumentations,
		captureConsole: !!options.captureConsole,
		enablePerformanceInstrumentation: !!options.enablePerformanceInstrumentation,
		enableContentSecurityPolicyInstrumentation: !!options.enableContentSecurityPolicyInstrumentation,
		enableErrorsInstrumentation: options.enableErrorsInstrumentation,
		enableUserActionInstrumentation: options.enableUserActionInstrumentation
	})
}

function buildConsentScopedInstrumentations(options: FaroBrowserInitOptions): Instrumentation[] {
	const instrumentations: Instrumentation[] = []
	if (options.enablePerformanceInstrumentation) {
		// Start this first so the current navigation can be observed.
		instrumentations.push(new PerformanceInstrumentation())
	}
	instrumentations.push(new SessionInstrumentation(), new ViewInstrumentation())
	if (options.enablePerformanceInstrumentation) {
		instrumentations.push(new WebVitalsInstrumentation(), new NavigationInstrumentation())
	}
	if (options.enableErrorsInstrumentation) instrumentations.push(new ErrorsInstrumentation())
	if (options.enableContentSecurityPolicyInstrumentation) instrumentations.push(new CSPInstrumentation())
	if (options.enableUserActionInstrumentation) instrumentations.push(new UserActionInstrumentation())
	if (options.captureConsole) instrumentations.push(new ConsoleInstrumentation())
	return instrumentations
}

function buildBrowserConfig(options: FaroBrowserInitOptions): BrowserConfig {
	const config: BrowserConfig = {
		url: options.config.url,
		app: {
			name: options.config.app.name,
			...(options.config.app.version ? {version: options.config.app.version} : {}),
			...(options.config.app.environment ? {environment: options.config.app.environment} : {})
		},
		...(options.config.apiKey ? {apiKey: options.config.apiKey} : {})
	}

	const useConsentScopedInstrumentations =
		options.enableErrorsInstrumentation !== undefined ||
		options.enableUserActionInstrumentation !== undefined
	const instrumentations = !options.enableDefaultInstrumentations ? [] :
		useConsentScopedInstrumentations ? buildConsentScopedInstrumentations(options) :
			getWebInstrumentations({
				captureConsole: !!options.captureConsole,
				enablePerformanceInstrumentation: !!options.enablePerformanceInstrumentation,
				enableContentSecurityPolicyInstrumentation: !!options.enableContentSecurityPolicyInstrumentation
			}) as Instrumentation[]
	return {...config, instrumentations}
}

function toError(value: unknown): Error {
	ignorePromiseRejection(value)
	return !isRuntimeProxy(value) && value instanceof Error
		? value : new Error(stringifyAttributeValue(value))
}

function isLifecycleEventName(name: string): name is LifecycleEventName {
	return name === 'browser.page_load' || name === 'browser.navigation'
}

const captureFaroApiMethod = (
	client: FaroBrowserClient,
	key: FaroApiMethodName
): CapturedFaroApiMethod | undefined => {
	ignorePromiseRejection(client)
	try {
		if (!client || typeof client !== 'object' || isRuntimeProxy(client)) return undefined
		const apiDescriptor = Object.getOwnPropertyDescriptor(client, 'api')
		if (!apiDescriptor || !('value' in apiDescriptor) || !apiDescriptor.value ||
			(typeof apiDescriptor.value !== 'object' && typeof apiDescriptor.value !== 'function') ||
			isRuntimeProxy(apiDescriptor.value)) return undefined
		const api = apiDescriptor.value as object
		let owner: object | null = api
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function'
				? {api, method: descriptor.value as (...args: never[]) => unknown} : undefined
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { /* malformed Faro clients are ignored */ }
	return undefined
}

const faroPerformanceEventSinks = new WeakMap<object, (event: FaroBrowserEvent) => void>()

const createFaroPerformanceEventSink = (
	client: FaroBrowserClient
): ((event: FaroBrowserEvent) => void) => {
	ignorePromiseRejection(client)
	const cached = faroPerformanceEventSinks.get(client)
	if (cached) return cached
	const captured = captureFaroApiMethod(client, 'pushEvent')
	const deliver = captured ? captureSingleFlightCallback(((event: FaroBrowserEvent) => {
		const snapshot = snapshotFaroRecord(event, FARO_EVENT_FIELDS)
		const name = telemetryDimension(snapshot.name)
		if (!name) return undefined
		return Reflect.apply(captured.method, captured.api, [
			name,
			toMetaAttributes(snapshot.attributes as Record<string, unknown> | undefined) as EventAttributes | undefined,
			telemetryDimension(snapshot.domain)
		])
	}) as (...args: never[]) => unknown) : undefined
	const sink = (event: FaroBrowserEvent): void => { deliver?.(event as never) }
	faroPerformanceEventSinks.set(client, sink)
	return sink
}

function toFaroPerformanceAttributes(
	attributes?: Record<string, unknown>,
	extra?: Record<string, unknown>
): Record<string, unknown> | undefined {
	const safeAttributes = toMetaAttributes(attributes) ?? {}
	const {host_kind: hostKind, navigation_type: navigationType, ...rest} = safeAttributes
	const normalized = {
		...rest,
		...(hostKind !== undefined ? {hostKind} : {}),
		...(navigationType !== undefined ? {navigationType} : {}),
		...(extra ?? {})
	}
	return Object.keys(normalized).length ? normalized : undefined
}

function getNow(): number {
	try {
		const perf = globalThis.performance
		if (perf && typeof perf.now === 'function') {
			const timestamp: unknown = perf.now()
			ignorePromiseRejection(timestamp)
			if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp
		}
	} catch { /* fall back to the wall clock */ }
	try {
		const timestamp = Date.now()
		return Number.isFinite(timestamp) ? timestamp : 0
	} catch {
		return 0
	}
}

export function initFaroBrowser(options: FaroBrowserInitOptions): FaroBrowserClient {
	return runFaroSetup(() => {
		const snapshot = snapshotFaroInitOptions(options)
		const key = buildInitKey(snapshot)
		const state = getFaroBrowserState()
		if (state.client && state.key === key) return state.client
		const client = initializeFaro(buildBrowserConfig(snapshot)) as unknown as FaroBrowserClient
		setFaroBrowserState(key, client)
		return client
	}) ?? invalidFaroInit()
}

export function captureFaroBrowserEvent(
	client: FaroBrowserClient,
	event: FaroBrowserEvent
): void {
	captureFaroSetup(() => {
		createFaroPerformanceEventSink(client)(event)
	})
}

export function captureFaroBrowserError(
	client: FaroBrowserClient,
	error: unknown,
	context?: FaroBrowserErrorContext
): void {
	captureFaroSetup(() => {
		const captured = captureFaroApiMethod(client, 'pushError')
		if (!captured) return undefined
		const snapshot = context ? snapshotFaroRecord(context, FARO_ERROR_FIELDS) : {}
		const errorContext = toMetaAttributes(snapshot.attributes as Record<string, unknown> | undefined)
		const type = telemetryDimension(snapshot.type)
		return Reflect.apply(captured.method, captured.api, [toError(error), {
			...(type ? {type} : {}),
			...(errorContext ? {context: errorContext} : {})
		} as PushErrorOptions])
	})
}

export function captureFaroBrowserLog(
	client: FaroBrowserClient,
	level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
	message: string,
	context?: FaroBrowserLogContext
): void {
	captureFaroSetup(() => {
		const captured = captureFaroApiMethod(client, 'pushLog')
		if (!captured) return undefined
		const snapshot = context ? snapshotFaroRecord(context, FARO_LOG_FIELDS) : {}
		const logContext = toMetaAttributes(snapshot.attributes as Record<string, unknown> | undefined)
		return Reflect.apply(captured.method, captured.api, [[telemetryString(message, 4_096) ?? ''], {
			level: level === 'error' ? LogLevel.ERROR : level === 'warn' ? LogLevel.WARN : level === 'info' ? LogLevel.INFO : level === 'debug' ? LogLevel.DEBUG : LogLevel.TRACE,
			...(logContext ? {context: logContext} : {})
		} as PushLogOptions])
	})
}

export function setFaroBrowserUser(
	client: FaroBrowserClient,
	user: FaroBrowserUser
): void {
	captureFaroSetup(() => {
		const captured = captureFaroApiMethod(client, 'setUser')
		if (!captured) return undefined
		const snapshot = snapshotFaroRecord(user, FARO_USER_FIELDS)
		const userAttributes = toMetaAttributes(snapshot.attributes as Record<string, unknown> | undefined)
		const id = telemetryString(snapshot.id, 256)
		const email = telemetryString(snapshot.email, 512)
		const username = telemetryString(snapshot.username, 256)
		return Reflect.apply(captured.method, captured.api, [{
			...(id ? {id} : {}),
			...(email ? {email} : {}),
			...(username ? {username} : {}),
			...(userAttributes ? {attributes: userAttributes} : {})
		} as MetaUser])
	})
}

export function createFaroBrowserPerformanceBridge(
	client: FaroBrowserClient,
	options: FaroBrowserPerformanceBridgeOptions = {}
): FaroPerformanceBridge {
	return runFaroSetup(() => {
		const snapshot = snapshotFaroRecord(options, FARO_BRIDGE_FIELDS)
		const seenLifecycleEvents = new Set<LifecycleEventName>()
		const captureEvent = createFaroPerformanceEventSink(client)
		const dedupe = snapshot.dedupeLifecycleEvents !== false
		const deliver = (name: string, attributes?: Record<string, unknown>): void =>
			captureEvent({name, ...(attributes ? {attributes} : {}), domain: 'performance'})

		return {
			captureLifecycleEvent(name: LifecycleEventName, attributes?: Record<string, unknown>) {
				if (dedupe && seenLifecycleEvents.has(name)) return
				seenLifecycleEvents.add(name)
				try { deliver(name, attributes) } catch(error) {
					seenLifecycleEvents.delete(name)
					throw error
				}
			},
			captureCustomEvent(name: string, attributes?: Record<string, unknown>) {
				deliver(name, attributes)
			}
		}
	}) ?? invalidFaroInit()
}

export function createFaroBrowserPerformancePort(
	client: FaroBrowserClient,
	options: FaroBrowserPerformanceBridgeOptions = {}
): Pick<PerformancePort, 'record' | 'measureAsync'> {
	const bridge = createFaroBrowserPerformanceBridge(client, options)
	const normalize = captureSingleFlightCallback(((labels?: Record<string, string>) =>
		toMetaAttributes(labels)) as (...args: never[]) => unknown) as (
		labels?: Record<string, string>
	) => Record<string, string> | undefined
	const capture = captureSingleFlightCallback(((
		name: string,
		labels: Record<string, string> | undefined,
		extra: Record<string, unknown>
	): void => {
		try {
			const attributes = toFaroPerformanceAttributes(labels, extra)
			if (isLifecycleEventName(name)) {
				bridge.captureLifecycleEvent(name, attributes)
				return
			}
			bridge.captureCustomEvent(name, attributes)
		} catch {
			// Faro delivery is observational and must not affect the host.
		}
	}) as (...args: never[]) => unknown) as (
		name: string, labels: Record<string, string> | undefined, extra: Record<string, unknown>
	) => void

	return {
		record(name, value, labels) { capture(name, labels, {value}) },
		async measureAsync<T>(name: string, fn: () => Promise<T>, labels?: Record<string, string>): Promise<T> {
			const safeLabels = normalize(labels)
			const startedAt = getNow()
			let outcome: 'ok' | 'error' = 'ok'
			try {
				return await fn()
			} catch(error) {
				outcome = 'error'
				throw error
			} finally {
				try {
					const durationMs = Math.max(0, getNow() - startedAt)
					capture(name, safeLabels, {
						durationMs,
						...(outcome === 'error' ? {outcome} : {})
					})
				} catch {
					// Preserve the authoritative operation result or failure.
				}
			}
		}
	}
}

const startFaroObservers = captureSingleFlightCallback(((options: FaroBrowserObserverStartOptions): (() => void) => {
	const observerOptions = snapshotFaroRecord(options, FARO_OBSERVER_FIELDS)
	return startBrowserObservers({
		...observerOptions,
		performance: createFaroBrowserPerformancePort(
			observerOptions.client as FaroBrowserClient,
			observerOptions.bridgeOptions as FaroBrowserPerformanceBridgeOptions
		)
	} as unknown as BrowserObserverStartOptions)
}) as (...args: never[]) => unknown) as (options: FaroBrowserObserverStartOptions) => (() => void) | undefined

export function startFaroBrowserObservers(options: FaroBrowserObserverStartOptions): () => void {
	return startFaroObservers(options) || (() => {})
}
