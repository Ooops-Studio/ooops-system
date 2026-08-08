import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import {MAX_ACTIVE_TRANSFERS} from '../constants'
import type {
	TransferSinkState,
	TransferringHandle,
	TransferringOptions
} from '../types/transferring'
import {createBoundedFailureBuffer} from '../utils/bounded-failures'
import {captureLoggingMethod} from '../utils/capabilities'
import {createStageOnError} from '../utils/on-error'
import {sanitizeLoggingFailureCode} from '../utils/sanitize-diagnostic'
import {reportLogDropped, reportLogWritten, reportStageFailure} from '../utils/self-metrics'

import {
	attachTransferLifecycleReentryState,
	createTransferLifecycleReentryState,
	getTransferLifecycleReentryState,
	invokeTransferLifecycle,
	isTransferLifecycleReentry,
	isTransferLifecycleStateReentry,
	type TransferLifecycleReentryState
} from './transfer-lifecycle-reentry'

export interface BaseTransferringOptions extends TransferringOptions {
	readonly selfMetrics?: boolean
	readonly metrics?: MetricsPort
	readonly lifecycleReentryState?: TransferLifecycleReentryState
}

export const createTransferring = (
	options: Readonly<BaseTransferringOptions>
): TransferringHandle => {
	const {sink, errors, errorHandler, selfMetrics, metrics} = options
	const lifecycleReentryState = options.lifecycleReentryState
		?? getTransferLifecycleReentryState(sink) ?? createTransferLifecycleReentryState()
	const writeSink = captureLoggingMethod<(line: string) => void | Promise<void>>(sink, 'write')
	if (!writeSink) throw new TypeError('Logging sink must expose a write() function')
	const flushSink = captureLoggingMethod<() => void | Promise<void>>(sink, 'flush')
	const closeSink = captureLoggingMethod<() => void | Promise<void>>(sink, 'close')
	const onError = createStageOnError(errors, {stage: 'transferring', preset: 'base'})
	const activeWrites = new Set<Promise<void>>()
	const pendingFailures = createBoundedFailureBuffer<unknown>('Logging sink writes')
	let writtenTotal = 0
	let droppedTotal = 0
	let retriedTotal = 0
	let sinkState: TransferSinkState = 'healthy'
	let lastFailureCode: string | undefined
	let closing = false
	let closed = false
	let flushPromise: Promise<void> | undefined
	let closePromise: Promise<void> | undefined

	const reportFailure = (error: unknown, retain = true): void => {
		sinkState = 'unhealthy'
		lastFailureCode = sanitizeLoggingFailureCode(error)
		if (retain) pendingFailures.push(error)
		onError(error)
		if (selfMetrics) reportStageFailure(metrics, 'sink')
		if (errorHandler) {
			try { void Promise.resolve(errorHandler(error, {stage: 'sink'})).catch(onError) } catch(feedbackError) { onError(feedbackError) }
		}
	}
	const waitForActiveWrites = async(): Promise<void> => {
		await Promise.allSettled([...activeWrites])
	}
	const surfacePendingFailures = (): void => {
		const failures = pendingFailures.drain()
		if (failures.length === 0) return
		if (failures.length === 1) throw failures[0]
		throw new AggregateError(failures, 'Logging delivery failed.')
	}
	const performFlush = async(): Promise<void> => {
		await waitForActiveWrites()
		surfacePendingFailures()
		try {
			if (flushSink) {
				let result: void | Promise<void>
				result = invokeTransferLifecycle(lifecycleReentryState, () => flushSink.call(sink))
				await result
			}
			sinkState = 'healthy'
			lastFailureCode = undefined
		} catch(error) {
			reportFailure(error)
			surfacePendingFailures()
		}
	}

	const write = (line: string): void => {
		if (closed || closing) {
			droppedTotal += 1
			if (selfMetrics) reportLogDropped(metrics, 'closed')
			return
		}
		// A sink may synchronously call back into this transfer while its write is
		// still being admitted. Reject that recursive write before it can bypass
		// activeWrites ownership and exhaust the JavaScript stack.
		if (isTransferLifecycleStateReentry(lifecycleReentryState)) {
			droppedTotal += 1
			if (selfMetrics) reportLogDropped(metrics, 'capacity')
			return
		}
		if (activeWrites.size >= MAX_ACTIVE_TRANSFERS) {
			droppedTotal += 1
			if (selfMetrics) reportLogDropped(metrics, 'capacity')
			return
		}
		let release!: () => void
		const reservation = new Promise<void>((resolve) => { release = resolve })
		activeWrites.add(reservation)
		const invoke = async(): Promise<void> => {
			const result = invokeTransferLifecycle(lifecycleReentryState, () => writeSink.call(sink, line))
			await result
			writtenTotal += 1
			sinkState = 'healthy'
			lastFailureCode = undefined
			if (selfMetrics) reportLogWritten(metrics)
		}
		const operation = (flushPromise
			? flushPromise.catch(() => undefined).then(invoke)
			: invoke()).catch(reportFailure)
		void operation.finally(() => {
			activeWrites.delete(reservation)
			release()
		}).catch(() => undefined)
	}

	const flush = async(): Promise<void> => {
		if (isTransferLifecycleStateReentry(lifecycleReentryState) || isTransferLifecycleReentry(sink)) return
		if (closed) return
		if (closePromise) return await closePromise
		if (flushPromise) return await flushPromise
		const operation = performFlush()
		flushPromise = operation
		try { await operation } finally { if (flushPromise === operation) flushPromise = undefined }
	}

	const close = async(): Promise<void> => {
		if (isTransferLifecycleStateReentry(lifecycleReentryState) || isTransferLifecycleReentry(sink)) return
		if (closed) return
		if (closePromise) return await closePromise
		closing = true
		const operation = (async() => {
			const failures: unknown[] = []
			let closeCompleted = false
			if (flushPromise) {
				try { await flushPromise } catch(error) { failures.push(error) }
			}
			// A write admitted behind the existing flush is owned before invocation.
			// Drain it and flush the sink again before terminal close.
			try { await performFlush() } catch(error) { failures.push(error) }
			try {
				if (closeSink) {
					let result: void | Promise<void>
					result = invokeTransferLifecycle(lifecycleReentryState, () => closeSink.call(sink))
					await result
				}
				closeCompleted = true
			} catch(error) {
				// close() reports its rejection directly to its caller. Retaining the
				// same failure as a deferred write error would poison the next retry's
				// pre-close flush even after the sink has recovered.
				reportFailure(error, false)
				failures.push(error)
			}
			if (closeCompleted) {
				closed = true
				closing = false
				sinkState = 'closed'
				lastFailureCode = undefined
			}
			if (failures.length > 0) {
				if (failures.length === 1) throw failures[0]
				throw new AggregateError(failures, 'Logging close failed.')
			}
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
			queueSize: activeWrites.size,
			writtenTotal,
			droppedTotal,
			retriedTotal,
			sinkState: closed ? 'closed' : sinkState,
			...(lastFailureCode ? {lastFailureCode} : {})
		})
	}, lifecycleReentryState)
}
