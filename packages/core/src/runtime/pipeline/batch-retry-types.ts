/**
 * @file Batch + retry pipeline utility for service data transfer.
 * Combines batching, retry with exponential backoff, timeouts, and telemetry hooks.
 * Services plug in their sink/exporter callbacks and telemetry reporting.
 */

import type {Clock} from '../../contracts/clock'

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {

	/** Maximum attempts including first try */
	maxAttempts: number

	/** Base delay in milliseconds */
	baseDelayMs: number

	/** Multiplier per attempt */
	multiplier: number

	/** Cap for backoff delay */
	maxDelayMs: number

	/** Jitter ratio [0..1] */
	jitter: number

	/** Per-attempt timeout in milliseconds */
	attemptTimeoutMs: number
}

/**
 * Batching policy configuration.
 */
export interface BatchingPolicy {

	/** Maximum batch size (number of items) */
	maxBatch: number

	/** Maximum batch interval (milliseconds) */
	maxIntervalMs: number

	/** Maximum batch bytes */
	maxBytes: number
}

/**
 * Telemetry hooks for service-specific reporting.
 */
export interface TelemetryHooks {

	/** Called when an event occurs (write, flush, retry, drop, error, etc.) */
	onMark?: (event: string, info?: Record<string, unknown>, size?: number) => void

	/** Called when items are dropped */
	onDropped?: (count: number, reason: string) => void

	/** Called when an error occurs */
	onError?: (error: unknown) => void

	/** Called on successful write */
	onSuccess?: (count?: number) => void
}

export interface BatchRetrySendResult {
	deliveredCount?: number
}

const _ATTEMPT_TIMEOUT_ABORT_GRACE_MS = 50

/**
 * Options for creating a batch-retry pipeline.
 */
export interface BatchRetryPipelineOptions<T> {

	/** Batching policy */
	batching: BatchingPolicy

	/** Retry policy */
	retry: RetryPolicy

	/** Clock for timing */
	clock: Clock

	/** Function to send items (sink/exporter callback) */
	send: (items: readonly T[]) => Promise<void | BatchRetrySendResult>

	/** Optional signal-aware send callback used for per-attempt timeout aborts */
	sendWithSignal?: (items: readonly T[], signal: AbortSignal) => Promise<void | BatchRetrySendResult>

	/** Optional partial-delivery resolver for retrying only the failed suffix */
	getRetryItems?: (error: unknown, attemptedItems: readonly T[]) => readonly T[]

	/** Optional per-attempt item filter, for example to drop aborted records before delivery */
	prepareItems?: (items: readonly T[]) => {
		items: readonly T[]
		droppedCount?: number
		dropReason?: string
	}

	/** Optional late ambiguous delivery failure handler. Return true when the failure was durably handled. */
	onAmbiguousFailure?: (error: unknown, attemptedItems: readonly T[]) => Promise<boolean | void> | boolean | void

	/** Optional function to calculate item size in bytes */
	getItemSize?: (item: T) => number

	/** Telemetry hooks for service-specific reporting */
	telemetry?: TelemetryHooks

	/** Optional abort signal */
	signal?: AbortSignal

	/** If true, skip retry and send once */
	noRetry?: boolean
}

/**
 * Batch-retry pipeline handle.
 */
export interface BatchRetryPipeline<T> {

	/** Write a single item */
	write(item: T): void

	/** Force flush pending items */
	flush(): Promise<void>

	/**
	 * Wait for physical deliveries that outlived their bounded timeout.
	 *
	 * Most callers should use `flush()`, which deliberately rejects while an
	 * ambiguous delivery is pending. Lifecycle owners that must not close an
	 * underlying sink early can explicitly wait for physical settlement and
	 * then call `flush()` again to surface any late failure.
	 */
	waitForAmbiguousDeliveries(): Promise<void>

	/** Close the pipeline (flush and cleanup) */
	close(): Promise<void>

	/** Get current batch size */
	getBatchSize(): number

	/** Get current batch bytes */
	getBatchBytes(): number
}

/**
 * Create a batch-retry pipeline.
 * Combines batching, retry with exponential backoff, and telemetry hooks.
 */
