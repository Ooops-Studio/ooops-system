/**
 * @file Helper utilities for metrics service.
 * Shared functions to reduce duplication across components.
 */

import {exponentialBackoff} from '@ooopsstudio/core/utils/async/backoff'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import {MAX_METRICS_TIMER_MS, METRICS_MAX_RETRIES} from '../constants'
import type {MetricExporterPort} from '../types/exporter'

import {safeJsonStringify} from './safe-json-stringify'

function readOwnDataProperty(value: unknown, key: PropertyKey): unknown {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch {
		return undefined
	}
}

/**
 * Get exporter name for logging/telemetry
 * @param exporter - Exporter instance
 * @returns Exporter name (class name or 'unknown')
 */
export function getExporterName(exporter: MetricExporterPort): string {
	try {
		const prototype = Object.getPrototypeOf(exporter as object) as object | null
		const constructor = prototype === null
			? undefined
			: Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value as unknown
		if (typeof constructor !== 'function') return 'unknown'
		const name = Object.getOwnPropertyDescriptor(constructor, 'name')?.value as unknown
		return typeof name === 'string' && name.length > 0 && name.length <= 128
			? name
			: 'unknown'
	} catch {
		return 'unknown'
	}
}

/**
 * Format an error message with optional structured context.
 * @param message - Base error message
 * @param context - Optional key-value context
 * @returns Message with context appended in a stable order
 */
export function formatErrorMessage(message: string, context?: Record<string, string>): string {
	const entries = Object.entries(context ?? {})
	if (entries.length === 0) {
		return message
	}
	return `${message} (${entries.map(([key, value]) => `${key}=${value}`).join(', ')})`
}

/**
 * Create a metric key from name and labels
 * Sorts labels for consistent key generation
 * @param name - Metric name
 * @param labels - Metric labels
 * @returns Unique key for the metric (name + sorted labels)
 */
export function createMetricKey(name: string, labels: Record<string, string>): string {

	const sortedLabels = Object.entries(labels)
		.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)

	return safeJsonStringify([name, sortedLabels])
}

/**
 * Retry configuration
 */
export interface RetryConfig {
	readonly maxRetries: number
	readonly baseDelayMs: number
	readonly maxDelayMs?: number
	readonly multiplier?: number
	readonly jitter?: boolean
	readonly jitterFactor?: number
}

/**
 * Options for retry with backoff
 */
export interface RetryWithBackoffOptions<T> {
	readonly operation: () => Promise<T>
	readonly config: RetryConfig
	readonly shouldRetry?: (error: unknown, attempt: number) => boolean
	readonly onRetry?: (attempt: number, error: unknown) => void
	readonly onError?: (error: unknown, attempt: number, context?: Record<string, string>) => void
}

/**
 * Calculate exponential backoff delay with optional jitter
 * Uses the shared exponential backoff implementation.
 */
function calculateBackoffDelay(attempt: number, config: RetryConfig): number {
	const multiplier = config.multiplier ?? 2
	const maxDelayMs = config.maxDelayMs ?? MAX_METRICS_TIMER_MS
	const jitterFactor = config.jitter ? (config.jitterFactor ?? 0.3) : 0

	// Use engines' exponentialBackoff
	// Note: engines uses attempt - 1 for pow, but metrics uses attempt directly
	// So we pass attempt + 1 to get the same behavior as the original implementation
	return exponentialBackoff(attempt + 1, {
		baseDelayMs: config.baseDelayMs,
		multiplier,
		maxDelayMs,
		jitter: jitterFactor
	})
}

