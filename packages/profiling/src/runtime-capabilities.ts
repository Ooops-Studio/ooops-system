import type {ManagedProfiling} from './types'

export type ProfilingTelemetryEvent =
	| {readonly kind: 'capture_started' | 'capture_completed' | 'recovered'}
	| {readonly kind: 'dropped'; readonly reason: 'shutdown' | 'unavailable' | 'busy' | 'cooldown'}
	| {readonly kind: 'capture_failed'; readonly reason: 'capture_failed' | 'profile_too_large'}
	| {readonly kind: 'export_failed'; readonly count: number}
	| {readonly kind: 'continuous_failed'; readonly operation: 'start' | 'shutdown'}
	| {readonly kind: 'finalization_failed'; readonly operation: 'flush' | 'shutdown'}

type Listener = (event: ProfilingTelemetryEvent) => void
const runtimes = new WeakSet<ManagedProfiling>()
const listeners = new WeakMap<ManagedProfiling, Listener>()
const emitting = new WeakSet<ManagedProfiling>()

export function registerProfilingTelemetryRuntime(runtime: ManagedProfiling): void { runtimes.add(runtime) }

export function attachProfilingTelemetry(runtime: ManagedProfiling, listener: Listener): () => void {
	if (!runtimes.has(runtime)) throw Error('PROFILING_TELEMETRY_UNAVAILABLE')
	if (listeners.has(runtime)) throw Error('PROFILING_OBSERVABILITY_ATTACHED')
	listeners.set(runtime, listener)
	return () => { if (listeners.get(runtime) === listener) listeners.delete(runtime) }
}

export function emitProfilingTelemetry(runtime: ManagedProfiling, event: ProfilingTelemetryEvent): void {
	if (emitting.has(runtime)) return
	emitting.add(runtime)
	try { listeners.get(runtime)?.(Object.freeze({...event})) } catch { /* observability is fail-open */ }
	finally { emitting.delete(runtime) }
}
