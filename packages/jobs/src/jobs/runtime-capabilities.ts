import type {ManagedJobs} from '@ooopsstudio/core/ports/jobs'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'

export type JobsTracing = Pick<Tracing, 'injectHeaders' | 'inSpan'> & {
	withExtractedHeaders<T>(
		carrier: Record<string, string>,
		fn: () => T | Promise<T>
	): Promise<T>
}

export type JobsTelemetryEvent =
	| {readonly kind: 'enqueued'; readonly result: 'success' | 'deduplicated'}
	| {readonly kind: 'execution'; readonly result: 'completed' | 'retryable' | 'dead_lettered' | 'cancelled' | 'failure'}
	| {readonly kind: 'retry'}
	| {readonly kind: 'active'; readonly count: number}
	| {readonly kind: 'rejected'; readonly reason: 'capacity' | 'draining' | 'closed' | 'invalid'}
	| {readonly kind: 'operation_failed'; readonly operation: 'backend' | 'execution' | 'lease' | 'maintenance' | 'tracing'; readonly code: string; readonly error?: unknown; readonly reportable: boolean}
	| {readonly kind: 'finalization_failed'; readonly operation: 'flush' | 'shutdown' | 'lifecycle'; readonly code: string; readonly error?: unknown}
	| {readonly kind: 'log'; readonly level: 'debug' | 'info' | 'warn' | 'error'; readonly message: string; readonly attributes?: Readonly<Record<string, unknown>>}
	| {readonly kind: 'recovered'}

type Observer = (event: JobsTelemetryEvent) => void

export interface JobsTelemetryController {
	emit(event: JobsTelemetryEvent): void
	getTracer(): JobsTracing | undefined
	attach(observer: Observer, tracer?: JobsTracing): () => void
}

export function createJobsTelemetryController(): JobsTelemetryController {
	let observer: Observer | undefined
	let tracer: JobsTracing | undefined
	return {
		emit(event) {
			try { observer?.(Object.freeze(event)) } catch { /* isolated */ }
		},
		getTracer: () => tracer,
		attach(nextObserver, nextTracer) {
			if (observer) throw new Error('Jobs observability is already attached')
			observer = nextObserver
			tracer = nextTracer
			let disposed = false
			return () => {
				if (disposed) return
				disposed = true
				if (observer === nextObserver) observer = undefined
				if (tracer === nextTracer) tracer = undefined
			}
		}
	}
}

const controllers = new WeakMap<object, JobsTelemetryController>()

export function registerJobsTelemetryTarget(jobs: ManagedJobs, controller: JobsTelemetryController): void {
	controllers.set(jobs, controller)
}

export function attachJobsTelemetry(
	jobs: ManagedJobs,
	observer: Observer,
	tracer?: JobsTracing
): () => void {
	const controller = controllers.get(jobs)
	if (!controller) throw new Error('Jobs telemetry is unavailable for this runtime')
	return controller.attach(observer, tracer)
}
