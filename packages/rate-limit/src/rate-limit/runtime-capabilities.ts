import type {ManagedRateLimit} from '@ooopsstudio/core/ports/ratelimit'

import {isRateLimitPromise} from './utils/safe-object'

export type RateLimitTelemetryEvent =
	| {readonly kind: 'check'; readonly result: 'allowed' | 'rejected' | 'shadow' | 'backend_allowed' | 'backend_blocked'}
	| {readonly kind: 'rejection'; readonly reason: 'limit' | 'backend' | 'closed'}
	| {readonly kind: 'active_operations'; readonly count: number}
	| {readonly kind: 'backend_failed'; readonly code: string}
	| {readonly kind: 'finalization_failed'; readonly operation: 'shutdown'; readonly code: string}
	| {readonly kind: 'recovered'}

type Observer = (event: RateLimitTelemetryEvent) => void
interface Controller {
	observer?: Observer
	emission?: object
	disabledObserver?: Observer
}
const controllers = new WeakMap<object, Controller>()
const OBSERVER_TIMEOUT_MS = 5_000

export function registerRateLimitTelemetryTarget(runtime: ManagedRateLimit, controller: Controller): void {
	controllers.set(runtime, controller)
}

export function emitRateLimitTelemetry(controller: Controller, event: RateLimitTelemetryEvent): void {
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
		const result: unknown = observer(Object.freeze(event))
		if (!isRateLimitPromise(result)) { release(); return }
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
		try { void Reflect.apply(Promise.prototype.then, result, [release, release]) } catch { release() }
	} catch { release() }
}

export function attachRateLimitTelemetry(runtime: ManagedRateLimit, observer: Observer): () => void {
	const controller = controllers.get(runtime)
	if (!controller) throw new Error('Rate limit telemetry is unavailable for this runtime')
	if (controller.observer) throw new Error('Rate limit observability is already attached')
	controller.observer = observer
	controller.disabledObserver = undefined
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		if (controller.observer === observer) controller.observer = undefined
	}
}
