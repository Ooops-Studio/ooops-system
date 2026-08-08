import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import {captureBridgeMethod} from './internal/capabilities'

type Disposer = () => void

/** Wire every present runtime to the present observability destinations atomically. */
export async function wireObservability(container: Container): Promise<Disposer> {
	const tryGet = captureBridgeMethod<(token: symbol) => unknown>(container, 'tryGet')
	if (!tryGet) throw new TypeError('OBSERVABILITY_CONTAINER_INVALID')
	const logger = tryGet(TOK.Logging) as Logging | undefined
	const errors = tryGet(TOK.Errors) as Errors | undefined
	const metrics = tryGet(TOK.Metrics) as MetricsPort | undefined
	const tracer = tryGet(TOK.Tracing) as Tracing | undefined
	const destinations = Object.freeze({logger, errors, metrics, tracer})
	const runtimes = Object.freeze({
		lifecycle: tryGet(TOK.Lifecycle), performance: tryGet(TOK.Performance),
		profiling: tryGet(TOK.Profiling), audit: tryGet(TOK.Audit), cache: tryGet(TOK.Cache),
		jobs: tryGet(TOK.Jobs), events: tryGet(TOK.Events), rateLimit: tryGet(TOK.RateLimit),
		resilience: tryGet(TOK.Resilience)
	})
	const disposers: Disposer[] = []
	const retain = (dispose: Disposer): void => { disposers.push(dispose) }
	const rollback = (): void => {
		for (const dispose of disposers.splice(0).reverse()) {
			try { dispose() } catch { /* cleanup is isolated */ }
		}
	}
	try {
		if (runtimes.lifecycle) retain((await import('./lifecycle')).wireLifecycleObservability(runtimes.lifecycle as never, destinations))
		if (runtimes.performance) retain((await import('./performance')).wirePerformanceObservability(runtimes.performance as never, destinations))
		if (runtimes.profiling) retain((await import('./profiling')).wireProfilingObservability(runtimes.profiling as never, destinations))
		if (runtimes.audit) retain((await import('./audit')).wireAuditObservability(runtimes.audit as never, destinations))
		if (runtimes.cache) retain((await import('./cache')).wireCacheObservability(runtimes.cache as never, destinations))
		if (runtimes.jobs) retain((await import('./jobs')).wireJobsObservability(runtimes.jobs as never, destinations))
		if (runtimes.events) retain((await import('./events')).wireEventsObservability(runtimes.events as never, destinations))
		if (runtimes.rateLimit) retain((await import('./rate-limit')).wireRateLimitObservability(runtimes.rateLimit as never, destinations))
		if (runtimes.resilience) retain((await import('./resilience')).wireResilienceObservability(runtimes.resilience as never, destinations))
	} catch(error) {
		rollback()
		throw error
	}
	let active = true
	return () => {
		if (!active) return
		active = false
		rollback()
	}
}
