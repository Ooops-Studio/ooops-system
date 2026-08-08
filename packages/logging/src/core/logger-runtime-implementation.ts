import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogContext, LogLevel} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import {LOGGING_FLUSH_TIMEOUT_MS, LOGGING_SHUTDOWN_TIMEOUT_MS} from '../constants'
import type {Enriching} from '../types/enriching'
import type {Formatting, FormattingMode} from '../types/formatting'
import type {
	LoggingRuntimeState,
	LoggingSamplingPolicy,
	ManagedLogging,
	MutableLevelLogging
} from '../types/handler'
import type {Redacting} from '../types/redacting'
import type {TransferringHandle} from '../types/transferring'
import {captureLoggingMethod} from '../utils/capabilities'
import {createStageOnError} from '../utils/on-error'
import {reportStageFailure} from '../utils/self-metrics'

import {createLoggerBinding} from './logger-binding'
import {isTimeoutError, normalizeSampling, withTimeout} from './logger-helpers'
import {createLifecycleStateSync, type LoggerLifecycleState, waitForSettled} from './logger-lifecycle-state'
import {createLoggerLogWriter} from './logger-runtime-writer'
import {projectLoggerStatus} from './logger-status'
import {
	createTransferLifecycleReentryState,
	isTransferLifecycleReentry,
	isTransferLifecycleStateReentry,
	invokeTransferLifecycle
} from './transfer-lifecycle-reentry'

export interface LoggerRuntimeOptions {
	readonly mutableLevel?: boolean
	readonly sampling?: LoggingSamplingPolicy
	readonly flushTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
}

