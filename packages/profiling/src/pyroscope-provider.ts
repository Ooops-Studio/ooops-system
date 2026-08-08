import {URL} from 'node:url'

import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {ContinuousProfiler, ContinuousProfilerStatus} from '@ooopsstudio/core/ports/profiling'

type Credentials = {readonly username: string; readonly password: string}
type Connection =
	| {readonly mode: 'grafana-cloud'; readonly serverAddress: string; readonly credentials: Credentials}
	| {readonly mode: 'alloy'; readonly serverAddress: string}
	| {readonly mode: 'self-hosted'; readonly serverAddress: string; readonly credentials?: Credentials; readonly tenantId?: string}

export interface PyroscopeProfilingOptions {
	readonly applicationName: string
	readonly connection: Connection
	readonly resource?: ObservabilityResource
	readonly tags?: Partial<Record<'environment' | 'region' | 'version' | 'build' | 'team', string>>
	readonly flushIntervalMs?: number
	readonly wall?: {readonly samplingDurationMs?: number; readonly samplingIntervalMicros?: number; readonly collectCpuTime?: boolean}
}

interface PyroscopeSdkRuntime {
	init(config: Record<string, unknown>): Promise<void> | void
	startCpuProfiling(): Promise<void> | void
	stopCpuProfiling(): Promise<void> | void
}
type PyroscopeSdk = {readonly default: PyroscopeSdkRuntime}
export type PyroscopeSdkLoader = () => Promise<PyroscopeSdk>

const SDK_TIMEOUT_MS = 30_000
const PROCESS_OWNERS = Symbol.for('@ooops/profiling:owners:v1')
type ProcessOwners = {m?: object; i?: symbol; c?: object; p?: symbol; s: WeakMap<object, object>; d: WeakMap<object, object>}
const processScope = process as typeof process & {[PROCESS_OWNERS]?: ProcessOwners}
const owners = processScope[PROCESS_OWNERS]
	?? (processScope[PROCESS_OWNERS] = {s: new WeakMap(), d: new WeakMap()})
const TAG_KEYS = ['environment', 'region', 'version', 'build', 'team'] as const
const SDK_ENV_KEYS = [
	'PYROSCOPE_ADHOC_SERVER_ADDRESS', 'PYROSCOPE_APPLICATION_NAME', 'PYROSCOPE_AUTH_TOKEN', 'PYROSCOPE_FLUSH_INTERVAL_MS',
	'PYROSCOPE_HEAP_SAMPLING_INTERVAL_BYTES', 'PYROSCOPE_HEAP_STACK_DEPTH', 'PYROSCOPE_SERVER_ADDRESS',
	'PYROSCOPE_SHORTEN_PATHS', 'PYROSCOPE_STRIP_FILENAMES', 'PYROSCOPE_WALL_COLLECT_CPU_TIME',
	'PYROSCOPE_WALL_SAMPLING_DURATION_MS', 'PYROSCOPE_WALL_SAMPLING_INTERVAL_MICROS'
]

function timeout<T>(physical: Promise<T>, code: string, onTimeout?: () => void): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([physical, new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => { onTimeout?.(); reject(Error(code)) }, SDK_TIMEOUT_MS)
	})])
		.finally(() => { if (timer) clearTimeout(timer) })
}

const SENSITIVE_TAG_VALUE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]*|\+?[\d.-]{7,15}|[0-9a-f]{24,}|[A-Za-z0-9_/-]{32,}|(?:[A-Za-z0-9_-]{8,}\.){2}[A-Za-z0-9_-]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu
const AWS_ACCESS_KEY = /(?:AKIA|ASIA)[A-Z0-9]{16}/u
const sanitizeTag = (value: string): string | undefined => {
	if (!/^[A-Za-z0-9_.:/-]{1,128}$/u.test(value) || /(?:token|secret|password|authorization|cookie)/iu.test(value)) return undefined
	return value.includes('://') || AWS_ACCESS_KEY.test(value) || SENSITIVE_TAG_VALUE.test(value)
		|| value.split(/[/:]/u).some((segment) => SENSITIVE_TAG_VALUE.test(segment)) ? 'redacted' : value
}
const safeTenant = (value: string): boolean => /^[A-Za-z0-9_.-]{1,128}$/u.test(value)

