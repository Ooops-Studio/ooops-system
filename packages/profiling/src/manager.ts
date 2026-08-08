import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {ProfileCaptureOptions, ProfileCaptureSummary} from '@ooopsstudio/core/contracts/profiling'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {ContinuousProfiler, CpuProfileArtifact, CpuProfiler, ProfileExporter} from '@ooopsstudio/core/ports/profiling'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {sanitizeProfileLabels, sanitizeProfileName} from './labels'
import {emitProfilingTelemetry, registerProfilingTelemetryRuntime} from './runtime-capabilities'
import type {ManagedProfiling, ProfilingSinkState, ProfilingStatus} from './types'

export interface ProfilingManagerOptions {
	readonly clock?: Clock
	readonly resource?: ObservabilityResource
	readonly lifecycle?: LifecyclePort
	readonly profiler?: CpuProfiler
	readonly continuous?: ContinuousProfiler
	readonly destinations?: readonly {readonly name: string; readonly exporter: ProfileExporter}[]
	readonly maxDurationMs?: number
	readonly cooldownMs?: number
	readonly maxPayloadBytes?: number
	readonly operationTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
}

const DEFAULT_PAYLOAD_BYTES = 16 * 1024 * 1024
const HARD_PAYLOAD_BYTES = 64 * 1024 * 1024
const PROCESS_OWNERS = Symbol.for('@ooops/profiling:owners:v1')
type ProcessOwners = {m?: object; i?: symbol; c?: object; p?: symbol; s: WeakMap<object, object>; d: WeakMap<object, object>}
const processScope = process as typeof process & {[PROCESS_OWNERS]?: ProcessOwners}
const owners = processScope[PROCESS_OWNERS]
	?? (processScope[PROCESS_OWNERS] = {s: new WeakMap(), d: new WeakMap()})

type Captured<T extends object> = {readonly target: T; readonly flush?: () => Promise<void>; readonly shutdown?: () => Promise<void>}
type CapturedExporter = Captured<ProfileExporter> & {
	readonly name: string
	readonly export: (profile: Readonly<CpuProfileArtifact>) => Promise<void>
}

const invalid = (code: string): Error => Error(`profiling_invalid_${code}`)
const failure = (code: string): Error => Error(`PROFILING_${code}`)
const ignore = () => {}
const byteLength = Buffer.byteLength
const errorMessage = (value: unknown): unknown => {
	try { return value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'message')?.value } catch { /* unknown */ }
}

function readDataMethod(target: object, key: PropertyKey, code: string): unknown {
	let current: object | null = target
	for (let depth = 0; current && depth < 8; depth++) {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(current, key) } catch { throw invalid(code) }
		if (descriptor) {
			if (!('value' in descriptor)) throw invalid(code)
			return descriptor.value
		}
		try { current = Object.getPrototypeOf(current) as object | null } catch { throw invalid(code) }
	}
	return undefined
}

function readOwnData(value: object, key: PropertyKey, code: string): unknown {
	let descriptor: PropertyDescriptor | undefined
	try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw invalid(code) }
	if (!descriptor || !('value' in descriptor)) throw invalid(code)
	return descriptor.value
}

function snapshotDestinations(value: ProfilingManagerOptions['destinations']): unknown[] | undefined {
	if (!Array.isArray(value)) return undefined
	try {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
		const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
		if (!Number.isSafeInteger(length) || length < 0 || length > 2) return undefined
		const result: unknown[] = []
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
			result.push(descriptor.value)
		}
		return result
	} catch { return undefined }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, code: string): number {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(code)
	return value as number
}

function withTimeout<T>(physical: Promise<T>, timeoutMs: number, code: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		physical,
		new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error(code)), timeoutMs) })
	]).finally(() => { timer && clearTimeout(timer) })
}

function skipped(now: () => number, name: string, reason: string, at?: number): Readonly<ProfileCaptureSummary> {
	const timestamp = at ?? now()
	return Object.freeze({type: 'cpu' as const, name, startedAt: timestamp, endedAt: timestamp, durationMs: 0, captured: false, reason})
}

