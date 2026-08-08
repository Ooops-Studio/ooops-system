import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {computeErrorKey} from '@ooopsstudio/core/utils/compute-error-key'

import {
	DEFAULT_DEDUPLICATE_TTL,
	DEFAULT_ERRORS_DEDUPLICATION_TIMEOUT_MS,
	DEFAULT_ERRORS_FLUSH_TIMEOUT_MS,
	DEFAULT_ERRORS_REPORT_TIMEOUT_MS,
	DEFAULT_ERRORS_SHUTDOWN_TIMEOUT_MS,
	MAX_ACTIVE_ERROR_FLUSHES,
	MAX_ACTIVE_ERROR_HANDLES,
	MAX_ACTIVE_ERROR_DEDUPLICATIONS,
	MAX_ACTIVE_ERROR_REPORTS,
	MAX_PENDING_ERROR_FINALIZATION_REQUESTS,
	MAX_PENDING_ERROR_FLUSH_REQUESTS
} from '../constants'
import {isValidClassificationRegistryConfiguration} from '../features/classification/classify-error'
import type {ErrorHandlerOptions, ErrorsHandlerPort} from '../types/error-handler'
import type {EnrichedError} from '../types/normalized-error'
import type {CachePort} from '../types/ports'
import {captureErrorCapability, inspectErrorCapability, type ErrorRuntimeMethod} from '../utils/capabilities'
import {EnrichedError as EnrichedErrorClass} from '../utils/enriched-error-class'
import {snapshotErrorHandlerOptions} from '../utils/options'
import {deriveRedactedError, redactEnrichedError} from '../utils/redaction'
import {createSafeObserve} from '../utils/safe-observe'

import {createClassify} from './classify'
import {createErrorDeduplicationCache} from './deduplication-cache'
import {registerErrorLifecycleHooks} from './lifecycle-hooks'
import {createNormalize} from './normalize'
import {createReportRuntime, invokeReportIntegrationCallback} from './report'
import {isErrorsTimeout, withErrorsTimeout} from './timeout'

function createHandlerCapacityError(): EnrichedError {
	return Object.freeze({
		kind: 'ResourceError',
		message: 'Errors handler capacity exceeded.',
		code: 'ENOSPC',
		severity: 'error',
		category: 'RESOURCE',
		timestamp: 0,
		source: 'errors'
	})
}

/**
 * Minimal error-handling kernel: normalize, classify, optionally deduplicate,
 * then fan out a redacted error. It deliberately owns no policy, retry, spool,
 * status, or dynamic rewiring machinery.
 */