function readData<T = unknown>(value: object, key: PropertyKey, code: string): T | undefined {
	let descriptor: PropertyDescriptor | undefined
	try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw Error(code) }
	if (!descriptor) return undefined
	if (!('value' in descriptor)) throw Error(code)
	return descriptor.value as T
}

const errorMessage = (value: unknown): unknown => {
	try { return value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'message')?.value } catch { /* unknown */ }
}

const defaultLoader: PyroscopeSdkLoader = async() => {
	const packageName = '@pyroscope/nodejs'
	return await import(packageName) as PyroscopeSdk
}

function rejectSdkEnvironment(): void {
	if (SDK_ENV_KEYS.some((key) => process.env[key] !== undefined)) throw Error('pyroscope_environment_overrides_forbidden')
}

function snapshotCredentials(value: unknown): Readonly<Credentials> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('pyroscope_invalid_credentials')
	let username: unknown; let password: unknown
	try {
		const userDescriptor = Object.getOwnPropertyDescriptor(value, 'username')
		const passwordDescriptor = Object.getOwnPropertyDescriptor(value, 'password')
		username = userDescriptor && 'value' in userDescriptor ? userDescriptor.value : undefined
		password = passwordDescriptor && 'value' in passwordDescriptor ? passwordDescriptor.value : undefined
	} catch { throw Error('pyroscope_invalid_credentials') }
	if (typeof username !== 'string' || !safeTenant(username) || typeof password !== 'string' || password.length < 1 || password.length > 1_024) throw Error('pyroscope_invalid_credentials')
	return Object.freeze({username, password})
}