function captureOptionalMethods<T extends object>(target: T, code: string): Captured<T> {
	const flush = readDataMethod(target, 'flush', code)
	const shutdown = readDataMethod(target, 'shutdown', code)
	if (flush !== undefined && typeof flush !== 'function') throw invalid(code)
	if (shutdown !== undefined && typeof shutdown !== 'function') throw invalid(code)
	return Object.freeze({
		target,
		...(flush ? {flush: async() => (flush as () => Promise<void>).call(target)} : {}),
		...(shutdown ? {shutdown: async() => (shutdown as () => Promise<void>).call(target)} : {})
	})
}

function snapshotResource(resource: ObservabilityResource | undefined): Readonly<Record<string, string>> {
	if (resource === undefined) return Object.freeze({})
	if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw invalid('resource')
	const result: Record<string, string> = {}
	const read = (key: keyof ObservabilityResource): unknown => {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(resource, key) } catch { throw invalid('resource') }
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	}
	const mappings: readonly [keyof ObservabilityResource, string][] = [
		['serviceName', 'service.name'], ['serviceVersion', 'service.version'],
		['deploymentEnvironment', 'deployment.environment'], ['hostKind', 'host.kind'], ['runtime', 'runtime.name']
	]
	for (const [source, target] of mappings) {
		const value = read(source)
		if (source === 'serviceName' && (typeof value !== 'string' || value.length > 128 || !value.trim())) throw invalid('resource')
		if (value !== undefined) {
			if (typeof value !== 'string' || value.length > 128) throw invalid('resource')
			const sanitized = sanitizeProfileLabels({[target]: value})?.[target]
			result[target] = sanitized ?? 'redacted'
		}
	}
	const attributes = read('attributes')
	if (attributes !== undefined) {
		const safe = sanitizeProfileLabels(attributes as Record<string, string>)
		for (const [key, value] of Object.entries(safe ?? {})) if (!(key in result)) result[key] = value
	}
	return Object.freeze(result)
}

function validateArtifact(
	value: unknown,
	requested: {name: string; maxDurationMs: number; maxPayloadBytes: number; labels?: Record<string, string>},
	resource: Readonly<Record<string, string>>
): CpuProfileArtifact {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('profiler_result')
	const read = (key: keyof CpuProfileArtifact, optional = false): unknown => {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw invalid('profiler_result') }
		if (!descriptor) {
			if (optional) return undefined
			throw invalid('profiler_result')
		}
		if (!('value' in descriptor)) throw invalid('profiler_result')
		return descriptor.value
	}
	const source = {
		type: read('type'), format: read('format'), name: read('name'),
		startedAt: read('startedAt'), endedAt: read('endedAt'), durationMs: read('durationMs'),
		captured: read('captured'), payload: read('payload'), labels: read('labels', true)
	} as CpuProfileArtifact
	if (source.type !== 'cpu' || source.format !== 'cpuprofile' || source.captured !== true
		|| typeof source.payload !== 'string' || source.payload.length === 0
		|| !Number.isSafeInteger(source.startedAt) || source.startedAt < 0
		|| !Number.isSafeInteger(source.endedAt) || source.endedAt < source.startedAt
		|| !Number.isSafeInteger(source.durationMs) || source.durationMs !== source.endedAt - source.startedAt
		|| source.durationMs > requested.maxDurationMs + 1_000) throw invalid('profiler_result')
	if (source.payload.length > requested.maxPayloadBytes || byteLength(source.payload) > requested.maxPayloadBytes) throw Error('profile_too_large')
	const labels = sanitizeProfileLabels(source.labels ?? requested.labels)
	return Object.freeze({
		type: 'cpu', format: 'cpuprofile', name: sanitizeProfileName(source.name, requested.name),
		startedAt: source.startedAt, endedAt: source.endedAt, durationMs: source.durationMs,
		captured: true, payload: source.payload,
		...(labels ? {labels: Object.freeze({...labels})} : {}), resource
	})
}

