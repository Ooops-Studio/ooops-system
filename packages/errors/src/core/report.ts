export type {Report, ReportOptions, ReportRuntime} from './report-types'

import {
	DEFAULT_ERRORS_FLUSH_TIMEOUT_MS,
	DEFAULT_ERRORS_REPORT_TIMEOUT_MS,
	DEFAULT_ERRORS_SHUTDOWN_TIMEOUT_MS,
	MAX_ACTIVE_ERROR_FINALIZATIONS,
	MAX_ACTIVE_ERROR_FLUSHES,
	MAX_ACTIVE_ERROR_REPORTS,
	MAX_PENDING_ERROR_FINALIZATION_REQUESTS,
	MAX_PENDING_ERROR_FLUSH_REQUESTS
} from '../constants'
import {reportAll} from '../features/reporters/report-all'
import type {ReportAllOptions} from '../features/reporters/report-all'
import {captureErrorCapability} from '../utils/capabilities'
import {redactEnrichedError} from '../utils/redaction'
import {createSafeObserve} from '../utils/safe-observe'

import {collectFinalizationFailures, throwFinalizationFailures} from './finalization'
import type {ReportIntegrationReentryState, ReportOptions, ReportRuntime} from './report-types'
import {isErrorsTimeout, withErrorsTimeout} from './timeout'

const createReportCapacityError = (): Parameters<ReportRuntime['report']>[0] => Object.freeze({
	kind: 'ResourceError',
	message: 'Report capacity exceeded.',
	code: 'ENOSPC',
	severity: 'error',
	category: 'RESOURCE',
	timestamp: 0,
	source: 'errors'
})

export function invokeReportIntegrationCallback<T>(
	state: ReportIntegrationReentryState,
	callback: () => T
): T {
	state.active = true
	try { return callback() } finally { state.active = false }
}