export function createLogger(
	enriching: Enriching,
	redacting: Redacting,
	formatting: Formatting,
	transferring: TransferringHandle,
	clock: Clock,
	level: LogLevel,
	mode: FormattingMode,
	context?: LogContext,
	errors?: Errors,
	selfMetrics?: boolean,
	metrics?: MetricsPort,
	lifecycle?: LifecyclePort,
	runtimeOptions: Readonly<LoggerRuntimeOptions> = {}
): ManagedLogging | MutableLevelLogging {
	const onError = createStageOnError(errors, {stage: 'logger', preset: 'core'})
	const lifecycleState: LoggerLifecycleState = {isDraining: false, healthStatus: 'healthy'}
	const controlState = {level, sampling: normalizeSampling(runtimeOptions.sampling)}
	const mutableLevel = runtimeOptions.mutableLevel === true
	const flushTimeoutMs = runtimeOptions.flushTimeoutMs ?? LOGGING_FLUSH_TIMEOUT_MS
	const shutdownTimeoutMs = runtimeOptions.shutdownTimeoutMs ?? LOGGING_SHUTDOWN_TIMEOUT_MS
	const inFlightLogs = new Set<Promise<void>>()
	const pipelineReentryState = createTransferLifecycleReentryState()

	let acceptingWrites = true
	let runtimeState: LoggingRuntimeState = 'running'
	let transferClosed = false
	let flushPromise: Promise<void> | undefined
	let shutdownPromise: Promise<void> | undefined
	let pendingDeliveryFailure: unknown
	let admissionDropped = 0
	let runtimeFailureCode: string | undefined
	let lifecycleRegistrationActive = false
	let lifecycleShutdownHookDisposer: (() => unknown) | undefined
	let lifecycleFlushHookDisposer: (() => unknown) | undefined

	const syncLifecycleState = createLifecycleStateSync(lifecycle, lifecycleState, onError)
	syncLifecycleState()
	const state = (): LoggingRuntimeState => runtimeState === 'closed'
		? 'closed'
		: runtimeState === 'draining' || lifecycleState.isDraining ? 'draining' : 'running'
	const rememberDeliveryFailure = (error: unknown): void => { pendingDeliveryFailure ??= error }
	const surfacePendingDeliveryFailure = (): void => {
		if (pendingDeliveryFailure === undefined) return
		const error = pendingDeliveryFailure
		pendingDeliveryFailure = undefined
		throw error
	}

	const flush = async(): Promise<void> => {
		if (isTransferLifecycleStateReentry(pipelineReentryState)) return
		// A sink lifecycle callback may report diagnostics through the public
		// logger and synchronously request another flush. Joining the outer logger
		// operation here would make the sink await the operation that is awaiting
		// that same sink callback.
		if (isTransferLifecycleReentry(transferring)) return
		if (runtimeState === 'closed') return
		if (!flushPromise) {
			const operation = (async() => {
				await waitForSettled(inFlightLogs)
				await transferring.flush()
				surfacePendingDeliveryFailure()
			})().catch((error: unknown) => {
				if (selfMetrics) reportStageFailure(metrics, 'flush')
				onError(error)
				throw error
			})
			flushPromise = operation
			void operation.finally(() => {
				if (flushPromise === operation) flushPromise = undefined
			}).catch(() => undefined)
		}
		return await withTimeout(flushPromise, flushTimeoutMs, 'flush')
	}

	const disposeOne = async(
		read: () => (() => unknown) | undefined,
		clear: () => void,
		failures: unknown[]
	): Promise<void> => {
		const dispose = read()
		if (!dispose) return
		try {
			await invokeTransferLifecycle(pipelineReentryState, dispose)
			clear()
		} catch(error) { failures.push(error) }
	}
	const disposeLifecycle = async(failures: unknown[]): Promise<void> => {
		const initialFailureCount = failures.length
		await disposeOne(() => lifecycleFlushHookDisposer, () => { lifecycleFlushHookDisposer = undefined }, failures)
		// During normal shutdown, preserve the shutdown hook until the flush hook
		// has actually been removed. This keeps transient disposer failures retryable.
		if (failures.length > initialFailureCount) return
		await disposeOne(() => lifecycleShutdownHookDisposer, () => { lifecycleShutdownHookDisposer = undefined }, failures)
		if (failures.length === initialFailureCount) lifecycleRegistrationActive = false
	}
	const disposeLifecycleBestEffort = (failures: unknown[]): void => {
		// Construction rollback has no usable logger to retry. Make callbacks inert,
		// invoke every known disposer, and contain asynchronous disposer rejection.
		lifecycleRegistrationActive = false
		for (const dispose of [lifecycleFlushHookDisposer, lifecycleShutdownHookDisposer]) {
			if (!dispose) continue
			try { void Promise.resolve(dispose()).catch(onError) } catch(error) { failures.push(error) }
		}
		lifecycleFlushHookDisposer = undefined
		lifecycleShutdownHookDisposer = undefined
	}

	const shutdown = async(): Promise<void> => {
		if (isTransferLifecycleStateReentry(pipelineReentryState)) return
		// The same causal cycle can cross the public shutdown boundary from a
		// transfer flush/close callback. The outer lifecycle operation retains
		// ownership, so the nested request is already covered by it.
		if (isTransferLifecycleReentry(transferring)) return
		if (runtimeState === 'closed') return
		if (shutdownPromise) return await withTimeout(shutdownPromise, shutdownTimeoutMs, 'shutdown')
		acceptingWrites = false
		runtimeState = 'draining'
		const inheritedFlush = flushPromise
		const operation = (async() => {
			const failures: unknown[] = []
			let flushTimedOut = false
			try { await flush() } catch(error) {
				failures.push(error)
				flushTimedOut = isTimeoutError(error, 'flush')
			}
			if (inheritedFlush && !flushTimedOut) {
				// A log admitted while the inherited flush was active waits behind that
				// barrier. Once admission is closed, a second flush owns that finite tail.
				if (flushPromise === inheritedFlush) flushPromise = undefined
				try { await flush() } catch(error) {
					failures.push(error)
					flushTimedOut = isTimeoutError(error, 'flush')
				}
			}
			// A timed-out flush still owns the physical transfer operation. Closing
			// concurrently could lose or duplicate records; leave close for a retry.
			if (!flushTimedOut && !transferClosed) {
				try { await transferring.close(); transferClosed = true } catch(error) { failures.push(error) }
			}
			// A transient transfer failure leaves the runtime retryable. Keep its
			// lifecycle hooks registered so the lifecycle coordinator can invoke the
			// same shutdown hook again instead of stranding a draining logger.
			if (failures.length === 0) await disposeLifecycle(failures)
			if (failures.length > 0) {
				runtimeFailureCode = 'LOGGING_FINALIZATION_FAILURE'
				for (const failure of failures) onError(failure)
				if (failures.length === 1) throw failures[0]
				throw new AggregateError(failures, 'Logging shutdown failed.')
			}
			runtimeState = 'closed'
			runtimeFailureCode = undefined
		})()
		shutdownPromise = operation
		let timedOut = false
		try {
			await withTimeout(operation, shutdownTimeoutMs, 'shutdown')
		} catch(error) {
			timedOut = isTimeoutError(error, 'shutdown')
			runtimeFailureCode = 'LOGGING_FINALIZATION_FAILURE'
			onError(error)
			if (selfMetrics) reportStageFailure(metrics, 'shutdown')
			if (timedOut) {
				void operation.catch(() => undefined).finally(() => {
					if (runtimeState !== 'closed' && shutdownPromise === operation) shutdownPromise = undefined
				})
			}
			throw error
		} finally {
			if (!timedOut && shutdownPromise === operation) shutdownPromise = undefined
		}
	}

	try {
		const registerShutdownHook = captureLoggingMethod<NonNullable<LifecyclePort['registerShutdownHook']>>(lifecycle, 'registerShutdownHook')
		const registerFlushHook = captureLoggingMethod<NonNullable<LifecyclePort['registerFlushHook']>>(lifecycle, 'registerFlushHook')
		if (lifecycle && (!registerShutdownHook || !registerFlushHook)) {
			throw new TypeError('Logging lifecycle must expose registerFlushHook() and registerShutdownHook() functions')
		}
		const shutdownHook = async(): Promise<void> => {
			if (lifecycleRegistrationActive) await shutdown()
		}
		if (registerShutdownHook) {
			const disposer = registerShutdownHook.call(lifecycle, 'observability', shutdownHook, {name: 'logging-flush', priority: 10})
			if (typeof disposer !== 'function') {
				throw new TypeError('Logging lifecycle registerShutdownHook() must return a disposer function')
			}
			lifecycleShutdownHookDisposer = disposer
		}
		if (registerFlushHook) {
			const disposer = registerFlushHook.call(lifecycle, 'logging', flush)
			if (typeof disposer !== 'function') {
				throw new TypeError('Logging lifecycle registerFlushHook() must return a disposer function')
			}
			lifecycleFlushHookDisposer = disposer
		}
		lifecycleRegistrationActive = true
	} catch(error) {
		const failures: unknown[] = [error]
		disposeLifecycleBestEffort(failures)
		throw failures.length === 1
			? error
			: new AggregateError(failures, 'Logging lifecycle registration rollback failed.')
	}

	const log = createLoggerLogWriter({
		enriching, redacting, formatting, transferring, clock, mode, errors, selfMetrics, metrics,
		controlState, lifecycleState, syncLifecycleState, isAcceptingWrites: () => acceptingWrites, inFlightLogs,
		pipelineReentryState,
		getAdmissionBarrier: () => flushPromise,
		rememberDeliveryFailure, recordDropped: () => { admissionDropped += 1 }, onError
	})
	const getStatus = () => projectLoggerStatus(
		controlState.level, mutableLevel, state(), transferring, admissionDropped, runtimeFailureCode
	)
	return createLoggerBinding({controlState, mutableLevel, log, getStatus, flush, shutdown}, context)
}
