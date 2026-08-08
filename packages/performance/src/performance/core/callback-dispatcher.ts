import type {BudgetViolation, N1Pattern, PerfEvent, SaturationAlert} from '@ooopsstudio/core/contracts/performance'

import {ignoreRuntimePromiseRejection, isRuntimePromise, isRuntimeProxy} from '../utils/safe-object'

import {clonePerformanceValue, deepFreezePerformanceValue} from './utils/event-helpers'

export interface PerformanceTelemetryCallbacks {
	onBudgetViolation?(violation: BudgetViolation): void
	onSaturationAlert?(alert: SaturationAlert): void
	onDimensionExplosion?(metricName: string, reason: string): void
	onN1Pattern?(pattern: N1Pattern): void
	onDimensionDrop?(metricName: string, reason: string): void
	onPerfEvent?(event: PerfEvent): void
	onSelfMetric?(name: string, value: number, labels?: Record<string, string>): void
}

export interface PerformanceCallbackDispatcher {
	emit<K extends keyof PerformanceTelemetryCallbacks>(
		name: K,
		...args: Parameters<NonNullable<PerformanceTelemetryCallbacks[K]>>
	): void
	add(callbacks: PerformanceTelemetryCallbacks): void
	remove(callbacks: PerformanceTelemetryCallbacks): void
	reset(): void
}

const captureCallback = <K extends keyof PerformanceTelemetryCallbacks>(
	bundle: PerformanceTelemetryCallbacks,
	key: K
): NonNullable<PerformanceTelemetryCallbacks[K]> | undefined => {
	if (isRuntimeProxy(bundle)) return undefined
	try {
		let owner: object | null = bundle
		for (let depth = 0; owner && depth < 8; depth += 1) {
			if (isRuntimeProxy(owner)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const callback = descriptor.value as (...args: never[]) => unknown
				return ((...args: never[]) => Reflect.apply(callback, bundle, args)) as NonNullable<PerformanceTelemetryCallbacks[K]>
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

/** Isolates arbitrary bridge observers from performance measurements. */
export function createPerformanceCallbackDispatcher(
	initial: PerformanceTelemetryCallbacks
): PerformanceCallbackDispatcher {
	const callbacks = new Set<PerformanceTelemetryCallbacks>([initial])
	let pendingCallbacks = new WeakMap<PerformanceTelemetryCallbacks, Set<keyof PerformanceTelemetryCallbacks>>()
	return {
		emit(name, ...args) {
			const emissionCallbacks = [...callbacks]
			const values = emissionCallbacks.length > 1
				? deepFreezePerformanceValue(clonePerformanceValue(args))
				: args
			for (const bundle of emissionCallbacks) {
				try {
					if (pendingCallbacks.get(bundle)?.has(name)) continue
					const callback = captureCallback(bundle, name) as ((...values: typeof args) => void) | undefined
					if (!callback) continue
					const pendingNames = pendingCallbacks.get(bundle) ?? new Set()
					pendingNames.add(name)
					pendingCallbacks.set(bundle, pendingNames)
					const release = () => {
						if (pendingCallbacks.get(bundle) !== pendingNames) return
						pendingNames.delete(name)
						if (pendingNames.size === 0) pendingCallbacks.delete(bundle)
					}
					let result: unknown
					try { result = callback(...values) } catch { release(); continue }
					ignoreRuntimePromiseRejection(result)
					if (isRuntimePromise(result)) {
						try {
							void Reflect.apply(Promise.prototype.then, result, [release, release])
						} catch { release() }
					} else release()
				} catch {
					// Bridge observers must not affect measurements.
				}
			}
		},
		add(bundle) {
			if (callbacks.has(bundle) || callbacks.size >= 100) return
			callbacks.add(bundle)
		},
		remove(bundle) {
			pendingCallbacks.delete(bundle)
			return callbacks.delete(bundle)
		},
		reset() {
			callbacks.clear()
			pendingCallbacks = new WeakMap()
			callbacks.add(initial)
		}
	}
}