export function createErrorHandler(rawOptions: ErrorHandlerOptions = {}): ErrorsHandlerPort {
	const options = snapshotErrorHandlerOptions(rawOptions)
	const safeObserve = createSafeObserve(options.observe)
	let invalidConfiguration: string | undefined
	let configuredClockNow: ErrorRuntimeMethod | undefined
	try {
		if (options.rethrow !== undefined && typeof options.rethrow !== 'boolean') invalidConfiguration = 'errors_invalid_rethrow'
		else if (options.deduplicate !== undefined && typeof options.deduplicate !== 'boolean') invalidConfiguration = 'errors_invalid_deduplicate'
		else if (options.clock !== undefined && (!options.clock
			|| !(configuredClockNow = captureErrorCapability(options.clock, 'now')))) invalidConfiguration = 'errors_invalid_clock'
		else if (options.observe !== undefined && typeof options.observe !== 'function') invalidConfiguration = 'errors_invalid_observer'
		else if (options.defaultSource !== undefined
			&& (typeof options.defaultSource !== 'string' || options.defaultSource.length > 1_024
				|| options.defaultSource.trim().length === 0)) invalidConfiguration = 'errors_invalid_source'
		else if (options.classificationRegistry !== undefined
			&& (!options.classificationRegistry || typeof options.classificationRegistry !== 'object'
				|| Array.isArray(options.classificationRegistry)
				|| !isValidClassificationRegistryConfiguration(options.classificationRegistry))) {
			invalidConfiguration = 'errors_invalid_classification_registry'
		}
		else if (options.report !== undefined && typeof options.report !== 'function') invalidConfiguration = 'errors_invalid_reporter'
		else if (options.flushTimeoutMs !== undefined && (!Number.isSafeInteger(options.flushTimeoutMs)
			|| options.flushTimeoutMs <= 0 || options.flushTimeoutMs > 60_000)) invalidConfiguration = 'errors_invalid_flush_timeout'
		else if (options.shutdownTimeoutMs !== undefined && (!Number.isSafeInteger(options.shutdownTimeoutMs)
			|| options.shutdownTimeoutMs <= 0 || options.shutdownTimeoutMs > 60_000)) invalidConfiguration = 'errors_invalid_shutdown_timeout'
		else if (options.reportTimeoutMs !== undefined && (!Number.isSafeInteger(options.reportTimeoutMs)
			|| options.reportTimeoutMs <= 0 || options.reportTimeoutMs > 60_000)) invalidConfiguration = 'errors_invalid_report_timeout'
		if (options.sink !== undefined) {
			const sink = options.sink
			const flush = inspectErrorCapability(sink, 'flush')
			const close = inspectErrorCapability(sink, 'close')
			const capture = captureErrorCapability(sink, 'capture')
			if (!sink || !capture
				|| (flush.present && !flush.method)
				|| (close.present && !close.method)) invalidConfiguration = 'errors_invalid_sink'
		}
	} catch { invalidConfiguration = 'errors_invalid_options' }
	if (invalidConfiguration) throw new Error(invalidConfiguration)
	const rawClock = options.clock ?? createSystemClock()
	const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_ERRORS_FLUSH_TIMEOUT_MS
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_ERRORS_SHUTDOWN_TIMEOUT_MS
	const reportTimeoutMs = options.reportTimeoutMs ?? DEFAULT_ERRORS_REPORT_TIMEOUT_MS
	const integrationReentryState = {active: false}
	const clockNow = configuredClockNow ?? captureErrorCapability(rawClock, 'now')!
	const clock = {now: (): number => clockNow.call(rawClock) as number}
	const cachePort = options.ports?.cache
	const cacheGet = captureErrorCapability(cachePort, 'get')
	const cacheSet = captureErrorCapability(cachePort, 'set')
	const stableCachePort: CachePort | undefined = cachePort
		? {
			...(cacheGet ? {get: async(key: string) => {
				const operation = invokeReportIntegrationCallback(integrationReentryState, () => cacheGet.call(cachePort, key))
				const value: unknown = await operation
				return typeof value === 'string' ? value : undefined
			}} : {}),
			...(cacheSet ? {set: async(key: string, value: string, ttl?: number) => {
				const operation = invokeReportIntegrationCallback(integrationReentryState, () => cacheSet.call(cachePort, key, value, ttl))
				await operation
			}} : {})
		}
		: undefined
	const deduplicationNow = (): number => {
		try {
			const value = clock.now()
			if (Number.isSafeInteger(value) && value >= 0) return value
		} catch {
			// Fall back to the system clock for cache TTL decisions.
		}
		try {
			const value = Date.now()
			return Number.isSafeInteger(value) && value >= 0 ? value : 0
		} catch { return 0 }
	}
	const deduplicationCache = options.deduplicate
		? createErrorDeduplicationCache({
			ttl: DEFAULT_DEDUPLICATE_TTL,
			now: deduplicationNow,
			...(options.observe ? {observe: safeObserve} : {}),
			...(stableCachePort ? {cache: stableCachePort} : {}),
			maxCacheSize: 1_000
		})
		: undefined
	const normalizeInternal = createNormalize({
		clock,
		...(options.defaultSource ? {defaultSource: options.defaultSource} : {}),
		...(options.ports?.tracer ? {tracer: options.ports.tracer} : {}),
		redact: false
	})
	const classifyInternal = createClassify(options.classificationRegistry)
	const reportRuntime = createReportRuntime({
		...(options.report ? {baseReport: options.report} : {}),
		...(options.ports?.logger ? {logger: options.ports.logger} : {}),
		...(options.ports?.metrics ? {metrics: options.ports.metrics} : {}),
		...(options.ports?.tracer ? {tracer: options.ports.tracer} : {}),
		...(options.sink ? {sink: options.sink} : {}),
		...(options.observe ? {observe: options.observe} : {}),
		flushTimeoutMs,
		shutdownTimeoutMs,
		reportTimeoutMs
	}, integrationReentryState)
	type RuntimeState = 'running' | 'draining' | 'closed'
	let state: RuntimeState = 'running'
	const activeHandles = new Set<Promise<unknown>>()
	let snapshottingCallerPayload = false
	let snapshottingPublicTransform = false
	const publicNormalizationDecisions = new WeakMap<object, {
		kind: string
		code?: string
		category: EnrichedError['category']
		severity: EnrichedError['severity']
	}>()
	const activeFlushes = new Set<Promise<void>>()
	const physicalDeduplications = new Set<Promise<unknown>>()
	const physicalReports = new Set<Promise<unknown>>()
	const pendingFlushRequests = new Set<Promise<void>>()
	const pendingFinalizationRequests = new Set<Promise<void>>()
	let shutdownPromise: Promise<void> | undefined
	let deduplicationCacheDestroyed = false
	let deduplicationCacheDestroyAttempt: Promise<void> | undefined
	let deduplicationUnavailable = false
	let disposeLifecycleHooks = async(): Promise<void> => undefined
	let reportRuntimeShutdownCompleted = false
	let reportRuntimeFlushPromise: Promise<void> | undefined
	let handlerFlushPromise: Promise<void> | undefined
	let handlerAdmissionVersion = 0
	let handlerFlushScheduled = -1
	let handlerFlushCompleted = -1

	const flushReportRuntime = (): Promise<void> => {
		if (reportRuntimeFlushPromise) return reportRuntimeFlushPromise
		const physical = Promise.resolve().then(async() => { await reportRuntime.flush() })
		const tracked = physical.finally(() => {
			if (reportRuntimeFlushPromise === tracked) reportRuntimeFlushPromise = undefined
		})
		reportRuntimeFlushPromise = tracked
		return tracked
	}

	const handleInternal = async(
		publicError: EnrichedError,
		admissionBarrier?: Promise<void>
	): Promise<EnrichedError> => {
		// A handle admitted after a physical flush generation must not enter the
		// report runtime ahead of that generation. Otherwise the runtime cannot
		// distinguish it from pre-cutoff delivery and the earlier flush may wait on
		// caller work that did not exist when flush() was invoked.
		if (admissionBarrier) await admissionBarrier.catch(() => undefined)
		let shouldReport = true
		if (options.deduplicate && deduplicationCache && !deduplicationUnavailable) {
			try {
				if (physicalDeduplications.size >= MAX_ACTIVE_ERROR_DEDUPLICATIONS) {
					throw new Error('deduplication_capacity')
				}
				const physicalDeduplication = Promise.resolve(deduplicationCache.shouldReport(
					computeErrorKey(publicError),
					publicError.kind,
					publicError.category,
					publicError.correlationId
				))
				physicalDeduplications.add(physicalDeduplication)
				void physicalDeduplication.then(
					() => physicalDeduplications.delete(physicalDeduplication),
					() => physicalDeduplications.delete(physicalDeduplication)
				)
				const decision: unknown = await withErrorsTimeout(
					physicalDeduplication,
					Math.min(DEFAULT_ERRORS_DEDUPLICATION_TIMEOUT_MS, reportTimeoutMs),
					'deduplication'
				)
				// Only an explicit false is allowed to suppress an application error.
				// Malformed custom cache results fail open just like thrown failures.
				shouldReport = decision !== false
			} catch(error_) {
				// A custom cache can ignore cancellation and leave its physical work
				// pending after our deadline. Stop calling that boundary after a real
				// timeout so sequential errors cannot accumulate detached operations.
				const timedOut = isErrorsTimeout(error_, 'deduplication')
				if (timedOut) deduplicationUnavailable = true
				safeObserve('error:reporter', {
					reporter: 'unknown', status: timedOut ? 'timeout' : 'error',
					error: redactEnrichedError(publicError),
					reason: timedOut ? 'deduplication_timeout' : 'deduplication_unavailable'
				})
				// A failed cache must not suppress error reporting.
			}
		}

		if (shouldReport) {
			try {
				if (physicalReports.size < MAX_ACTIVE_ERROR_REPORTS) {
					// A custom runtime receives its own redacted projection. It must not be
					// able to mutate the value returned to the caller, and its failure is
					// best-effort just like every built-in reporter.
					const physicalReport = Promise.resolve().then(async() => {
						await reportRuntime.report(publicError)
					})
					physicalReports.add(physicalReport)
					void physicalReport.then(
						() => physicalReports.delete(physicalReport),
						() => physicalReports.delete(physicalReport)
					)
					await withErrorsTimeout(
						physicalReport, reportTimeoutMs, 'report'
					)
				} else {
					safeObserve('error:reporter', {
						reporter: 'unknown', status: 'error', error: redactEnrichedError(publicError),
						reason: 'handler_report_capacity'
					})
				}
			} catch {
				// Reporting failures must never replace the application error.
			}
		}
		if (options.rethrow) throw new EnrichedErrorClass(publicError)
		return publicError
	}
	const handle = (error: unknown, context?: Record<string, unknown>): Promise<EnrichedError> => {
		if (state !== 'running') return Promise.reject(new Error('error handler is shut down'))
		// Admission must happen before inspecting caller-controlled values. Once the
		// bounded queue is full, normalizing another hostile/deep payload would let an
		// overload keep consuming CPU even though the result cannot be processed.
		if (snapshottingCallerPayload || activeHandles.size >= MAX_ACTIVE_ERROR_HANDLES) {
			const capacityError = createHandlerCapacityError()
			safeObserve('error:reporter', {
				reporter: 'unknown', status: 'error', error: redactEnrichedError(capacityError),
				reason: 'handler_capacity'
			})
			return options.rethrow
				? Promise.reject(new EnrichedErrorClass(capacityError))
				: Promise.resolve(capacityError)
		}
		let releaseOwnership!: () => void
		const ownership = new Promise<void>((resolve) => { releaseOwnership = resolve })
		activeHandles.add(ownership)
		handlerAdmissionVersion++
		const release = () => {
			activeHandles.delete(ownership)
			releaseOwnership()
		}
		let publicError: EnrichedError
		// Snapshot the current physical flush at admission. Future flushes may wait
		// for this handle, so consulting a later barrier inside handleInternal would
		// create a cycle.
		const admissionBarrier = handlerFlushPromise
		try {
			snapshottingCallerPayload = true
			// Snapshot caller-owned error/context data at admission time. Deferring
			// normalization to a microtask allowed immediate caller mutation to change
			// the diagnostic that was eventually reported.
			publicError = redactEnrichedError(classifyInternal(normalizeInternal(error, context)))
		} catch(error_) {
			release()
			return Promise.reject(error_)
		} finally {
			snapshottingCallerPayload = false
		}
		const pending = Promise.resolve().then(() => handleInternal(publicError, admissionBarrier))
		void pending.then(
			release,
			release
		)
		return pending
	}
	const drainActiveHandles = async(): Promise<void> => {
		const accepted = [...activeHandles]
		if (accepted.length > 0) await Promise.allSettled(accepted)
	}
	const transformReentrancyFallback = (): EnrichedError => {
		const capacityError = createHandlerCapacityError()
		safeObserve('error:reporter', {
			reporter: 'unknown', status: 'error', error: capacityError,
			reason: 'handler_transform_reentrancy'
		})
		return capacityError
	}
	const normalizePublic = (error: unknown): EnrichedError => {
		if (snapshottingCallerPayload || snapshottingPublicTransform) return transformReentrancyFallback()
		snapshottingPublicTransform = true
		try {
			const internal = normalizeInternal(error)
			const normalized = redactEnrichedError(internal)
			const classified = classifyInternal(internal)
			publicNormalizationDecisions.set(normalized, {
				kind: normalized.kind,
				...(normalized.code === undefined ? {} : {code: normalized.code}),
				category: classified.category,
				severity: classified.severity
			})
			return normalized
		} finally { snapshottingPublicTransform = false }
	}
	const classifyPublic = (error: EnrichedError): EnrichedError => {
		if (snapshottingCallerPayload || snapshottingPublicTransform) return transformReentrancyFallback()
		snapshottingPublicTransform = true
		try {
			const safeError = redactEnrichedError(error)
			const remembered = error && typeof error === 'object'
				? publicNormalizationDecisions.get(error)
				: undefined
			if (remembered && remembered.kind === safeError.kind && remembered.code === safeError.code) {
				return deriveRedactedError(safeError, {
					category: remembered.category, severity: remembered.severity
				})
			}
			return redactEnrichedError(classifyInternal(error))
		} finally { snapshottingPublicTransform = false }
	}
	const flush = (): Promise<void> => {
		if (integrationReentryState.active) return Promise.resolve()
		if (pendingFlushRequests.size >= MAX_PENDING_ERROR_FLUSH_REQUESTS) {
			return Promise.reject(new Error('Errors handler pending flush capacity exceeded.'))
		}
		let physical: Promise<void>
		if (state === 'closed') physical = Promise.resolve()
		else if (state === 'draining') physical = shutdownPromise
			?? Promise.reject(new Error('Errors handler is draining.'))
		else {
			const target = handlerAdmissionVersion
			// Own the caller's cutoff now, not when a queued flush generation gets
			// to run. Later handles must not extend an already accepted flush.
			const acceptedForTarget = [...activeHandles]
			if (handlerFlushCompleted >= target) physical = Promise.resolve()
			else if (handlerFlushPromise && handlerFlushScheduled >= target) physical = handlerFlushPromise
			else if (activeFlushes.size >= MAX_ACTIVE_ERROR_FLUSHES) {
				physical = Promise.reject(new Error('Errors handler physical flush capacity exceeded.'))
			}
			else {
				const predecessor = handlerFlushPromise
				handlerFlushScheduled = target
				const operation = Promise.resolve(predecessor).catch(() => undefined).then(async() => {
					if (acceptedForTarget.length > 0) await Promise.allSettled(acceptedForTarget)
					// Waiting the accepted handles is sufficient: each handle admits its
					// report before settling, and the report runtime's own flush cutoff then
					// owns that physical delivery. Snapshotting all handler reports here would
					// incorrectly pull post-cutoff work into this generation.
					try { await flushReportRuntime() } catch { throw new Error('Errors handler flush failed.') }
					handlerFlushCompleted = Math.max(handlerFlushCompleted, target)
				})
				const tracked = operation.finally(() => {
					if (handlerFlushPromise === tracked) handlerFlushPromise = undefined
				})
				handlerFlushPromise = tracked
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
	const shutdownInternal = async(): Promise<void> => {
		if (state === 'closed') return
		if (shutdownPromise) return await withErrorsTimeout(shutdownPromise, shutdownTimeoutMs, 'shutdown')
		state = 'draining'
		const operation = (async() => {
			await drainActiveHandles()
			const reports = [...physicalReports]
			if (reports.length > 0) await Promise.allSettled(reports)
			await Promise.allSettled([...activeFlushes])
			if (!reportRuntimeShutdownCompleted) {
				await reportRuntime.shutdown()
				reportRuntimeShutdownCompleted = true
			}
			if (!deduplicationCacheDestroyed && deduplicationCache?.destroy) {
				await destroyDeduplicationCache()
			}
			const disposeOperation = invokeReportIntegrationCallback(integrationReentryState, () => disposeLifecycleHooks())
			await disposeOperation
			state = 'closed'
		})()
		shutdownPromise = operation
		try {
			await withErrorsTimeout(operation, shutdownTimeoutMs, 'shutdown')
		} catch(error) {
			// Admission stays closed. A rejected physical attempt is retired so the
			// next shutdown can retry only the incomplete idempotent finalizers.
			if (!isErrorsTimeout(error, 'shutdown') && shutdownPromise === operation) {
				shutdownPromise = undefined
			}
			if (isErrorsTimeout(error, 'shutdown')) {
				void operation.then(
					() => undefined,
					() => { if (shutdownPromise === operation) shutdownPromise = undefined }
				)
			}
			throw error
		}
	}
	const destroyDeduplicationCache = async(): Promise<void> => {
		if (deduplicationCacheDestroyed || !deduplicationCache?.destroy) return
		if (physicalDeduplications.size > 0) {
			throw new Error('Errors deduplication cleanup is still active.')
		}
		if (!deduplicationCacheDestroyAttempt) {
			const attempt = Promise.resolve().then(async() => { await deduplicationCache.destroy?.() })
			deduplicationCacheDestroyAttempt = attempt
			void attempt.then(
				() => { deduplicationCacheDestroyed = true },
				() => undefined
			).finally(() => {
				if (deduplicationCacheDestroyAttempt === attempt) deduplicationCacheDestroyAttempt = undefined
			})
		}
		await deduplicationCacheDestroyAttempt
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
			return Promise.reject(new Error('Errors handler pending finalization capacity exceeded.'))
		}
		return trackFinalizationRequest(shutdownInternal())
	}
	// Lifecycle finalization must use the handler-level admission barrier. Wiring
	// hooks directly to the report runtime could close a sink while an accepted
	// handle was still waiting on deduplication or another asynchronous stage.
	try {
		disposeLifecycleHooks = registerErrorLifecycleHooks(options.ports?.lifecycle, {flush, shutdown})
	} catch(error) {
		void Promise.allSettled([
			Promise.resolve().then(async() => await reportRuntime.shutdown()),
			Promise.resolve().then(async() => await deduplicationCache?.destroy?.())
		])
		throw error
	}

	return {
		handle,
		normalize: normalizePublic,
		classify: classifyPublic,
		flush,
		shutdown
	}
}
