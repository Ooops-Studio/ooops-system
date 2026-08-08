import type {ManagedJobs} from '@ooopsstudio/core/ports/jobs'

import {attachJobsTelemetry, type JobsTelemetryEvent, type JobsTracing} from '../runtime-capabilities'

export type JobsObservabilityEvent = Readonly<JobsTelemetryEvent>
export type JobsObservabilityListener = (event: JobsObservabilityEvent) => unknown
export type JobsObservabilityAttachment = () => void
export type {JobsTracing}

/** Attach one raw event listener and an optional structural tracing capability. */
export function attachJobsObservability(
	jobs: ManagedJobs,
	listener: JobsObservabilityListener,
	tracing?: JobsTracing
): JobsObservabilityAttachment {
	if (typeof listener !== 'function') throw new TypeError('JOBS_OBSERVABILITY_LISTENER_INVALID')
	return attachJobsTelemetry(jobs, (event) => {
		try { void listener(Object.freeze({...event})) } catch { /* observability is fail-open */ }
	}, tracing)
}
