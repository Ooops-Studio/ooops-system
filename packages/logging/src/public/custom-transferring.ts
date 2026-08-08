import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import {
	MAX_ACTIVE_DIRECT_DELIVERIES,
	QUEUE_BYTES_PRODUCTION,
	QUEUE_ITEMS_PRODUCTION
} from '../constants'
import {
	attachTransferLifecycleReentryState,
	createTransferLifecycleReentryState,
	getTransferLifecycleReentryState,
	invokeTransferLifecycle,
	isTransferLifecycleStateReentry
} from '../core/transfer-lifecycle-reentry'
import {createTransferring} from '../core/transferring'
import {createDeliveryState} from '../features/transferring/delivery-state'
import type {Sink} from '../types/sink'
import type {
	BackpressurePolicy,
	LogLine,
	TransferSinkState,
	TransferringHandle,
	TransferringPolicies
} from '../types/transferring'
import {throwIfCleanupFailed} from '../utils/custom-transferring'
import {createStageOnError} from '../utils/on-error'
import {sanitizeLoggingFailureCode} from '../utils/sanitize-diagnostic'
import {reportLogDropped, reportQueueSize} from '../utils/self-metrics'
import {createTransferringQueue, createStandardFlush} from '../utils/transferring-factory'
import {snapshotTransferringPolicies} from '../utils/transferring-validation'

const DIRECT_POLICY = {
	maxAttempts: 1,
	baseDelayMs: 0,
	multiplier: 1,
	maxDelayMs: 0,
	jitter: 0,
	attemptTimeoutMs: 8_000
} as const

