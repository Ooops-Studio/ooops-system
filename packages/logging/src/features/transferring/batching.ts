/**
 * @file Batching functionality for transferring.
 * Wraps batch-retry pipeline from engines with logging-specific queue management.
 * The pipeline handles batching + retry internally; this wrapper adds
 * queue management for backpressure.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import type {Sink} from '../../types/sink'
import type {BackpressurePolicy as LoggingBackpressurePolicy, LogLine, TransferSignalKind} from '../../types/transferring'
import {createBoundedFailureBuffer} from '../../utils/bounded-failures'
import {readLoggingDataProperty} from '../../utils/capabilities'
import {reportLogDropped} from '../../utils/self-metrics'

import {createLoggingBatchPipeline} from './batching-pipeline'
import {createBatchQueue} from './batching-queue'
import {createBatchingTelemetry} from './batching-telemetry'
import type {BatchingPolicy, BatchRecord, BatchingState, RetryPolicy} from './batching-types'
import {
	createDeliveryError,
	FAILED_DELIVERY_LINES,
	getDeliveredCount,
	getUndeliveredLines,
	isAmbiguousDeliveryError,
	wrapDeliveryError,
	type LoggingDeliveryError,
	writeLinesSequentially
} from './delivery'

export type {BatchingPolicy, BatchingState, RetryPolicy} from './batching-types'

const FAILED_BATCH_RECORDS = Symbol('logging.failedBatchRecords')

type BatchRecordDeliveryError = LoggingDeliveryError & {
	[FAILED_BATCH_RECORDS]?: readonly BatchRecord[]
}

export function createBatching(
	policy: BatchingPolicy,
	clock: Clock,
	sink: Sink<LogLine>,
	retryPolicy?: RetryPolicy,
	onMark?: (kind: TransferSignalKind, info?: LogAttributes, size?: number) => void,
	onError?: (error: unknown) => void,
	selfMetrics?: boolean,
	metrics?: MetricsPort,
	signal?: AbortSignal,
	backpressureRef?: {current?: LoggingBackpressurePolicy}
): BatchingState {
	const terminalFailures = createBoundedFailureBuffer<unknown>('Logging batch delivery')
	const rememberTerminalFailure = (error: unknown): void => {
		const safeError = wrapDeliveryError(error, getUndeliveredLines(error, []))
		delete safeError.cause
		// Retry/fallback accounting is complete before this diagnostic snapshot is
		// retained. Keeping formatted delivery payloads here would make the
		// count-bounded failure buffer retain up to a full maximum-sized batch per
		// entry until the next lifecycle boundary.
		delete safeError[FAILED_DELIVERY_LINES]
		const aggregateMembers = readLoggingDataProperty<unknown>(error, 'errors')
		if (Array.isArray(aggregateMembers)) {
			const members: Error[] = []
			const lengthDescriptor = Object.getOwnPropertyDescriptor(aggregateMembers, 'length')
			const observedLength = lengthDescriptor && 'value' in lengthDescriptor
				? lengthDescriptor.value : 0
			const length = Number.isSafeInteger(observedLength) && observedLength >= 0
				? Math.min(observedLength, 100) : 0
			for (let index = 0; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(aggregateMembers, String(index))
				if (descriptor && 'value' in descriptor) {
					const member = wrapDeliveryError(descriptor.value, [])
					delete member.cause
					delete member[FAILED_DELIVERY_LINES]
					members.push(member)
				}
			}
			const aggregate = new AggregateError(members, safeError.message) as BatchRecordDeliveryError
			for (const key of [
				'code', 'nonRetryable', 'retryable', 'statusCode', 'knownNoDelivery',
				'ambiguousDelivery', 'pendingAmbiguousDelivery', 'deliveredCount'
			] as const) {
				const value = readLoggingDataProperty<unknown>(safeError, key)
				if (value !== undefined) Object.defineProperty(aggregate, key, {value, enumerable: true, writable: true})
			}
			terminalFailures.push(aggregate)
			return
		}
		terminalFailures.push(safeError)
	}
	const createBatchRecordDeliveryError = (
		error: unknown,
		undeliveredRecords: readonly BatchRecord[],
		deliveredCount = 0
	): BatchRecordDeliveryError => {
		const deliveryError = createDeliveryError(error, undeliveredRecords.map((record) => record.line)) as BatchRecordDeliveryError
		deliveryError[FAILED_BATCH_RECORDS] = [...undeliveredRecords]
		if (deliveredCount > 0) {
			deliveryError.deliveredCount = deliveredCount
		}
		return deliveryError
	}

	const getFailedBatchRecords = (
		error: unknown,
		fallbackRecords: readonly BatchRecord[]
	): readonly BatchRecord[] => {
		if (error && typeof error === 'object') {
			const failedRecords = readLoggingDataProperty<readonly BatchRecord[]>(error, FAILED_BATCH_RECORDS)
			if (Array.isArray(failedRecords)) {
				return [...failedRecords]
			}
		}
		const fallbackLines = fallbackRecords.map((record) => record.line)
		const failedLines = getUndeliveredLines(error, fallbackLines)
		return fallbackRecords.slice(fallbackRecords.length - failedLines.length)
	}

	const writeRecordsSequentially = async(
		records: readonly BatchRecord[],
		attemptSignal?: AbortSignal
	): Promise<number> => {
		let deliveredCount = 0
		for (let index = 0; index < records.length; index += 1) {
			const record = records[index] as BatchRecord
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (attemptSignal?.aborted) {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				const undeliveredRecords = records.slice(index)
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				throw createBatchRecordDeliveryError(attemptSignal.reason ?? new Error('logging delivery aborted'), undeliveredRecords, deliveredCount)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
			try {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				await sink.write(record.line, attemptSignal ? {signal: attemptSignal} : undefined)
				deliveredCount += 1
			} catch(error) {
				const undeliveredRecords = records.slice(index)
				const deliveryError = createBatchRecordDeliveryError(error, undeliveredRecords, deliveredCount)
				// A timeout can abort an in-progress per-record write after the sink has
				// accepted it. Keep that ambiguity when wrapping the sink error so the
				// retry pipeline never replays a record that may already be delivered.
				if (attemptSignal?.aborted && isAmbiguousDeliveryError(attemptSignal.reason)) {
					deliveryError.code = 'DELIVERY_TIMEOUT'
					deliveryError.nonRetryable = true
					deliveryError.ambiguousDelivery = true
				}
				throw deliveryError
			}
		}
		return deliveredCount
	}

	// Create send function that handles sink interface
	const send = async(items: readonly BatchRecord[], attemptSignal = signal) => {
		let attemptedItems = items
		try {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (attemptSignal?.aborted) {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				throw createBatchRecordDeliveryError(attemptSignal.reason ?? new Error('logging delivery aborted'), items)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
			attemptedItems = [...items]
			const lines = attemptedItems.map((item) => item.line)
			if (sink.writeBatch) {
				await writeLinesSequentially(sink, lines, attemptSignal ? {signal: attemptSignal} : undefined)
				return {deliveredCount: lines.length}
			}
			const deliveredCount = await writeRecordsSequentially(attemptedItems, attemptSignal)
			return {deliveredCount}
		} catch(error) {
			const failedRecords = getFailedBatchRecords(error, attemptedItems)
			throw createBatchRecordDeliveryError(
				wrapDeliveryError(error, failedRecords.map((item) => item.line)),
				failedRecords,
				getDeliveredCount(error)
			)
		}
	}

	const telemetry = createBatchingTelemetry({
		onMark, onError, selfMetrics, metrics, rememberTerminalFailure
	})

	const pipeline = createLoggingBatchPipeline({
		policy,
		retryPolicy,
		clock,
		send,
		getRetryItems: getFailedBatchRecords,
		onAmbiguousFailure: async() => false,
		telemetry,
		...(signal ? {signal} : {})
	})

	const queue = createBatchQueue({
		pipeline,
		policy,
		backpressureRef,
		onMark,
		onError: (error) => {
			rememberTerminalFailure(error)
			try { onError?.(error) } catch { /* Observer failures are isolated. */ }
		},
		onBackpressureDrop: (count) => {
			for (let index = 0; index < count; index += 1) {
				if (selfMetrics) reportLogDropped(metrics, 'backpressure')
			}
		}
	})

	const forceFlush = async(): Promise<void> => {
		const flushWithPhysicalSettlement = async(): Promise<void> => {
			try {
				await pipeline.flush()
			} catch(error) {
				if (readLoggingDataProperty(error, 'code') !== 'DELIVERY_AMBIGUOUS_PENDING') {
					throw error
				}
				// Logging owns the sink lifecycle. Do not close it while a timed-out
				// physical write is still running; settle it, then flush once more so
				// the core pipeline surfaces a late delivery failure exactly once.
				await pipeline.waitForAmbiguousDeliveries()
				await pipeline.flush()
			}
		}
		// Drain only what fits, flush it, then repeat. Pending items stay in the
		// measured backpressure queue instead of becoming unbounded continuations.
		queue.clearDrainTimer()
		do {
			queue.drainQueue()
			await flushWithPhysicalSettlement()
		} while (queue.hasPending())
		const failures = terminalFailures.drain()
		if (failures.length > 0) {
			if (failures.length === 1) throw failures[0]
			throw new AggregateError(failures, 'Multiple logging batches failed delivery')
		}
	}

	return {
		get batch() { return [] }, // Pipeline manages batch internally
		get batchBytes() { return pipeline.getBatchBytes() },
		get flushTimer() { return undefined }, // Pipeline manages flush timer internally
		addLine: queue.addLine,
		forceFlush
	}
}
