import type {ManagedResilience} from './public/types'
import {captureNativePromise} from './utils/capabilities'

export type ResilienceRejectionReason =
	| 'admission_capacity'
	| 'breaker_open'
	| 'bulkhead_overflow'
	| 'bulkhead_timeout'
	| 'coalescing_capacity'
	| 'coalescing_expired'
	| 'runtime_closed'

export type ResilienceTelemetryEvent =
	| {readonly kind: 'active_operations'; readonly count: number}
	| {readonly kind: 'queued_operations'; readonly count: number}
	| {readonly kind: 'execution'; readonly result: 'success' | 'failure'}
	| {readonly kind: 'retry'; readonly attempt: number}
	| {readonly kind: 'rejection'; readonly reason: ResilienceRejectionReason}
	| {readonly kind: 'finalization_failed'; readonly operation: 'shutdown'; readonly code: 'RESILIENCE_FINALIZATION_FAILURE'}

type Observer = (event: ResilienceTelemetryEvent) => unknown

export interface ResilienceTelemetryController {
	observer?: Observer
	emission?: object
	disabledObserver?: Observer
}

const controllers = new WeakMap<object, ResilienceTelemetryController>()
const OBSERVER_TIMEOUT_MS = 5_000

export function registerResilienceTelemetryTarget(
	runtime: ManagedResilience,
	controller: ResilienceTelemetryController
): void {
	controllers.set(runtime, controller)
}

export function emitResilienceTelemetry(
	controller: ResilienceTelemetryController,
	event: ResilienceTelemetryEvent
): void {
	const observer = controller.observer
	if (!observer || controller.disabledObserver === observer || controller.emission) return
	const emission = {}
	controller.emission = emission
	let timeout: ReturnType<typeof setTimeout> | undefined
	const release = () => {
		if (controller.emission === emission) controller.emission = undefined
		if (timeout !== undefined) {
			try { clearTimeout(timeout) } catch { /* observer settlement remains authoritative */ }
			timeout = undefined
		}
	}
	try {
		const result = observer(Object.freeze(event))
		const pending = captureNativePromise(result)
		if (!pending) { release(); return }
		try {
			timeout = setTimeout(() => {
				if (controller.observer === observer) controller.disabledObserver = observer
				release()
			}, OBSERVER_TIMEOUT_MS)
			try { timeout.unref?.() } catch { /* optional process-lifetime optimization */ }
		} catch {
			if (controller.observer === observer) controller.disabledObserver = observer
			release()
		}
		void pending.then(release, release)
	} catch { release() }
}

export function attachResilienceTelemetry(runtime: ManagedResilience, observer: Observer): () => void {
	const controller = controllers.get(runtime)
	if (!controller) throw new Error('Resilience telemetry is unavailable for this runtime')
	if (controller.observer) throw new Error('Resilience observability is already attached')
	controller.observer = observer
	controller.disabledObserver = undefined
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		if (controller.observer === observer) controller.observer = undefined
	}
}
