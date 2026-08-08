import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {
	createBatchRetryPipeline,
	type BatchRetryPipeline,
	type BatchRetrySendResult,
	type TelemetryHooks
} from '@ooopsstudio/core/runtime/pipeline/batch-retry'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import type {BatchingPolicy, BatchRecord, RetryPolicy} from './batching-types'

interface LoggingBatchPipelineOptions {
	readonly policy: BatchingPolicy
	readonly retryPolicy?: RetryPolicy
	readonly clock: Clock
	readonly send: (items: readonly BatchRecord[], signal?: AbortSignal) => Promise<BatchRetrySendResult>
	readonly getRetryItems: (error: unknown, items: readonly BatchRecord[]) => readonly BatchRecord[]
	readonly onAmbiguousFailure: (error: unknown, items: readonly BatchRecord[]) => Promise<boolean | void>
	readonly telemetry: TelemetryHooks
	readonly signal?: AbortSignal
}

const NO_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 1,
	baseDelayMs: 0,
	multiplier: 1,
	maxDelayMs: 0,
	jitter: 0,
	attemptTimeoutMs: 5_000
}

/**
 * Adapt logging records to the shared core batch/retry pipeline. Keeping this
 * wiring separate leaves `batching.ts` focused on logging-specific delivery.
 */
export function createLoggingBatchPipeline(
	options: Readonly<LoggingBatchPipelineOptions>
): BatchRetryPipeline<BatchRecord> {
	const retry = options.retryPolicy ?? NO_RETRY_POLICY
	return createBatchRetryPipeline({
		batching: options.policy,
		retry,
		clock: options.clock,
		send: options.send,
		sendWithSignal: options.send,
		getRetryItems: options.getRetryItems,
		onAmbiguousFailure: options.onAmbiguousFailure,
		prepareItems: (items) => ({items, droppedCount: 0}),
		// `maxBytes` is a batching threshold for logs, not a per-record rejection
		// limit. A single already-bounded log record must be admitted and flushed
		// on its own instead of disappearing when it exceeds the batch target.
		getItemSize: (item) => Math.min(byteSize(item.line), options.policy.maxBytes),
		telemetry: options.telemetry,
		...(options.signal ? {signal: options.signal} : {})
	})
}