/** Creates the small shared reporting kernel used by every remaining preset. */
export function createReportRuntime(
	options: ReportOptions,
	integrationReentryState: ReportIntegrationReentryState = {active: false}
): ReportRuntime {
	const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_ERRORS_FLUSH_TIMEOUT_MS
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_ERRORS_SHUTDOWN_TIMEOUT_MS
	const reportTimeoutMs = options.reportTimeoutMs ?? DEFAULT_ERRORS_REPORT_TIMEOUT_MS
	// Reporter configuration is immutable for the lifetime of the runtime. Keep
	// stable, receiver-preserving wrappers so caller mutation cannot silently
	// disable delivery or replace a finalizer after construction.
	const baseReport = options.baseReport
	const logger = options.logger
	const logInfo = captureErrorCapability(logger, 'info')
	const logWarn = captureErrorCapability(logger, 'warn')
	const logError = captureErrorCapability(logger, 'error')
	const logFatal = captureErrorCapability(logger, 'fatal')
	const stableLogger = logger && (logInfo || logWarn || logError || logFatal)
		? {
			...(logInfo ? {info: (...args: Parameters<typeof logger.info>) =>
				logInfo.call(logger, ...args)} : {}),
			...(logWarn ? {warn: (...args: Parameters<typeof logger.warn>) =>
				logWarn.call(logger, ...args)} : {}),
			...(logError ? {error: (...args: Parameters<typeof logger.error>) =>
				logError.call(logger, ...args)} : {}),
			...(logFatal ? {fatal: (...args: Parameters<typeof logger.fatal>) =>
				logFatal.call(logger, ...args)} : {})
		} as typeof logger
		: undefined
	const tracer = options.tracer
	const recordException = captureErrorCapability(tracer, 'recordException')
	const addBreadcrumb = captureErrorCapability(tracer, 'addBreadcrumb')
	const currentTraceId = captureErrorCapability(tracer, 'currentTraceId')
	const stableTracer = tracer && (recordException || addBreadcrumb)
		? {
			...(recordException ? {recordException: (...args: Parameters<NonNullable<typeof tracer.recordException>>) =>
				recordException.call(tracer, ...args)} : {}),
			...(addBreadcrumb ? {addBreadcrumb: (...args: Parameters<NonNullable<typeof tracer.addBreadcrumb>>) =>
				addBreadcrumb.call(tracer, ...args)} : {}),
			...(currentTraceId ? {currentTraceId: () => currentTraceId.call(tracer) as string | undefined} : {})
		} as typeof tracer
		: undefined
	const metrics = options.metrics
	const increment = captureErrorCapability(metrics, 'increment')
	const stableMetrics = metrics && increment
		? {increment: (...args: Parameters<NonNullable<typeof metrics.increment>>) => increment.call(metrics, ...args)}
		: undefined
	const observe = options.observe
	const safeObserve = createSafeObserve(observe)
	const sink = options.sink
	const capture = captureErrorCapability(sink, 'capture')
	const flushSink = captureErrorCapability(sink, 'flush')
	const closeSink = captureErrorCapability(sink, 'close')
	const stableSink = sink
		? {
			capture: async(error: Parameters<ReportRuntime['report']>[0]) => {
				if (typeof capture !== 'function') throw new Error('Errors sink capture unavailable.')
				await capture.call(sink, error)
			},
			...(typeof flushSink === 'function'
				? {flush: async() => { await flushSink.call(sink) }}
				: {}),
			...(typeof closeSink === 'function'
				? {close: async() => { await closeSink.call(sink) }}
				: {})
		}
		: undefined
	const stableOptions: ReportAllOptions = {
		...(baseReport ? {customReport: baseReport} : {}),
		...(stableLogger ? {logger: stableLogger} : {}),
		...(stableTracer ? {tracer: stableTracer} : {}),
		...(stableMetrics ? {metrics: stableMetrics} : {}),
		// Reuse one async re-entry guard for the runtime lifetime. Creating a fresh
		// guard inside every report allowed a never-settling observer promise to
		// accumulate one detached invocation per handled error.
		...(observe ? {observe: safeObserve} : {}),
		...(stableSink ? {sink: stableSink} : {})
	}
	let closed = false
	let closing = false
	let accepting = true
	let shutdownPromise: Promise<void> | undefined
	let shutdownGeneration = 0
	let finalizationFlush: Promise<void> | undefined
	let runtimeFlush: Promise<void> | undefined
	let reportAdmissionVersion = 0
	let runtimeFlushScheduled = -1
	let runtimeFlushCompleted = -1
	// Caller-visible timeout wrappers can settle while an integration that
	// ignores cancellation keeps doing physical work. Keep separate ownership
	// so those detached reports cannot evade the admission bound.
	const physicalReports = new Set<Promise<void>>()
	let snapshottingCallerPayload = false
	const activeFlushes = new Set<Promise<void>>()
	const pendingFlushRequests = new Set<Promise<void>>()
	const pendingFinalizationRequests = new Set<Promise<void>>()
	const activeFinalizations = new Set<Promise<void>>()

	const drainReports = async(): Promise<void> => {
		const accepted = [...physicalReports]
		if (accepted.length > 0) await Promise.allSettled(accepted)
	}

	const flushInternal = async(): Promise<void> => {
		const failures = await collectFinalizationFailures([
			stableSink?.flush ? async() => {
				const operation = invokeReportIntegrationCallback(integrationReentryState, () => stableSink.flush?.())
				await operation
			} : undefined
		])
		throwFinalizationFailures(failures, 'Errors flush failed.')
	}
	const flush = (): Promise<void> => {
		if (integrationReentryState.active) return Promise.resolve()
		if (pendingFlushRequests.size >= MAX_PENDING_ERROR_FLUSH_REQUESTS) {
			return Promise.reject(new Error('Errors pending flush capacity exceeded.'))
		}
		let physical: Promise<void>
		if (shutdownPromise) physical = shutdownPromise
		else if (closed) physical = Promise.resolve()
		else {
			const target = reportAdmissionVersion
			// Capture the cutoff synchronously. If this flush is queued behind an
			// earlier generation, taking the snapshot inside the queued operation
			// would also include reports admitted after this caller invoked flush().
			const acceptedForTarget = [...physicalReports]
			if (runtimeFlushCompleted >= target) physical = Promise.resolve()
			else if (runtimeFlush && runtimeFlushScheduled >= target) physical = runtimeFlush
			else if (activeFlushes.size >= MAX_ACTIVE_ERROR_FLUSHES) {
				physical = Promise.reject(new Error('Errors physical flush capacity exceeded.'))
			}
			else {
				const predecessor = runtimeFlush
				runtimeFlushScheduled = target
				const operation = Promise.resolve(predecessor).catch(() => undefined).then(async() => {
					// A generation owns a stable target. Later reports cannot extend it
					// indefinitely and starve this caller or a following shutdown.
					if (acceptedForTarget.length > 0) await Promise.allSettled(acceptedForTarget)
					await flushInternal()
					runtimeFlushCompleted = Math.max(runtimeFlushCompleted, target)
				})
				const tracked = operation.finally(() => {
					if (runtimeFlush === tracked) runtimeFlush = undefined
				})
				runtimeFlush = tracked
				activeFlushes.add(tracked)
				void tracked.then(
					() => activeFlushes.delete(tracked),
					() => activeFlushes.delete(tracked)
				)
				physical = tracked
			}
		}
		let request!: Promise<void>
		request = withErrorsTimeout(physical, flushTimeoutMs, 'flush').finally(() => {
			pendingFlushRequests.delete(request)
		})
		pendingFlushRequests.add(request)
		return request
	}

	const reportInternal = async(error: Parameters<ReportRuntime['report']>[0]): Promise<void> => {
		const publicError = redactEnrichedError(error)
		// reportAll starts every configured destination in the same fan-out. A slow
		// custom reporter therefore cannot delay starting the independent built-ins,
		// while its outcome remains visible in delivery observability.
		const operation = invokeReportIntegrationCallback(integrationReentryState, () => reportAll(publicError, stableOptions))
		await operation
	}
	const report = (error: Parameters<ReportRuntime['report']>[0]): Promise<void> => {
		if (!accepting || closed || closing) return Promise.resolve()
		if (snapshottingCallerPayload || physicalReports.size >= MAX_ACTIVE_ERROR_REPORTS) {
			safeObserve('error:reporter', {
				reporter: 'unknown', status: 'error', error: createReportCapacityError(), reason: 'report_capacity'
			})
			return Promise.resolve()
		}
		let releaseOwnership!: () => void
		const ownership = new Promise<void>((resolve) => { releaseOwnership = resolve })
		physicalReports.add(ownership)
		reportAdmissionVersion++
		const release = () => {
			physicalReports.delete(ownership)
			releaseOwnership()
		}
		let publicError: Parameters<ReportRuntime['report']>[0]
		try {
			snapshottingCallerPayload = true
			publicError = redactEnrichedError(error)
		} catch {
			release()
			return Promise.resolve()
		} finally {
			snapshottingCallerPayload = false
		}
		// Establish ownership before invoking any external integration. Calling the
		// async function directly runs synchronously until its first await; a custom
		// reporter/logger/sink could re-enter report() in that window and bypass the
		// physical admission cap (or recurse until stack exhaustion).
		const physicalReport = Promise.resolve().then(async() => await reportInternal(publicError))
		void physicalReport.then(
			release,
			release
		)
		const operation = withErrorsTimeout(physicalReport, reportTimeoutMs, 'report')
		operation.catch(() => {})
		return operation
	}
	const shutdownInternal = async(): Promise<void> => {
		if (shutdownPromise) {
			const active = shutdownPromise
			try { return await withErrorsTimeout(active, shutdownTimeoutMs, 'shutdown') } catch(error) {
				if (!isErrorsTimeout(error, 'shutdown') && shutdownPromise === active) shutdownPromise = undefined
				throw error
			}
		}
		if (closed) return
		if (activeFinalizations.size >= MAX_ACTIVE_ERROR_FINALIZATIONS) {
			throw new Error('Errors physical finalization capacity exceeded.')
		}
		accepting = false
		closing = true
		const generation = ++shutdownGeneration
		shutdownPromise = (async() => {
			const failures: unknown[] = []
			await drainReports()
			await Promise.allSettled([...activeFlushes])
			if (generation !== shutdownGeneration) return
			try {
				if (!finalizationFlush) {
					const operation = flushInternal()
					finalizationFlush = operation
					void operation.catch(() => {
						if (finalizationFlush === operation) finalizationFlush = undefined
					})
				}
				await withErrorsTimeout(finalizationFlush, flushTimeoutMs, 'flush')
			} catch(error) {
				failures.push(error)
				throwFinalizationFailures(failures, 'Errors shutdown failed.')
			}
			if (generation !== shutdownGeneration) return
			let closeFailed = false
			try {
				const closeOperation = invokeReportIntegrationCallback(integrationReentryState, () => stableSink?.close?.())
				await closeOperation
			} catch(error) {
				closeFailed = true
				failures.push(error)
			}
			closed = !closeFailed
			finalizationFlush = undefined
			closing = !closed
			throwFinalizationFailures(failures, 'Errors shutdown failed.')
		})()
		const operation = shutdownPromise
		activeFinalizations.add(operation)
		void operation.then(
			() => activeFinalizations.delete(operation),
			() => activeFinalizations.delete(operation)
		)
		try {
			await withErrorsTimeout(operation, shutdownTimeoutMs, 'shutdown')
		} catch(error) {
			if (!isErrorsTimeout(error, 'shutdown') && shutdownPromise === operation) {
				shutdownPromise = undefined
			}
			if (isErrorsTimeout(error, 'shutdown')) {
				void operation.catch(() => {
					if (shutdownPromise === operation && !closed) shutdownPromise = undefined
				})
			}
			throw error
		}
	}
	const trackFinalizationRequest = (operation: Promise<void>): Promise<void> => {
		let request!: Promise<void>
		request = operation.finally(() => pendingFinalizationRequests.delete(request))
		pendingFinalizationRequests.add(request)
		return request
	}
	const shutdown = (): Promise<void> => {
		if (integrationReentryState.active) return Promise.resolve()
		if (pendingFinalizationRequests.size >= MAX_PENDING_ERROR_FINALIZATION_REQUESTS) {
			return Promise.reject(new Error('Errors pending finalization capacity exceeded.'))
		}
		return trackFinalizationRequest(shutdownInternal())
	}
	return {
		report,
		flush,
		shutdown,
		state: () => closed ? 'closed' : closing || !accepting ? 'draining' : 'running'
	}
}