export async function createCustomTransferring(
	sink: Sink<LogLine>,
	clock: Clock,
	policy: Readonly<TransferringPolicies>,
	errors?: Errors,
	selfMetrics?: boolean,
	metrics?: MetricsPort
): Promise<TransferringHandle> {
	const resolvedPolicy = snapshotTransferringPolicies(policy)
	const onError = createStageOnError(errors, {stage: 'transferring', preset: 'custom'})
	const [{createBatching}, {sendWithRetry}] = await Promise.all([
		import('../features/transferring/batching'),
		import('../features/transferring/retry')
	])
	const lifecycleReentryState = getTransferLifecycleReentryState(sink)
		?? createTransferLifecycleReentryState()
	const base = createTransferring({sink, clock, ...(errors ? {errors} : {}),
		...(selfMetrics !== undefined ? {selfMetrics} : {}), ...(metrics ? {metrics} : {}),
		lifecycleReentryState})
	const deliverySink: Sink<LogLine> = {
		write: async(line, options) => await invokeTransferLifecycle(
			lifecycleReentryState,
			() => sink.write.call(sink, line, options)
		),
		...(sink.writeBatch ? {writeBatch: async(lines: readonly LogLine[], options) => await invokeTransferLifecycle(
			lifecycleReentryState,
			() => sink.writeBatch?.call(sink, lines, options)
		)} : {})
	}
	const backpressure: BackpressurePolicy | undefined = resolvedPolicy.backpressure ??
		(resolvedPolicy.batching ? {
			maxQueuedItems: QUEUE_ITEMS_PRODUCTION,
			maxQueuedBytes: QUEUE_BYTES_PRODUCTION,
			onOverflow: 'drop-oldest'
		} : undefined)
	const backpressureRef: {current?: BackpressurePolicy} = {current: backpressure}
	const queueState = createTransferringQueue()
	const deliveries = createDeliveryState()
	let writtenTotal = 0
	let droppedTotal = 0
	let retriedTotal = 0
	let sinkState: TransferSinkState = 'healthy'
	let lastFailureCode: string | undefined
	let closed = false
	let closing = false
	let flushPromise: Promise<void> | undefined
	let closePromise: Promise<void> | undefined
	const deferredWrites: string[] = []
	let deferredWriteBytes = 0
	let directInFlightItems = 0
	let directInFlightBytes = 0
	let ambiguousInFlightItems = 0
	let ambiguousInFlightBytes = 0

	const mark = (kind: string, info?: Record<string, unknown>): void => {
		if (kind === 'write') writtenTotal += 1
		else if (kind === 'drop') {
			droppedTotal += 1
			if (selfMetrics) reportLogDropped(metrics, typeof info?.reason === 'string' ? info.reason : 'policy')
		} else if (kind === 'retry') {
			retriedTotal += 1
			sinkState = 'degraded'
		} else if (kind === 'error') {
			sinkState = 'unhealthy'
			lastFailureCode = 'LOGGING_SINK_FAILURE'
		}
	}
	const rememberFailure = (error: unknown): void => {
		sinkState = 'unhealthy'
		lastFailureCode = sanitizeLoggingFailureCode(error)
		onError(error)
	}
	const batching = resolvedPolicy.batching ? createBatching(
		resolvedPolicy.batching,
		clock,
		deliverySink,
		resolvedPolicy.retry,
		(kind, info) => { mark(kind, info) },
		rememberFailure,
		selfMetrics,
		metrics,
		undefined,
		backpressureRef
	) : undefined

	const {track, trackAmbiguous, collect} = deliveries
	const writeNow = (line: string): void => {
		try {
			if (batching) {
				batching.addLine(line, queueState.queue, queueState.queueSize, queueState.queuedBytes)
				if (selfMetrics) reportQueueSize(queueState.queueSize.value, metrics)
				return
			}
			const lineBytes = byteSize(line)
			if (directInFlightItems + ambiguousInFlightItems >= MAX_ACTIVE_DIRECT_DELIVERIES
				|| directInFlightBytes + ambiguousInFlightBytes + lineBytes > QUEUE_BYTES_PRODUCTION) {
				mark('drop', {reason: 'direct-capacity'})
				return
			}
			directInFlightItems += 1
			directInFlightBytes += lineBytes
			const retainAmbiguousDelivery = (operation: Promise<void>, error: unknown): void => {
				ambiguousInFlightItems += 1
				ambiguousInFlightBytes += lineBytes
				trackAmbiguous(operation.finally(() => {
					ambiguousInFlightItems -= 1
					ambiguousInFlightBytes -= lineBytes
				}), error)
			}
			const delivery = sendWithRetry(
				[line], deliverySink, resolvedPolicy.retry ?? DIRECT_POLICY, clock,
				(kind, info) => { mark(kind, info) }, rememberFailure,
				selfMetrics, metrics, undefined, undefined, retainAmbiguousDelivery
			).then(() => {
				writtenTotal += 1
				sinkState = 'healthy'
				lastFailureCode = undefined
			}).catch((error: unknown) => { rememberFailure(error); throw error }).finally(() => {
				directInFlightItems -= 1
				directInFlightBytes -= lineBytes
			})
			void track(delivery)
		} catch(error) {
			rememberFailure(error)
			void track(Promise.reject(error))
		}
	}
	const write = (line: string): void => {
		if (closed || closing) {
			mark('drop', {reason: 'closed'})
			return
		}
		if (flushPromise) {
			const lineBytes = byteSize(line)
			if (deferredWrites.length >= QUEUE_ITEMS_PRODUCTION
				|| deferredWriteBytes + lineBytes > QUEUE_BYTES_PRODUCTION) {
				mark('drop', {reason: 'flush-capacity'})
				return
			}
			deferredWrites.push(line)
			deferredWriteBytes += lineBytes
			return
		}
		writeNow(line)
	}
	const replayDeferredWrites = (): void => {
		const pending = deferredWrites.splice(0)
		deferredWriteBytes = 0
		for (const line of pending) writeNow(line)
	}

	const baseFlush = createStandardFlush(base, batching)
	const flush = async(): Promise<void> => {
		if (isTransferLifecycleStateReentry(lifecycleReentryState)) return
		if (flushPromise) return await flushPromise
		const operation = (async() => {
			const failures: unknown[] = []
			await collect(failures)
			try { await baseFlush() } catch(error) { failures.push(error); rememberFailure(error) }
			await collect(failures)
			if (failures.length === 0) {
				sinkState = 'healthy'
				lastFailureCode = undefined
			}
			throwIfCleanupFailed(failures, 'Custom logging flush failed.')
		})()
		flushPromise = operation
		try { await operation } finally {
			if (flushPromise === operation) {
				flushPromise = undefined
				replayDeferredWrites()
			}
		}
	}
	const close = async(): Promise<void> => {
		if (isTransferLifecycleStateReentry(lifecycleReentryState)) return
		if (closed) return
		if (closePromise) return await closePromise
		closing = true
		const operation = (async() => {
			const failures: unknown[] = []
			let baseClosed = false
			try { await flush() } catch(error) { failures.push(error) }
			try { await flush() } catch(error) { failures.push(error) }
			try {
				await base.close()
				baseClosed = true
			} catch(error) {
				failures.push(error)
				rememberFailure(error)
				baseClosed = base.telemetry().sinkState === 'closed'
			}
			if (baseClosed) {
				closed = true
				closing = false
				sinkState = 'closed'
				lastFailureCode = undefined
			}
			throwIfCleanupFailed(failures, 'Custom logging close failed.')
		})()
		closePromise = operation
		try { await operation } catch(error) {
			closePromise = undefined
			throw error
		}
	}

	return attachTransferLifecycleReentryState({
		write,
		flush,
		close,
		telemetry: () => Object.freeze({
			queueSize: deferredWrites.length + (batching
				? queueState.queueSize.value
				: directInFlightItems + ambiguousInFlightItems),
			writtenTotal,
			droppedTotal,
			retriedTotal,
			sinkState: closed ? 'closed' : sinkState,
			...(lastFailureCode ? {lastFailureCode} : {})
		})
	}, lifecycleReentryState)
}
