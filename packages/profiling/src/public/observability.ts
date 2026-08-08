import {attachProfilingTelemetry, type ProfilingTelemetryEvent} from '../runtime-capabilities'
import type {ManagedProfiling} from '../types'

export type ProfilingObservabilityEvent = Readonly<ProfilingTelemetryEvent>
export type ProfilingObservabilityListener = (event: ProfilingObservabilityEvent) => unknown
export type ProfilingObservabilityAttachment = () => void

/** Attach one fail-open raw listener without cross-domain mappings. */
export function attachProfilingObservability(
	profiling: ManagedProfiling,
	listener: ProfilingObservabilityListener
): ProfilingObservabilityAttachment {
	if (typeof listener !== 'function') throw new TypeError('PROFILING_OBSERVABILITY_LISTENER_INVALID')
	return attachProfilingTelemetry(profiling, (event) => {
		try {
			void Promise.resolve(listener(Object.freeze({...event}))).catch(() => undefined)
		} catch { /* observability is fail-open */ }
	})
}