function sleepForRetry(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

/**
 * Retry an operation with exponential backoff
 * @param options - Retry options
 * @returns Result of the operation
 * @throws Last error if all retries are exhausted
 */
export async function retryWithBackoff<T>(options: RetryWithBackoffOptions<T>): Promise<T> {

	const {
		operation,
		config,
		shouldRetry,
		onRetry,
		onError
	} = options
	if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > METRICS_MAX_RETRIES) {
		throw new Error(`Retry maxRetries must be an integer between 0 and ${METRICS_MAX_RETRIES}`)
	}
	if (!Number.isSafeInteger(config.baseDelayMs) || config.baseDelayMs <= 0 || config.baseDelayMs > MAX_METRICS_TIMER_MS) {
		throw new Error(`Retry baseDelayMs must be positive and finite, got ${config.baseDelayMs}`)
	}
	if (config.maxDelayMs !== undefined && (!Number.isSafeInteger(config.maxDelayMs)
		|| config.maxDelayMs < config.baseDelayMs || config.maxDelayMs > MAX_METRICS_TIMER_MS)) {
		throw new Error(`Retry maxDelayMs must be finite and at least baseDelayMs, got ${config.maxDelayMs}`)
	}
	if (config.multiplier !== undefined && (!Number.isFinite(config.multiplier) || config.multiplier <= 0)) {
		throw new Error(`Retry multiplier must be positive and finite, got ${config.multiplier}`)
	}
	if (config.jitterFactor !== undefined && (!Number.isFinite(config.jitterFactor) || config.jitterFactor < 0 || config.jitterFactor > 1)) {
		throw new Error(`Retry jitterFactor must be finite and between 0 and 1, got ${config.jitterFactor}`)
	}

	for (let attempt = 0; ; attempt++) {

		try {
			return await operation()
		} catch(error) {

			// Check if we should retry (default: always retry if not last attempt)
			const canRetry = attempt < config.maxRetries
			const shouldRetryThis = canRetry && (shouldRetry ? shouldRetry(error, attempt) : true)

			if (!shouldRetryThis) {
				// Don't log here - shouldRetry callback should handle logging
				// to avoid duplicate logs
				throw error
			}

			const configuredDelay = calculateBackoffDelay(attempt, config)
			const retryAfter = readOwnDataProperty(error, 'retryAfterMs')
			const retryAfterMs = typeof retryAfter === 'number' && Number.isFinite(retryAfter)
				? Math.max(0, Math.min(MAX_METRICS_TIMER_MS, retryAfter))
				: 0
			const delay = Math.max(configuredDelay, retryAfterMs)

			// Call onRetry callback before retrying
			if (onRetry) {
				try {
					onRetry(attempt, error)
				} catch {
					// Retry observers must not interrupt the protected operation.
				}
			}

			// Log error once per retry attempt (not on every iteration)
			if (onError) {
				try {
					onError(error, attempt, {retrying: 'true'})
				} catch {
					// Diagnostics are best-effort.
				}
			}

			// Wait before retry
			await sleepForRetry(delay)
		}
	}

}

/**
 * Estimate size of a metric record in bytes
 * @param record - Metric record to estimate
 * @param useQuickEstimate - If true, use constant estimate (200 bytes). If false,
 * calculate actual size.
 * @returns Estimated size in bytes
 */
export function estimateMetricRecordSize(record: {
	name: string;
	labels: Record<string, string>;
	metadata?: {
		description?: string;
		unit?: string;
		instrument?: string;
		temporality?: string;
		monotonic?: boolean;
	};
	exemplar?: {
		traceId?: string;
		spanId?: string;
		tenantId?: string;
		userId?: string;
	}}): number {

	// Quick estimate: use constant for performance
	// For more accurate estimates, calculate actual size
	// Match the snapshot guard's conservative retained-record accounting. The
	// fixed overhead covers numeric fields, property/index storage and record
	// structure; per-label overhead prevents many tiny fields bypassing limits.
	let size = 48 + byteSize(record.name)
	for (const [k, v] of Object.entries(record.labels)) {
		size += byteSize(k) + byteSize(v) + 8
	}
	if (record.metadata) {
		size += byteSize(record.metadata.description ?? '')
			+ byteSize(record.metadata.unit ?? '')
			+ byteSize(record.metadata.instrument ?? '')
			+ byteSize(record.metadata.temporality ?? '')
			+ 32
	}
	if (record.exemplar) {
		size += byteSize(record.exemplar.traceId ?? '')
			+ byteSize(record.exemplar.spanId ?? '')
			+ byteSize(record.exemplar.tenantId ?? '')
			+ byteSize(record.exemplar.userId ?? '')
			+ 32
	}
	return size
}

/**
 * Estimate size of a batch of metric records in bytes
 * @param batch - Array of metric records
 * @param useQuickEstimate - If true, use constant estimate per record. If false,
 * calculate actual size.
 * @returns Estimated total size in bytes
 */
export function estimateBatchBytes(batch: ReadonlyArray<{
	name: string;
	labels: Record<string, string>;
	metadata?: {
		description?: string;
		unit?: string;
		instrument?: string;
		temporality?: string;
		monotonic?: boolean;
	};
	exemplar?: {traceId?: string; spanId?: string; tenantId?: string; userId?: string}
}>): number {

	if (batch.length === 0) {
		return 0
	}

	// Sum up individual record sizes
	let total = 0
	for (const record of batch) {
		total += estimateMetricRecordSize(record)
	}
	return total
}
