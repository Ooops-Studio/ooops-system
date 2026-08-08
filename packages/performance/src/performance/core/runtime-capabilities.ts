import type {ManagedPerformance} from '../types/ports'

import type {PerformanceCallbackDispatcher, PerformanceTelemetryCallbacks} from './callback-dispatcher'

const dispatchers = new WeakMap<object, PerformanceCallbackDispatcher>()

export function registerPerformanceDispatcher(
	performance: ManagedPerformance,
	dispatcher: PerformanceCallbackDispatcher
): void {
	dispatchers.set(performance, dispatcher)
}

export function attachPerformanceTelemetry(
	performance: ManagedPerformance,
	callbacks: PerformanceTelemetryCallbacks
): () => void {
	const dispatcher = dispatchers.get(performance)
	if (!dispatcher) throw new Error('PERFORMANCE_TELEMETRY_UNAVAILABLE')
	dispatcher.add(callbacks)
	let active = true
	return () => {
		if (!active) return
		active = false
		dispatcher.remove(callbacks)
	}
}