function artifactProjection(artifact: CpuProfileArtifact): CpuProfileArtifact {
	return Object.freeze({
		...artifact,
		...(artifact.labels ? {labels: Object.freeze({...artifact.labels})} : {}),
		resource: Object.freeze({...artifact.resource})
	})
}

export async function createProfilingManager(options: ProfilingManagerOptions): Promise<ManagedProfiling> {
	if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('options')
	let clock: Clock | undefined; let profilerInput: CpuProfiler | undefined; let continuousInput: ContinuousProfiler | undefined
	let destinationsInput: ProfilingManagerOptions['destinations']; let lifecycle: LifecyclePort | undefined; let resourceInput: ObservabilityResource | undefined
	let maxDurationInput: number | undefined; let cooldownInput: number | undefined; let payloadInput: number | undefined
	let operationTimeoutInput: number | undefined; let shutdownTimeoutInput: number | undefined
	try {
		({clock, profiler: profilerInput, continuous: continuousInput, destinations: destinationsInput, lifecycle, resource: resourceInput,
			maxDurationMs: maxDurationInput, cooldownMs: cooldownInput, maxPayloadBytes: payloadInput,
			operationTimeoutMs: operationTimeoutInput, shutdownTimeoutMs: shutdownTimeoutInput} = options)
	} catch { throw invalid('options') }
	const maxDurationMs = boundedInteger(maxDurationInput, 30_000, 1, 30_000, 'max_duration')
	const cooldownMs = boundedInteger(cooldownInput, 0, 0, 86_400_000, 'cooldown')
	const maxPayloadBytes = boundedInteger(payloadInput, DEFAULT_PAYLOAD_BYTES, 1, HARD_PAYLOAD_BYTES, 'payload_limit')
	const operationTimeoutMs = boundedInteger(operationTimeoutInput, 5_000, 1, 30_000, 'operation_timeout')
	const shutdownTimeoutMs = boundedInteger(shutdownTimeoutInput, 10_000, 1, 60_000, 'shutdown_timeout')
	const resource = snapshotResource(resourceInput)
	const configuredClock = clock === undefined ? createSystemClock() : clock
	const clockNow = readDataMethod(configuredClock, 'now', 'clock') as Clock['now']
	if (typeof clockNow !== 'function') throw invalid('clock')
	let readingClock = false
	const now = (): number => {
		if (readingClock) throw invalid('clock')
		readingClock = true
		let value: number
		try {
			try { value = clockNow.call(configuredClock) } catch { throw invalid('clock') }
			if (typeof value !== 'number') void Promise.resolve(value).catch(ignore)
			if (!Number.isSafeInteger(value) || value < 0) throw invalid('clock')
			return value
		} finally { readingClock = false }
	}

	let profiler: (Captured<CpuProfiler> & {capture: CpuProfiler['capture']}) | undefined
	if (profilerInput !== undefined) {
		const capture = readDataMethod(profilerInput, 'capture', 'profiler')
		if (typeof capture !== 'function') throw invalid('profiler')
		profiler = Object.freeze({...captureOptionalMethods(profilerInput, 'profiler'), capture: (input: Parameters<CpuProfiler['capture']>[0]) => (capture as CpuProfiler['capture']).call(profilerInput, input)})
	}
	let continuous: (Captured<ContinuousProfiler> & {start: ContinuousProfiler['start']; getStatus: ContinuousProfiler['getStatus']}) | undefined
	if (continuousInput !== undefined) {
		const start = readDataMethod(continuousInput, 'start', 'continuous')
		const getStatus = readDataMethod(continuousInput, 'getStatus', 'continuous')
		if (typeof start !== 'function' || typeof getStatus !== 'function') throw invalid('continuous')
		const captured = captureOptionalMethods(continuousInput, 'continuous')
		if (!captured.shutdown) throw invalid('continuous')
		continuous = Object.freeze({...captured, start: () => (start as ContinuousProfiler['start']).call(continuousInput), getStatus: () => (getStatus as ContinuousProfiler['getStatus']).call(continuousInput)})
	}
	if (profiler && continuous) throw invalid('capabilities')
	const destinations = destinationsInput === undefined ? [] : snapshotDestinations(destinationsInput)
	if (!destinations) throw invalid('destinations')
	const exporters: CapturedExporter[] = []
	for (const input of destinations) {
		let name: unknown; let exporter: ProfileExporter; let exportMethod: unknown
		try {
			if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error()
			const nameDescriptor = Object.getOwnPropertyDescriptor(input, 'name')
			const exporterDescriptor = Object.getOwnPropertyDescriptor(input, 'exporter')
			if (!nameDescriptor || !('value' in nameDescriptor) || !exporterDescriptor || !('value' in exporterDescriptor)) throw Error()
			name = nameDescriptor.value; exporter = exporterDescriptor.value as ProfileExporter
			exportMethod = exporter && typeof exporter === 'object' ? readDataMethod(exporter, 'export', 'destinations') : undefined
		} catch { throw invalid('destinations') }
		if (typeof name !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(name) || typeof exportMethod !== 'function') throw invalid('destinations')
		exporters.push(Object.freeze({...captureOptionalMethods(exporter, 'destinations'), name, export: (profile) => (exportMethod as ProfileExporter['export']).call(exporter, profile)}))
	}
	if (exporters.length === 2 && (exporters[0]!.name === exporters[1]!.name
		|| exporters[0]!.target === exporters[1]!.target)) throw invalid('destinations')

	let state: ProfilingStatus['state'] = 'running'
	let sinkState: ProfilingSinkState = 'healthy'
	let capturesTotal = 0; let droppedTotal = 0; let exportFailuresTotal = 0
	let lastFailureCode: string | undefined; let lastCaptureEndedAt = -Infinity
	let activeCapture: Promise<ProfileCaptureSummary> | undefined; let capturePhysical: Promise<unknown> | undefined
	let cpuFinalization: Promise<void> | undefined; let cpuShutdownPending = false
	let captureController: AbortController | undefined
	const activeExports = new Set<Promise<unknown>>()
	const completedFlush = new Set<object>(); const completedShutdown = new Set<object>()
	const physicalFlushes = new Map<object, Promise<void>>(); const physicalShutdowns = new Map<object, Promise<void>>()
	let flushFlight: Promise<void> | undefined; let shutdownFlight: Promise<void> | undefined
	const lifecycleDisposers: Array<() => void> = []
	const disposeLifecycle = async(): Promise<void> => {
		for (const dispose of lifecycleDisposers.splice(0).reverse()) {
			try { await withTimeout(Promise.resolve().then(dispose), operationTimeoutMs, 'PROFILING_SHUTDOWN_TIMEOUT') } catch { /* best effort */ }
		}
	}
	const owner = {}
	const releaseCaptureOwnership = (): void => {
		if (!capturePhysical && !cpuFinalization && !cpuShutdownPending && owners.m === owner) delete owners.m
	}
	const releaseContinuousOwnership = (unstarted?: boolean): void => {
		if (continuous && (unstarted || completedShutdown.has(continuous.target)) && owners.c === owner) {
			owners.d.delete(continuous.target)
			delete owners.c
		}
	}

	const status = (): ProfilingStatus => Object.freeze({
		state, activeCapture: !!(activeCapture || capturePhysical),
		capturesTotal, droppedTotal, exportFailuresTotal, sinkState,
		...(lastFailureCode ? {lastFailureCode} : {})
	})

	const waitAccepted = async(): Promise<void> => {
		while (activeCapture || capturePhysical || activeExports.size) {
			await Promise.allSettled([...(activeCapture ? [activeCapture] : []), ...(capturePhysical ? [capturePhysical] : []), ...activeExports])
		}
	}
	const componentOperation = async(component: Captured<object>, operation: 'flush' | 'shutdown', timeoutMs: number, terminal: boolean): Promise<void> => {
		const method = component[operation]
		if (!method) return
		const cpu = component === profiler
		if (cpu) {
			if ((owners.m && owners.m !== owner) || owners.i || owners.c || owners.p) throw failure('CPU_IN_PROGRESS')
			owners.m = owner
		}
		const map = operation === 'flush' ? physicalFlushes : physicalShutdowns
		let physical = map.get(component.target)
		if (!physical) {
			const priorFlush = operation === 'shutdown' ? physicalFlushes.get(component.target) : undefined
			physical = (priorFlush ? priorFlush.catch(ignore) : Promise.resolve()).then(method)
			map.set(component.target, physical)
			if (terminal) void physical.then(() => {
				(operation === 'flush' ? completedFlush : completedShutdown).add(component.target)
				if (operation === 'shutdown') releaseContinuousOwnership()
			}, () => undefined)
			void physical.finally(() => { if (map.get(component.target) === physical) map.delete(component.target) }).catch(ignore)
		}
		if (cpu) {
			if (operation === 'shutdown') cpuShutdownPending = true
			cpuFinalization = physical
			void physical.then(() => {
				if (operation === 'shutdown') cpuShutdownPending = false
				if (cpuFinalization === physical) cpuFinalization = undefined
				releaseCaptureOwnership()
			}, () => {
				if (cpuFinalization === physical) cpuFinalization = undefined
				releaseCaptureOwnership()
			})
		}
		return withTimeout(physical, timeoutMs, operation === 'flush' ? 'PROFILING_FLUSH_TIMEOUT' : 'PROFILING_SHUTDOWN_TIMEOUT')
	}

	const components: Captured<object>[] = [...(profiler ? [profiler] : []), ...exporters, ...(continuous ? [continuous] : [])]
	const finalize = async(kind: 'flush' | 'shutdown'): Promise<void> => {
		const failures: unknown[] = []
		try {
			await withTimeout(waitAccepted(), kind === 'shutdown' ? shutdownTimeoutMs : operationTimeoutMs, kind === 'shutdown' ? 'PROFILING_DRAIN_TIMEOUT' : 'PROFILING_FLUSH_DRAIN_TIMEOUT')
		} catch(error) {
			// A destination is not allowed to keep an unrelated process-wide profiler
			// alive forever. Preserve the destination's own serialization, but continue
			// terminal cleanup for components with no ambiguous delivery in flight.
			if (kind !== 'shutdown' || !activeExports.size || activeExports.size !== physicalFlushes.size) throw error
			failures.push(error)
		}
		await Promise.all(components.map(async(component) => {
			if (kind === 'shutdown' && physicalFlushes.has(component.target)) return
			if (kind === 'flush' || (!completedShutdown.has(component.target) && !completedFlush.has(component.target))) {
				try { await componentOperation(component, 'flush', operationTimeoutMs, kind === 'shutdown'); if (kind === 'shutdown') completedFlush.add(component.target) }
				catch { failures.push(failure('FLUSH_FAILURE')) }
			}
			if (kind === 'shutdown' && !completedShutdown.has(component.target)) {
				try { await componentOperation(component, 'shutdown', shutdownTimeoutMs, true); completedShutdown.add(component.target) }
				catch { failures.push(failure('SHUTDOWN_FAILURE')) }
			}
		}))
		if (failures.length) throw new AggregateError(failures, `profiling_${kind}_failed`)
	}

	const managed: ManagedProfiling = {
		async capture(input: ProfileCaptureOptions): Promise<ProfileCaptureSummary> {
			if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('capture_options')
			if (state !== 'running') { droppedTotal++; emitProfilingTelemetry(managed, {kind: 'dropped', reason: 'shutdown'}); return skipped(now, 'performance.cpu', 'profiling_shutdown') }
			if (!profiler) { droppedTotal++; emitProfilingTelemetry(managed, {kind: 'dropped', reason: 'unavailable'}); return skipped(now, 'performance.cpu', 'profiling_unavailable') }
			if (activeCapture || capturePhysical || activeExports.size || flushFlight || physicalFlushes.size
				|| owners.m || owners.i || owners.c || owners.p) { droppedTotal++; emitProfilingTelemetry(managed, {kind: 'dropped', reason: 'busy'}); return skipped(now, 'performance.cpu', 'capture_in_progress') }
			owners.m = owner
			const readInput = (key: keyof ProfileCaptureOptions): unknown => {
				let descriptor: PropertyDescriptor | undefined
				try { descriptor = Object.getOwnPropertyDescriptor(input, key) } catch { throw invalid('capture_options') }
				if (!descriptor) return undefined
				if (!('value' in descriptor)) throw invalid('capture_options')
				return descriptor.value
			}
			let name: string; let durationMs: number; let labels: Record<string, string> | undefined
			try {
				const type = readInput('type'); const inputName = readInput('name')
				const inputDuration = readInput('durationMs'); const inputLabels = readInput('labels')
				if (type !== 'cpu') throw Error('profiling_cpu_only')
				if (inputName !== undefined && typeof inputName !== 'string') throw invalid('name')
				name = sanitizeProfileName(inputName as string | undefined, 'performance.cpu')
				durationMs = boundedInteger(inputDuration, maxDurationMs, 1, maxDurationMs, 'duration')
				labels = sanitizeProfileLabels(inputLabels as Record<string, string> | undefined)
			} catch(error) { releaseCaptureOwnership(); throw error }
			let current: number
			try { current = now() } catch(error) { releaseCaptureOwnership(); throw error }
			const skipShutdown = (): Readonly<ProfileCaptureSummary> => {
				droppedTotal++; emitProfilingTelemetry(managed, {kind: 'dropped', reason: 'shutdown'})
				releaseCaptureOwnership()
				return skipped(now, name, 'profiling_shutdown', current)
			}
			if (state !== 'running') {
				return skipShutdown()
			}
			if (current - lastCaptureEndedAt >= 0 && current - lastCaptureEndedAt < cooldownMs) {
				droppedTotal++; emitProfilingTelemetry(managed, {kind: 'dropped', reason: 'cooldown'})
				try { return skipped(now, name, 'cooldown_active') } finally { releaseCaptureOwnership() }
			}
			let controller: AbortController
			try {
				controller = new AbortController()
				owners.s.set(controller.signal, owner)
			} catch(error) { releaseCaptureOwnership(); throw error }
			if (state !== 'running') {
				return skipShutdown()
			}
			captureController = controller
			const task = (async(): Promise<ProfileCaptureSummary> => {
				try {
					const physical = Promise.resolve().then(() => profiler!.capture({type: 'cpu', name, durationMs, ...(labels ? {labels} : {}), signal: controller.signal}))
					capturePhysical = physical
					void physical.finally(() => {
						if (capturePhysical === physical) capturePhysical = undefined
						releaseCaptureOwnership()
					}).catch(ignore)
					emitProfilingTelemetry(managed, {kind: 'capture_started'})
					let artifact: CpuProfileArtifact
					try { artifact = validateArtifact(await withTimeout(physical, durationMs + operationTimeoutMs, 'PROFILING_CAPTURE_TIMEOUT'), {name, maxDurationMs: durationMs, maxPayloadBytes, ...(labels ? {labels} : {})}, resource) }
					catch(error) {
						controller.abort(Error('profiling_capture_cancelled'))
						const reason = errorMessage(error) === 'profile_too_large' ? 'profile_too_large' : 'capture_failed'
						droppedTotal++; lastFailureCode = reason === 'profile_too_large' ? 'PROFILING_PAYLOAD_LIMIT' : 'PROFILING_CAPTURE_FAILURE'; sinkState = 'unhealthy'
						emitProfilingTelemetry(managed, {kind: 'capture_failed', reason})
						return skipped(now, name, reason)
					}
					capturesTotal++
					if (exporters.length) {
						const deliveries = exporters.map((exporter) => {
							const physical = Promise.resolve().then(() => exporter.export(artifactProjection(artifact)))
							activeExports.add(physical)
							physicalFlushes.set(exporter.target, physical)
							void physical.finally(() => {
								activeExports.delete(physical)
								if (physicalFlushes.get(exporter.target) === physical) physicalFlushes.delete(exporter.target)
								releaseCaptureOwnership()
							}).catch(ignore)
							return withTimeout(physical, operationTimeoutMs, 'PROFILING_EXPORT_TIMEOUT')
						})
						const results = await Promise.allSettled(deliveries)
						const failures = results.filter((result) => result.status === 'rejected').length
						if (failures) { exportFailuresTotal += failures; lastFailureCode = 'PROFILING_EXPORT_FAILURE'; sinkState = failures === exporters.length ? 'unhealthy' : 'degraded'; emitProfilingTelemetry(managed, {kind: 'export_failed', count: failures}) }
						else { sinkState = 'healthy'; lastFailureCode = undefined; emitProfilingTelemetry(managed, {kind: 'recovered'}) }
					}
					emitProfilingTelemetry(managed, {kind: 'capture_completed'})
					return Object.freeze({type: 'cpu', name: artifact.name, startedAt: artifact.startedAt, endedAt: artifact.endedAt, durationMs: artifact.durationMs, captured: true})
				} finally {
					lastCaptureEndedAt = now(); if (captureController === controller) captureController = undefined
				}
			})()
			activeCapture = task
			try { return await task } finally { if (activeCapture === task) activeCapture = undefined; releaseCaptureOwnership() }
		},
		getStatus: status,
		async flush(): Promise<void> {
			if (state === 'closed') return
			if (state === 'draining') return managed.shutdown()
			if (flushFlight) return flushFlight
			flushFlight = finalize('flush').catch((error) => { sinkState = 'unhealthy'; lastFailureCode = 'PROFILING_FLUSH_FAILURE'; emitProfilingTelemetry(managed, {kind: 'finalization_failed', operation: 'flush'}); throw error }).finally(() => { flushFlight = undefined })
			return flushFlight
		},
		async shutdown(): Promise<void> {
			if (state === 'closed') return
			if (shutdownFlight) return shutdownFlight
			state = 'draining'; captureController?.abort(Error('profiling_shutdown'))
			shutdownFlight = (async() => {
				await finalize('shutdown')
				await disposeLifecycle()
				releaseContinuousOwnership()
				state = 'closed'; sinkState = 'closed'; lastFailureCode = undefined
			})().catch((error) => { sinkState = 'unhealthy'; lastFailureCode = 'PROFILING_FINALIZATION_FAILURE'; emitProfilingTelemetry(managed, {kind: 'finalization_failed', operation: 'shutdown'}); throw error }).finally(() => { shutdownFlight = undefined })
			return shutdownFlight
		}
	}
	if (continuous) {
		if (owners.c || owners.p || owners.m || owners.i) throw Error('profiling_continuous_in_progress')
		owners.c = owner
		owners.d.set(continuous.target, owner)
	}
	registerProfilingTelemetryRuntime(managed)
	if (lifecycle !== undefined) {
		try {
			const registerFlushHook = readDataMethod(lifecycle, 'registerFlushHook', 'lifecycle')
			const registerShutdownHook = readDataMethod(lifecycle, 'registerShutdownHook', 'lifecycle')
			if (typeof registerFlushHook !== 'function' || typeof registerShutdownHook !== 'function') throw Error()
			const captureDisposer = (result: unknown): (() => void) => {
				if (typeof result === 'function') return result as () => void
				if (result && typeof result === 'object'
					&& typeof readDataMethod(result, 'then', 'lifecycle') === 'function') void Promise.resolve(result).catch(ignore)
				throw Error()
			}
			const flushDisposer = captureDisposer(registerFlushHook.call(lifecycle, 'profiling', () => managed.flush()))
			lifecycleDisposers.push(flushDisposer)
			const shutdownDisposer = captureDisposer(registerShutdownHook.call(lifecycle, 'observability', () => managed.shutdown(), {name: 'profiling-shutdown', priority: 32}))
			lifecycleDisposers.push(shutdownDisposer)
		} catch {
			await disposeLifecycle()
			releaseContinuousOwnership(true)
			try { await managed.shutdown() } catch { await managed.shutdown().catch(ignore) }
			throw failure('LIFECYCLE_REGISTRATION_FAILURE')
		}
	}
	if (continuous) {
		let startSettled = false
		const startPhysical = Promise.resolve().then(async() => {
			if (state !== 'running') throw failure('CONTINUOUS_START_CANCELLED')
			await continuous.start()
			if (state !== 'running') throw failure('CONTINUOUS_START_CANCELLED')
		})
		activeExports.add(startPhysical)
		void startPhysical.finally(() => { startSettled = true; activeExports.delete(startPhysical) }).catch(ignore)
		try {
			await withTimeout(startPhysical, operationTimeoutMs, 'PROFILING_CONTINUOUS_START_TIMEOUT')
			const continuousStatus = continuous.getStatus()
			if (!continuousStatus || typeof continuousStatus !== 'object' || Array.isArray(continuousStatus)) throw failure('CONTINUOUS_START_FAILURE')
			const asynchronous = typeof readDataMethod(continuousStatus, 'then', 'continuous_status') === 'function'
			if (asynchronous) void Promise.resolve(continuousStatus).catch(ignore)
			if (asynchronous || readOwnData(continuousStatus, 'state', 'continuous_status') !== 'running'
				|| readOwnData(continuousStatus, 'healthy', 'continuous_status') !== true) throw failure('CONTINUOUS_START_FAILURE')
		} catch(error) {
			lastFailureCode = 'PROFILING_CONTINUOUS_START_FAILURE'; sinkState = 'unhealthy'; emitProfilingTelemetry(managed, {kind: 'continuous_failed', operation: 'start'})
			await disposeLifecycle()
			const timedOut = errorMessage(error) === 'PROFILING_CONTINUOUS_START_TIMEOUT'
			const earlyCleanup = timedOut
				? withTimeout(Promise.resolve().then(continuous.shutdown), shutdownTimeoutMs, 'PROFILING_CONTINUOUS_EARLY_SHUTDOWN_TIMEOUT').catch(continuous.shutdown)
				: Promise.resolve()
			void earlyCleanup.catch(ignore)
			const serializedCleanup = startPhysical.catch(ignore).then(async() => {
				await continuous.shutdown!()
				completedShutdown.add(continuous.target)
				releaseContinuousOwnership()
			})
			physicalShutdowns.set(continuous.target, serializedCleanup)
			// Construction has no runtime handle to return. Once the late start and
			// its serialized stop prove inactive, retry terminal close automatically.
			void serializedCleanup.then(() => managed.shutdown()).catch(ignore)
			void serializedCleanup.finally(() => {
				if (physicalShutdowns.get(continuous.target) === serializedCleanup) {
					physicalShutdowns.delete(continuous.target)
				}
			}).catch(ignore)
			try { await withTimeout(serializedCleanup, shutdownTimeoutMs, 'PROFILING_CONTINUOUS_SHUTDOWN_TIMEOUT') } catch {
				const retry = Promise.resolve().then(continuous.shutdown)
				try {
					await withTimeout(retry, shutdownTimeoutMs, 'PROFILING_CONTINUOUS_SHUTDOWN_TIMEOUT')
					completedShutdown.add(continuous.target); physicalShutdowns.delete(continuous.target)
					if (startSettled) releaseContinuousOwnership()
				} catch { /* the original late fence remains owned */ }
			}
			try { await managed.shutdown() } catch { /* preserve startup failure */ }
			throw failure('CONTINUOUS_START_FAILURE')
		}
	}
	return managed
}
