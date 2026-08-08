import type {ManagedCache} from '@ooopsstudio/core/ports/cache'

export type CacheTelemetryOperation =
	| 'get' | 'get_many' | 'set' | 'set_many' | 'delete' | 'delete_many'
	| 'invalidate' | 'load' | 'load_many'

export type CacheTelemetryEvent =
	| {readonly kind: 'operation'; readonly operation: CacheTelemetryOperation; readonly result: 'success' | 'failure'}
	| {readonly kind: 'lookup'; readonly result: 'fresh' | 'stale' | 'negative' | 'miss'}
	| {readonly kind: 'dropped'; readonly reason: 'capacity' | 'invalid' | 'oversized' | 'closed'}
	| {readonly kind: 'active_operations'; readonly count: number}
	| {readonly kind: 'active_loads'; readonly count: number}
	| {readonly kind: 'backend_failed'; readonly operation: 'read' | 'write' | 'delete' | 'invalidate' | 'flush' | 'shutdown'; readonly code: string}
	| {readonly kind: 'finalization_failed'; readonly operation: 'flush' | 'shutdown' | 'lifecycle_cleanup'; readonly code: string}
	| {readonly kind: 'recovered'}

type CacheTelemetryObserver = (event: CacheTelemetryEvent) => void

export interface CacheTelemetryController {
	observer?: CacheTelemetryObserver
}

const controllers = new WeakMap<object, CacheTelemetryController>()

export function registerCacheTelemetryTarget(cache: ManagedCache, controller: CacheTelemetryController): void {
	controllers.set(cache, controller)
}

export function emitCacheTelemetry(controller: CacheTelemetryController, event: CacheTelemetryEvent): void {
	try { controller.observer?.(Object.freeze(event)) } catch { /* observability is isolated */ }
}

export function attachCacheTelemetry(cache: ManagedCache, observer: CacheTelemetryObserver): () => void {
	const controller = controllers.get(cache)
	if (!controller) throw new Error('Cache telemetry is unavailable for this runtime.')
	if (controller.observer) throw new Error('Cache observability is already attached.')
	controller.observer = observer
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		if (controller.observer === observer) controller.observer = undefined
	}
}
