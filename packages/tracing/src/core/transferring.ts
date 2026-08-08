import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {createTokenBucket} from '@ooopsstudio/core/runtime/rate/token-bucket'
import {createMonotonicClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'
import type {MonotonicMillisClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'

import type {SpanExporterPort, SpanExportResultPort} from '../types/ports'
import {captureCapability, captureClock} from '../utils/capabilities'
import {validateResilienceConfig, validateRetryPolicy} from '../utils/config-validation'
import {createTracingOnError} from '../utils/on-error'

import {
	addNativeSet,
	deleteNativeSet,
	pushNativeArray,
	sizeNativeSet,
	sliceNativeArray,
	snapshotNativeSet
} from './native-runtime'
import {
	createNativePromise,
	deferNativePromise,
	mapNativePromise,
	observeNativePromiseSettlement,
	raceNativePromises
} from './native-runtime'
import type {DeliveryObservableExporter, ProcessorObserver} from './processor-types'
import {
	captureTimerOwnership,
	clearTimerSafely,
	captureErrorsPort,
	captureSpanExporter,
	invokeNativeAsync,
	normalizeTracingError,
	estimateSpanSize,
	snapshotSpanExportResult,
	snapshotSpanRecord
} from './processor-utils'
import type {TimerOwnership} from './processor-utils'
import {deepFreezeSpanRecord} from './span-recorder-safety'
const nativeMathMax = Math.max
const nativeMathMin = Math.min
const nativeMathPow = Math.pow
const nativeNumberIsFinite = Number.isFinite
export interface RetryPolicy {
	maxAttempts: number
	baseDelayMs: number
	multiplier: number
	maxDelayMs: number
	jitter: number
	attemptTimeoutMs: number
}
type CircuitBreakerState = 'closed' | 'open' | 'half-open'
interface CircuitBreakerTransitionInfo {
	from: CircuitBreakerState
}
interface CircuitBreakerAdmission {
	readonly generation: number
	readonly halfOpen: boolean
}
class SimpleCircuitBreaker {
	private state: CircuitBreakerState
	private previousState: CircuitBreakerState
	private failures: number
	private lastFailureTime: number
	private readonly threshold: number
	private readonly halfOpenTimeout: number
	private readonly clock: MonotonicMillisClock
	private justTransitionedToOpen: boolean
	private generation: number
	constructor(threshold: number, halfOpenTimeout: number, clock: MonotonicMillisClock) {
		this.state = 'closed'
		this.previousState = 'closed'
		this.justTransitionedToOpen = false
		this.failures = 0
		this.lastFailureTime = 0
		this.threshold = threshold
		this.halfOpenTimeout = halfOpenTimeout
		this.clock = clock
		this.generation = 0
	}
	tryAcquire(): CircuitBreakerAdmission | undefined {
		const now = this.clock.now()
		if (this.state === 'closed') {
			return {generation: this.generation, halfOpen: false}
		}
		if (this.state === 'open') {
			if (now - this.lastFailureTime >= this.halfOpenTimeout) {
				this.previousState = this.state
				this.state = 'half-open'
				this.generation++
				return {generation: this.generation, halfOpen: true}
			}
			return undefined
		}
		return undefined
	}
	recordSuccess(admission: CircuitBreakerAdmission): void {
		if (admission.generation !== this.generation) return
		if (this.state === 'half-open' && admission.halfOpen) {
			this.previousState = this.state
			this.state = 'closed'
			this.generation++
			this.failures = 0
			this.justTransitionedToOpen = false
		} else if (this.state === 'closed' && !admission.halfOpen) {
			this.failures = 0
			this.justTransitionedToOpen = false
		}
	}
	cancelHalfOpenAttempt(admission: CircuitBreakerAdmission): void {
		if (admission.generation !== this.generation || !admission.halfOpen || this.state !== 'half-open') return
		this.previousState = this.state
		this.state = 'open'
		this.generation++
		this.justTransitionedToOpen = false
	}
	recordFailure(admission: CircuitBreakerAdmission): void {
		if (admission.generation !== this.generation) return
		this.failures++
		this.lastFailureTime = this.clock.now()
		if (this.state === 'half-open' && admission.halfOpen) {
			this.previousState = this.state
			this.state = 'open'
			this.generation++
			this.justTransitionedToOpen = true
		} else if (this.state === 'closed' && !admission.halfOpen && this.failures >= this.threshold) {
			this.previousState = this.state
			this.state = 'open'
			this.generation++
			this.justTransitionedToOpen = true
		}
	}
	getTransitionInfo(): CircuitBreakerTransitionInfo | null {
		if (this.justTransitionedToOpen) {
			this.justTransitionedToOpen = false
			return {from: this.previousState}
		}
		return null
	}
}
export interface ResilientExporterOptions {
	exporter: SpanExporterPort
	retryPolicy?: RetryPolicy
	tokenBucketRate?: number
	tokenBucketBurst?: number
	breakerThreshold?: number
	breakerHalfOpenTimeout?: number
	clock: Clock
	monotonicClock?: MonotonicMillisClock
	errors?: Errors
	logger?: {
		warn(message: string, attributes?: Readonly<Record<string, import('@ooopsstudio/core/contracts/json').JsonValue>>): void
	}
	onExportFailure?: (error: unknown) => void
}
function calculateBackoff(attempt: number, policy: RetryPolicy, randomSource: () => number): number {
	const delay = nativeMathMin(
		policy.baseDelayMs * nativeMathPow(policy.multiplier, attempt),
		policy.maxDelayMs
	)
	if (delay === 0 || policy.jitter === 0) return delay
	let random = 0.5
	try {
		const candidate = randomSource()
		if (nativeNumberIsFinite(candidate) && candidate >= 0 && candidate <= 1) random = candidate
	} catch { /* randomness is optional; zero jitter is the safe fallback */ }
	const jitter = delay * policy.jitter * (random * 2 - 1)
	return nativeMathMax(0, delay + jitter)
}
async function waitForBackoff(ms: number, drainWait: Promise<void>, timers: TimerOwnership): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await raceNativePromises([
			createNativePromise<void>((resolve) => {
				timer = timers.schedule(resolve, ms)
			}),
			drainWait
		])
	} finally {
		clearTimerSafely(timer, timers)
	}
}
const EXPORT_ATTEMPT_TIMED_OUT = Object.freeze(new Error('Export timeout'))
const EXPORT_TIMER_UNAVAILABLE = Object.freeze(new Error('Export deadline timer unavailable'))
const EXPORT_DRAIN_INTERRUPTED = Object.freeze(new Error('Export interrupted for shutdown drain'))
const EXPORTER_FLUSH_TIMED_OUT = Object.freeze(new Error('Tracing resilient exporter flush timed out'))
const EXPORTER_SHUTDOWN_TIMED_OUT = Object.freeze(new Error('Tracing resilient exporter shutdown timed out'))
const DRAIN_ATTEMPT_TIMEOUT_MS = 10_000
async function withTimeout<T>(
	promise: Promise<T>, ms: number, interrupt: Promise<void> | undefined, timers: TimerOwnership
): Promise<T> {
	if (ms <= 0 && !interrupt) return promise
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const operations: Array<Promise<T>> = [promise]
		if (ms > 0) {
			let rejectTimeout!: (error: Error) => void
			const deadline = createNativePromise<never>((_resolve, reject) => { rejectTimeout = reject })
			try { timer = timers.schedule(() => rejectTimeout(EXPORT_ATTEMPT_TIMED_OUT), ms) } catch {
				// The physical promise may already own delivery. Treat an unavailable
				// deadline as ambiguous and never start a duplicate retry.
				throw EXPORT_TIMER_UNAVAILABLE
			}
			pushNativeArray(operations, deadline)
		}
		if (interrupt) pushNativeArray(operations, mapNativePromise(
			interrupt,
			() => { throw EXPORT_DRAIN_INTERRUPTED },
			() => { throw EXPORT_DRAIN_INTERRUPTED }
		))
		return await raceNativePromises(operations)
	} finally {
		clearTimerSafely(timer, timers)
	}
}
export function createResilientExporter(options: ResilientExporterOptions): SpanExporterPort {
	const ownedRandom = Math.random
	const timers = captureTimerOwnership()
	const {
		exporter: rawExporter,
		retryPolicy: configuredRetryPolicy,
		tokenBucketRate,
		tokenBucketBurst,
		breakerThreshold,
		breakerHalfOpenTimeout,
		clock,
		monotonicClock,
		errors,
		logger,
		onExportFailure
	} = options
	const retryPolicy = configuredRetryPolicy
		? Object.freeze({...configuredRetryPolicy})
		: Object.freeze({maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 0})
	if (configuredRetryPolicy) validateRetryPolicy(retryPolicy)
	const hasBackpressure = tokenBucketRate !== undefined || tokenBucketBurst !== undefined
	const hasCircuitBreaker = breakerThreshold !== undefined || breakerHalfOpenTimeout !== undefined
	if (hasBackpressure && (tokenBucketRate === undefined || tokenBucketBurst === undefined)) {
		throw new Error('Tracing backpressure requires both tokenBucketRate and tokenBucketBurst')
	}
	if (hasCircuitBreaker && (breakerThreshold === undefined || breakerHalfOpenTimeout === undefined)) {
		throw new Error('Tracing circuit breaker requires both threshold and half-open timeout')
	}
	if (hasBackpressure || hasCircuitBreaker) validateResilienceConfig({
		tokenBucketRate: tokenBucketRate ?? 1,
		tokenBucketBurst: tokenBucketBurst ?? 1,
		breakerThreshold: breakerThreshold ?? 1,
		breakerHalfOpenTimeout: breakerHalfOpenTimeout ?? 0
	})
	captureClock(clock)
	const exporter = captureSpanExporter(rawExporter)
	const safeErrors = captureErrorsPort(errors)
	const warn = captureCapability<Parameters<NonNullable<ResilientExporterOptions['logger']>['warn']>, void>(logger, 'warn')
	const elapsedClock = monotonicClock ?? createMonotonicClock()
	const breaker = hasCircuitBreaker
		? new SimpleCircuitBreaker(breakerThreshold!, breakerHalfOpenTimeout!, elapsedClock)
		: undefined
	// A zero rate is the explicit "admit no exports" configuration. Keep that
	// policy local while the shared token bucket retains strict positive inputs.
	let zeroRateTokens = tokenBucketBurst ?? 0
	const tokenBucket = !hasBackpressure ? undefined : tokenBucketRate === 0
		? {tryRemove: (tokens: number) => {
			if (tokens <= 0 || zeroRateTokens < tokens) return false
			zeroRateTokens -= tokens
			return true
		}}
		: createTokenBucket(tokenBucketRate!, 1000, tokenBucketBurst!, elapsedClock)
	const maxPhysicalExports = hasBackpressure ? nativeMathMax(1, nativeMathMin(tokenBucketBurst!, 1_024)) : 1_024
	const activePhysicalExports = new Set<Promise<unknown>>()
	let shutdownRequested = false
	let shutdownPromise: Promise<void> | undefined
	// Retain an indeterminate physical shutdown after our bounded wait expires.
	// Starting a second cleanup against the same exporter while the first call is
	// still running can double-close sockets or race resource disposal.
	let exporterShutdownAttempt: Promise<void> | undefined
	let drainRequested = false
	let releaseDrainWait: (() => void) | undefined
	let drainWait = createNativePromise<void>((resolve) => { releaseDrainWait = resolve })
	let deliveryObserver: Pick<ProcessorObserver, 'onRetry' | 'onSinkState'> | undefined
	const notifySinkState = (state: 'healthy' | 'degraded' | 'unhealthy'): void => {
		try { isolateUnexpectedThenable(deliveryObserver?.onSinkState?.(state)) } catch { /* diagnostic observers are isolated */ }
	}
	const notifyRetry = (): void => {
		try { isolateUnexpectedThenable(deliveryObserver?.onRetry?.()) } catch { /* diagnostic observers are isolated */ }
	}
	const reportError = createTracingOnError(safeErrors, {stage: 'tracing'})
	const notifyExportFailure = (error: unknown): void => {
		try { isolateUnexpectedThenable(onExportFailure?.(error)) } catch { /* diagnostic observers are isolated */ }
	}
	const warnBreakerOpened = (transition: CircuitBreakerTransitionInfo): void => {
		try {
			isolateUnexpectedThenable(warn?.(`Tracing exporter circuit breaker opened from ${transition.from}`, {
				from: transition.from,
				threshold: breakerThreshold!,
				halfOpenTimeout: breakerHalfOpenTimeout!
			}))
		} catch { /* logging cannot alter delivery decisions */ }
	}
	const exportWithResilience = async(spans: readonly SpanRecord[]) => {
		if (shutdownRequested) {
			return {
				status: 'permanent-failure' as const,
				acceptedCount: 0,
				error: new Error('Tracing exporter is shut down')
			}
		}
		if (spans.length === 0) {
			return {
				status: 'success' as const,
				acceptedCount: 0
			}
		}
		if (spans.length > 10_000) {
			return {
				status: 'permanent-failure' as const,
				acceptedCount: 0,
				error: new Error('Tracing resilient exporter batch exceeds 10000 spans')
			}
		}
		const safeSpans: SpanRecord[] = []
		let totalSpanBytes = 0
		for (const span of spans) {
			const snapshot = snapshotSpanRecord(span)
			if (!snapshot) {
				return {
					status: 'permanent-failure' as const,
					acceptedCount: 0,
					error: new Error('Tracing resilient exporter rejected an unsafe span record')
				}
			}
			const size = estimateSpanSize(snapshot)
			if (!nativeNumberIsFinite(size) || totalSpanBytes + size > 16 * 1_024 * 1_024) {
				return {
					status: 'permanent-failure' as const,
					acceptedCount: 0,
					error: new Error('Tracing resilient exporter payload exceeds 16 MiB')
				}
			}
			totalSpanBytes += size
			pushNativeArray(safeSpans, deepFreezeSpanRecord(snapshot))
		}
		spans = Object.freeze(safeSpans)
		const breakerAdmission = breaker?.tryAcquire()
		if (breaker && !breakerAdmission) {
			notifySinkState('unhealthy')
			const transition = breaker.getTransitionInfo()
			/* v8 ignore next -- defensive branch not constructible through the public tracing API */
			if (transition) warnBreakerOpened(transition)
			const error = new Error('Circuit breaker is open')
			/* v8 ignore next -- defensive branch not constructible through the public tracing API */
			notifyExportFailure(error)
			reportError(error, {reason: 'circuit-breaker-open'})
			return {
				status: 'retryable' as const,
				acceptedCount: 0,
				error
			}
		}
		if (breakerAdmission?.halfOpen) notifySinkState('degraded')
		if (tokenBucket && !tokenBucket.tryRemove(spans.length)) {
			// A half-open probe was reserved by canAttempt(), but no exporter call
			// will occur. Release that reservation so later probes are not blocked.
			if (breakerAdmission) breaker?.cancelHalfOpenAttempt(breakerAdmission)
			const error = new Error('Token bucket rate limit exceeded for batch')
			/* v8 ignore next -- defensive branch not constructible through the public tracing API */
			notifyExportFailure(error)
			reportError(error, {reason: 'rate-limit', batchSize: spans.length})
			return {
				status: 'throttled' as const,
				acceptedCount: 0,
				error
			}
		}
		let attempt = 0
		let acceptedTotal = 0
		let lastError: unknown
		let lastRetryAfterMs: number | undefined
		while (attempt < retryPolicy.maxAttempts) {
			let malformedAcknowledgement: unknown
			// shutdown() may complete while this logical export is sleeping between
			// attempts. Never start new I/O against an exporter that has already been
			// closed by that shutdown.
			if (shutdownRequested) {
				// A failed shutdown reopens exporter admission. Release a reserved
				// half-open probe now so that recovery cannot leave the breaker stuck.
				if (breakerAdmission) breaker?.cancelHalfOpenAttempt(breakerAdmission)
				return {
					status: 'permanent-failure' as const,
					acceptedCount: acceptedTotal,
					error: new Error('Tracing exporter was shut down during retry')
				}
			}
			// A processor drain permits a first attempt for batches that were queued
			// before shutdown, but no retry may keep shutdown waiting on backoff.
			if (drainRequested && attempt > 0) break
			try {
				const remaining = sliceNativeArray(spans, acceptedTotal)
				if (sizeNativeSet(activePhysicalExports) >= maxPhysicalExports) {
					throw new Error('Tracing exporter physical concurrency capacity exceeded')
				}
				const physicalExport = invokeNativeAsync<SpanExportResultPort>(
					() => exporter.export(remaining), 'Tracing exporter export'
				)
				addNativeSet(activePhysicalExports, physicalExport)
				observeNativePromiseSettlement(
					physicalExport,
					() => deleteNativeSet(activePhysicalExports, physicalExport),
					() => deleteNativeSet(activePhysicalExports, physicalExport)
				)
				const attemptTimeoutMs = drainRequested && retryPolicy.attemptTimeoutMs === 0
					? DRAIN_ATTEMPT_TIMEOUT_MS : retryPolicy.attemptTimeoutMs
				const rawResult = await withTimeout(
					physicalExport,
					attemptTimeoutMs,
					!drainRequested && retryPolicy.attemptTimeoutMs === 0 ? drainWait : undefined,
					timers
				)
				let result: SpanExportResultPort
				try { result = snapshotSpanExportResult(rawResult, remaining.length) } catch(error) {
					malformedAcknowledgement = error
					throw error
				}
				acceptedTotal += result.acceptedCount
				if (acceptedTotal === spans.length) {
					if (breakerAdmission) breaker?.recordSuccess(breakerAdmission)
					notifySinkState('healthy')
					return {status: 'success' as const, acceptedCount: acceptedTotal}
				}
				if (result.status === 'partial') {
					if (breakerAdmission) breaker?.recordSuccess(breakerAdmission)
					notifySinkState('degraded')
					return {...result, acceptedCount: acceptedTotal}
				}
				lastError = result.error ?? new Error(`Tracing export ${result.status}`)
				lastRetryAfterMs = nativeNumberIsFinite(result.retryAfterMs) && (result.retryAfterMs ?? -1) >= 0
					? nativeMathMin(result.retryAfterMs!, 2_147_483_647)
					: undefined
				if (result.status === 'permanent-failure') {
					// A permanent payload rejection still proves the exporter is
					// reachable, so it must complete a half-open health probe.
					if (breakerAdmission) breaker?.recordSuccess(breakerAdmission)
					notifyExportFailure(lastError)
					reportError(lastError, {reason: 'permanent-failure'})
					return {
						...result,
						acceptedCount: acceptedTotal,
						error: normalizeTracingError(lastError, 'Tracing export permanently failed')
					}
				}
				throw lastError
			} catch(error) {
				lastError = error === EXPORT_ATTEMPT_TIMED_OUT || error === EXPORT_DRAIN_INTERRUPTED || error === EXPORT_TIMER_UNAVAILABLE
					? error : normalizeTracingError(error, 'Tracing exporter threw an opaque value')
				attempt++
				// The exporter interface has no cancellation signal. Once the logical
				// attempt times out, the physical request may still be accepted later.
				// Retrying the same suffix concurrently would duplicate spans and grow
				// unbounded ignored work, so surface the indeterminate outcome instead.
				if (error === EXPORT_ATTEMPT_TIMED_OUT || error === EXPORT_DRAIN_INTERRUPTED ||
					error === EXPORT_TIMER_UNAVAILABLE || error === malformedAcknowledgement) break
				if (attempt < retryPolicy.maxAttempts) {
					notifyRetry()
					notifySinkState('degraded')
					const backoffMs = nativeMathMax(
						nativeMathMin(lastRetryAfterMs ?? 0, retryPolicy.maxDelayMs),
						calculateBackoff(attempt - 1, retryPolicy, ownedRandom)
					)
					lastRetryAfterMs = undefined
					await waitForBackoff(backoffMs, drainWait, timers)
				}
			}
		}
		// Retries are one logical export admission. Count only its terminal
		// transient failure so a recovered retry cannot leave the breaker open.
		if (breakerAdmission) breaker?.recordFailure(breakerAdmission)
		notifySinkState('unhealthy')
		const transition = breaker?.getTransitionInfo()
		if (transition) warnBreakerOpened(transition)
		reportError(lastError, {reason: 'retry-exhausted', attempts: attempt})
		notifyExportFailure(lastError)
		return {
			status: 'retryable' as const,
			acceptedCount: acceptedTotal,
			error: normalizeTracingError(lastError, 'Tracing export retries were exhausted')
		}
	}
	return {
		export: exportWithResilience,
		setDeliveryObserver: (observer) => { deliveryObserver = observer },
		prepareShutdown: () => {
			if (drainRequested) return
			drainRequested = true
			releaseDrainWait?.()
			try { isolateUnexpectedThenable(exporter.prepareShutdown?.()) } catch { /* nested drain interruption is advisory */ }
		},
		flush: async() => {
			try {
				await withTimeout((async() => {
					while (sizeNativeSet(activePhysicalExports) > 0) {
						const operations = snapshotNativeSet(activePhysicalExports)
						for (let index = 0; index < operations.length; index++) {
							const operation = operations[index]!
							try { await operation } catch { /* settlement is the barrier */ }
						}
					}
					if (exporter.flush) {
						await invokeNativeAsync<void>(() => exporter.flush!(), 'Tracing exporter flush', true)
					}
				})(), DRAIN_ATTEMPT_TIMEOUT_MS, undefined, timers)
			} catch(error) {
				if (error === EXPORT_ATTEMPT_TIMED_OUT) throw EXPORTER_FLUSH_TIMED_OUT
				throw normalizeTracingError(error, 'Tracing resilient exporter flush failed')
			}
		},
		shutdown: async() => {
			if (shutdownPromise) return shutdownPromise
			shutdownRequested = true
			drainRequested = true
			releaseDrainWait?.()
			const pending = deferNativePromise(async() => {
				// Give the physical exporter the first opportunity to cancel or settle
				// requests that outlived their logical attempt timeout. Waiting first
				// would deadlock exporters whose shutdown() performs that cancellation.
				try {
					if (!exporterShutdownAttempt) {
						const attempt = invokeNativeAsync<void>(
							() => exporter.shutdown(), 'Tracing exporter shutdown', true
						)
						exporterShutdownAttempt = attempt
						// A definite rejection permits a later cleanup retry. A timeout does
						// not clear the attempt because its outcome is still indeterminate.
						observeNativePromiseSettlement(attempt, () => undefined, () => {
							if (exporterShutdownAttempt === attempt) exporterShutdownAttempt = undefined
						})
					}
					await withTimeout(exporterShutdownAttempt, DRAIN_ATTEMPT_TIMEOUT_MS, undefined, timers)
				} catch(error) {
					if (error === EXPORT_ATTEMPT_TIMED_OUT) throw EXPORTER_SHUTDOWN_TIMED_OUT
					throw normalizeTracingError(error, 'Tracing exporter shutdown failed')
				}
				while (sizeNativeSet(activePhysicalExports) > 0) {
					try {
						await withTimeout((async() => {
							const operations = snapshotNativeSet(activePhysicalExports)
							for (let index = 0; index < operations.length; index++) {
								const operation = operations[index]!
								try { await operation } catch { /* settlement is the barrier */ }
							}
						})(), DRAIN_ATTEMPT_TIMEOUT_MS, undefined, timers)
					} catch(error) {
						if (error === EXPORT_ATTEMPT_TIMED_OUT) throw EXPORTER_SHUTDOWN_TIMED_OUT
						throw normalizeTracingError(error, 'Tracing exporter drain failed')
					}
				}
			})
			shutdownPromise = pending
			try { await pending } catch(error) {
				if (shutdownPromise === pending) shutdownPromise = undefined
				if (error !== EXPORTER_SHUTDOWN_TIMED_OUT) {
					shutdownRequested = false
					drainRequested = false
					drainWait = createNativePromise<void>((resolve) => { releaseDrainWait = resolve })
				}
				throw error
			}
		}
	} as SpanExporterPort & DeliveryObservableExporter
}
export {estimateSpanSize} from './processor-utils'