function resourceTags(resource: ObservabilityResource | undefined): Record<string, string> {
	if (resource === undefined) return {}
	if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw Error('pyroscope_invalid_resource')
	const values: Record<string, string> = {}
	const read = (key: keyof ObservabilityResource): unknown => {
		try { const descriptor = Object.getOwnPropertyDescriptor(resource, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined } catch { throw Error('pyroscope_invalid_resource') }
	}
	for (const [source, target] of [
		['serviceName', 'service'], ['serviceVersion', 'version'],
		['deploymentEnvironment', 'environment'], ['hostKind', 'host_kind'], ['runtime', 'runtime']
	] as const) {
		const value = read(source)
		if (value !== undefined) {
			const sanitized = typeof value === 'string' ? sanitizeTag(value) : undefined
			if (!sanitized) throw Error('pyroscope_invalid_resource')
			values[target] = sanitized
		}
	}
	return values
}

export function createPyroscopeProfiling(options: PyroscopeProfilingOptions): ContinuousProfiler {
	return createPyroscopeProfilingWithSdk(options, defaultLoader)
}

export function createPyroscopeProfilingWithSdk(options: PyroscopeProfilingOptions, loadSdk: PyroscopeSdkLoader): ContinuousProfiler {
	if (typeof loadSdk !== 'function' || !options || typeof options !== 'object' || Array.isArray(options)) throw Error('pyroscope_invalid_options')
	const applicationName = readData(options, 'applicationName', 'pyroscope_invalid_options')
	const connection = readData<Connection>(options, 'connection', 'pyroscope_invalid_options')
	const configuredTags = readData<PyroscopeProfilingOptions['tags']>(options, 'tags', 'pyroscope_invalid_options')
	const flushIntervalMs = readData(options, 'flushIntervalMs', 'pyroscope_invalid_options')
	const wall = readData<PyroscopeProfilingOptions['wall']>(options, 'wall', 'pyroscope_invalid_options')
	const resource = readData<ObservabilityResource>(options, 'resource', 'pyroscope_invalid_options')
	if (typeof applicationName !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/iu.test(applicationName)) throw Error('pyroscope_invalid_application_name')
	if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw Error('pyroscope_invalid_connection')
	const mode = readData<Connection['mode']>(connection, 'mode', 'pyroscope_invalid_connection')
	const serverAddress = readData(connection, 'serverAddress', 'pyroscope_invalid_connection')
	const rawCredentials = readData(connection, 'credentials', 'pyroscope_invalid_connection')
	const credentials = rawCredentials === undefined ? undefined : snapshotCredentials(rawCredentials)
	const tenantId = readData(connection, 'tenantId', 'pyroscope_invalid_connection')
	if (typeof mode !== 'string' || !['grafana-cloud', 'alloy', 'self-hosted'].includes(mode)) throw Error('pyroscope_invalid_connection_mode')
	if (mode === 'grafana-cloud' && !credentials) throw Error('pyroscope_credentials_required')
	if (mode === 'alloy' && credentials) throw Error('pyroscope_credentials_forbidden')
	if (mode !== 'self-hosted' && tenantId !== undefined) throw Error('pyroscope_tenant_forbidden')
	if (typeof serverAddress !== 'string' || serverAddress.length > 2_048) throw Error('pyroscope_invalid_server_address')
	let endpoint: URL
	try { endpoint = new URL(serverAddress) } catch { throw Error('pyroscope_invalid_server_address') }
	if (endpoint.username || endpoint.password) throw Error('pyroscope_embedded_credentials_forbidden')
	if (endpoint.search || endpoint.hash) throw Error('pyroscope_url_parameters_forbidden')
	if (!['http:', 'https:'].includes(endpoint.protocol)) throw Error('pyroscope_invalid_protocol')
	if (mode === 'grafana-cloud' && endpoint.protocol !== 'https:') throw Error('pyroscope_cloud_requires_https')
	if (credentials && endpoint.protocol !== 'https:') throw Error('pyroscope_credentials_require_https')
	const normalizedServerAddress = endpoint.href.replace(/\/$/u, '')
	if (tenantId !== undefined && (typeof tenantId !== 'string' || !safeTenant(tenantId))) throw Error('pyroscope_invalid_tenant')
	if (flushIntervalMs !== undefined && (!Number.isSafeInteger(flushIntervalMs) || (flushIntervalMs as number) < 1_000 || (flushIntervalMs as number) > 300_000)) throw new Error('pyroscope_invalid_flush_interval')
	if (wall !== undefined && (!wall || typeof wall !== 'object' || Array.isArray(wall))) throw new Error('pyroscope_invalid_wall_options')
	const samplingDurationMs = wall ? readData(wall, 'samplingDurationMs', 'pyroscope_invalid_wall_options') : undefined
	const samplingIntervalMicros = wall ? readData(wall, 'samplingIntervalMicros', 'pyroscope_invalid_wall_options') : undefined
	const collectCpuTime = wall ? readData(wall, 'collectCpuTime', 'pyroscope_invalid_wall_options') : undefined
	if (samplingDurationMs !== undefined && (!Number.isSafeInteger(samplingDurationMs) || (samplingDurationMs as number) < 1_000 || (samplingDurationMs as number) > 300_000)) throw new Error('pyroscope_invalid_wall_duration')
	if (samplingIntervalMicros !== undefined && (!Number.isSafeInteger(samplingIntervalMicros) || (samplingIntervalMicros as number) < 100 || (samplingIntervalMicros as number) > 1_000_000)) throw new Error('pyroscope_invalid_wall_interval')
	if (collectCpuTime !== undefined && typeof collectCpuTime !== 'boolean') throw Error('pyroscope_invalid_collect_cpu_time')
	const tags = resourceTags(resource)
	if (configuredTags !== undefined) {
		if (!configuredTags || typeof configuredTags !== 'object' || Array.isArray(configuredTags)) throw Error('pyroscope_invalid_tags')
		for (const key of TAG_KEYS) {
			const value = readData(configuredTags, key, 'pyroscope_invalid_tags')
			if (value !== undefined) {
				const sanitized = typeof value === 'string' ? sanitizeTag(value) : undefined
				if (!sanitized) throw Error('pyroscope_invalid_tags')
				tags[key] = sanitized
			}
		}
	}
	Object.freeze(tags)
	const sdkConfig = Object.freeze({
		appName: applicationName,
		serverAddress: normalizedServerAddress,
		tags,
		...(flushIntervalMs ? {flushIntervalMs} : {}),
		wall: {samplingDurationMs, samplingIntervalMicros, collectCpuTime: collectCpuTime ?? true},
		...(credentials ? {
			basicAuthUser: credentials.username,
			basicAuthPassword: credentials.password
		} : {}),
		...(tenantId ? {tenantID: tenantId} : {})
	})
	const recoveryConfig = Object.freeze({...sdkConfig, serverAddress: 'unsupported:', basicAuthUser: undefined, basicAuthPassword: undefined, tenantID: undefined})
	const owner = Symbol('pyroscope-owner')
	let state: ContinuousProfilerStatus['state'] = 'idle'; let healthy = true; let lastFailureCode: string | undefined
	let sdk: PyroscopeSdkRuntime | undefined; let started = false; let startSideEffectPending = false
	let startPhysical: Promise<void> | undefined; let startFlight: Promise<void> | undefined
	let stopPhysical: Promise<void> | undefined; let shutdownFlight: Promise<void> | undefined
	let stopQueue = Promise.resolve(); let stopTainted = false; let stopAttempted = false
	const pendingStops = new Set<Promise<unknown>>()
	let closeReady = false
	let resolveClose!: () => void
	const closeBarrier = new Promise<void>((resolve) => { resolveClose = resolve })

	const status = (): ContinuousProfilerStatus => Object.freeze({state, healthy, ...(lastFailureCode ? {lastFailureCode} : {})})
	const completeCloseIfSafe = (): void => {
		if (closeReady && !startSideEffectPending && pendingStops.size === 0 && !stopTainted) {
			state = 'closed'; healthy = false; lastFailureCode = undefined
			if (owners.p === owner) delete owners.p
			resolveClose()
		}
	}
	const markCloseReady = async(): Promise<void> => { closeReady = true; completeCloseIfSafe(); await closeBarrier }
	const trackStop = <T>(operation: Promise<T>): Promise<T> => {
		pendingStops.add(operation)
		void operation.finally(() => { pendingStops.delete(operation); completeCloseIfSafe() }).catch(() => undefined)
		return operation
	}
	const stopCpu = (): Promise<void> => {
		const operation = trackStop(stopQueue.catch(() => undefined).then(async() => {
			if (!sdk) return
			try {
				if (stopTainted) {
					rejectSdkEnvironment()
					await sdk.init(recoveryConfig)
					rejectSdkEnvironment()
					await sdk.startCpuProfiling()
				}
				stopAttempted = true
				await sdk.stopCpuProfiling()
				stopTainted = false
			} catch(error) { stopTainted = true; throw error }
		}))
		stopQueue = operation
		return operation
	}
	const fenceEarly = (): void => {
		const earlyStop = timeout(stopCpu(), 'pyroscope_early_shutdown_timeout')
		void earlyStop.catch(stopCpu).catch(() => undefined)
	}
	const provider: ContinuousProfiler = {
		async start(): Promise<void> {
			if (state === 'running') return
			if (state === 'draining' || state === 'closed') throw Error('pyroscope_not_startable')
			if (startFlight) return await startFlight
			if (startPhysical) return await timeout(startPhysical, 'pyroscope_start_timeout')
			if (owners.p || owners.m || owners.i || (owners.c && owners.d.get(provider) !== owners.c)) throw Error('pyroscope_already_active')
			owners.p = owner
			state = 'starting'; healthy = true; lastFailureCode = undefined
			sdk = undefined
			let timedOut = false
			const physical = Promise.resolve().then(async() => {
				let cpuStartAttempted = false
				try {
					const module = await loadSdk()
					if (timedOut || state !== 'starting') throw Error()
					rejectSdkEnvironment()
					const runtime = module && typeof module === 'object' ? readData<PyroscopeSdkRuntime>(module, 'default', 'pyroscope_invalid_sdk') : undefined
					const init = runtime && typeof runtime === 'object' ? readData<PyroscopeSdkRuntime['init']>(runtime, 'init', 'pyroscope_invalid_sdk') : undefined
					const startCpu = runtime && typeof runtime === 'object' ? readData<PyroscopeSdkRuntime['startCpuProfiling']>(runtime, 'startCpuProfiling', 'pyroscope_invalid_sdk') : undefined
					const stopCpu = runtime && typeof runtime === 'object' ? readData<PyroscopeSdkRuntime['stopCpuProfiling']>(runtime, 'stopCpuProfiling', 'pyroscope_invalid_sdk') : undefined
					if (typeof init !== 'function' || typeof startCpu !== 'function' || typeof stopCpu !== 'function') throw Error('pyroscope_invalid_sdk')
					sdk = {
						init: (config) => init.call(runtime, config),
						startCpuProfiling: () => startCpu.call(runtime),
						stopCpuProfiling: () => stopCpu.call(runtime)
					}
					await sdk.init(sdkConfig)
					if (timedOut || state !== 'starting') throw Error()
					rejectSdkEnvironment()
					// Starting is an ambiguous side effect: a rejected SDK promise may still
					// have activated the process-wide profiler. Fence ownership until stop
					// proves that the attempt is no longer physically active.
					started = true; cpuStartAttempted = true
					startSideEffectPending = true
					try { await sdk.startCpuProfiling() } finally { startSideEffectPending = false }
					if (timedOut || state !== 'starting') throw Error()
					state = 'running'; healthy = true; lastFailureCode = undefined
				} catch {
					if (cpuStartAttempted) {
						try { await stopCpu(); started = false }
						catch {
							state = 'draining'
							throw Error('PYROSCOPE_SHUTDOWN_FAILURE')
						}
					}
					if (state === 'starting') { state = 'idle'; if (owners.p === owner) delete owners.p }
					throw Error('PYROSCOPE_START_FAILURE')
				}
			})
			startPhysical = physical
			void physical.finally(() => { if (startPhysical === physical) startPhysical = undefined }).catch(() => undefined)
			startFlight = timeout(physical, 'pyroscope_start_timeout', () => {
				timedOut = true
				if (started) fenceEarly()
				if (!sdk && state === 'starting') { state = 'idle'; if (owners.p === owner) delete owners.p }
			}).catch((error) => {
				if (state !== 'closed') { healthy = false; lastFailureCode = 'PYROSCOPE_START_FAILURE' }
				throw error
			}).finally(() => { startFlight = undefined })
			return await startFlight
		},
		async shutdown(): Promise<void> {
			if (state === 'closed') return
			if (shutdownFlight) return await shutdownFlight
			state = 'draining'
			if (!sdk) {
				await markCloseReady()
				return
			}
			if (startPhysical && started) fenceEarly()
			if (!stopPhysical) {
				const physical = (async() => {
					if (startPhysical) try { await startPhysical } catch { /* failed initialization has nothing to stop */ }
					if (started) await stopCpu()
					started = false
				})().then(markCloseReady)
				stopPhysical = physical
				void physical.finally(() => { if (stopPhysical === physical) stopPhysical = undefined }).catch(() => undefined)
			}
			shutdownFlight = timeout(stopPhysical, 'pyroscope_shutdown_timeout')
				.catch((error) => {
					healthy = false
					lastFailureCode = 'PYROSCOPE_SHUTDOWN_FAILURE'
					if (errorMessage(error) === 'pyroscope_shutdown_timeout' && (!closeReady || stopTainted) && stopAttempted && sdk) {
						const runtime = sdk
						const recoveryCore = trackStop((async() => {
							rejectSdkEnvironment()
							await runtime.init(recoveryConfig)
							rejectSdkEnvironment()
							await runtime.startCpuProfiling()
							await runtime.stopCpuProfiling()
							started = false; stopTainted = false
						})())
						const recovery = recoveryCore.catch((recoveryError) => { stopTainted = true; throw recoveryError })
							.then(markCloseReady)
						// Keep the attempt marker set: if this isolated generation also
						// hangs, a later bounded shutdown must be able to supersede it.
						stopPhysical = recovery; stopQueue = recoveryCore
						void recovery.finally(() => { if (stopPhysical === recovery) stopPhysical = undefined }).catch(() => undefined)
					}
					throw Error(lastFailureCode)
				})
				.finally(() => { shutdownFlight = undefined })
			return await shutdownFlight
		},
		getStatus: status
	}
	return provider
}
