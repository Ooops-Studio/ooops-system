/**
 * @file Configuration validation utilities.
 * Validates preset options to fail fast with human-readable errors.
 */

import {ConfigValidationError, snapshotDenseDataArray} from '@ooopsstudio/core/utils/validation'

import {CARDINALITY_TRACKER_MAX_SERIES, HISTOGRAM_MAX_BUCKETS, MAX_METRICS_TIMER_MS, METRIC_MAX_RAW_LABELS, METRIC_MAX_RAW_LABEL_VALUE_LENGTH, METRICS_MAX_RETRIES} from '../constants'

export {ConfigValidationError}

/**
 * Validate histogram buckets
 * Must be sorted in ascending order and all positive
 */
export function snapshotHistogramBuckets(buckets: ReadonlyArray<number>): ReadonlyArray<number> {
	if (!Array.isArray(buckets)) {
		throw new ConfigValidationError('Histogram buckets must be an array')
	}
	const stable = snapshotDenseDataArray(buckets, HISTOGRAM_MAX_BUCKETS)
	if (!stable) throw new ConfigValidationError(`Histogram buckets must be a dense array with at most ${HISTOGRAM_MAX_BUCKETS} entries`)

	for (let i = 0; i < stable.length; i++) {
		const bucket = stable[i]
		if (typeof bucket !== 'number') {
			throw new ConfigValidationError(
				`Histogram bucket at index ${i} must be a number`
			)
		}
		if (!Number.isFinite(bucket) || bucket <= 0) {
			throw new ConfigValidationError(
				`Histogram bucket at index ${i} must be positive, got ${bucket}`
			)
		}
		if (i > 0) {
			const prevBucket = stable[i - 1] as number
			if (bucket <= prevBucket) {
				throw new ConfigValidationError(
					`Histogram buckets must be sorted in ascending order. Bucket at index ${i} (${bucket}) must be greater than previous (${prevBucket})`
				)
			}
		}
	}
	return stable as number[]
}

export function validateHistogramBuckets(buckets: ReadonlyArray<number>): void {
	void snapshotHistogramBuckets(buckets)
}

/**
 * Validate positive interval (milliseconds)
 */
export function validateInterval(intervalMs: number, name: string): void {
	if (typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
		throw new ConfigValidationError(
			`${name} must be a positive safe integer, got ${intervalMs}ms`
		)
	}
	if (intervalMs > MAX_METRICS_TIMER_MS) {
		throw new ConfigValidationError(
			`${name} must not exceed ${MAX_METRICS_TIMER_MS}ms, got ${intervalMs}ms`
		)
	}
}

/**
 * Retry configuration
 */
export interface RetryConfig {
	readonly maxRetries: number
	readonly baseDelayMs: number
	readonly maxDelayMs: number
	readonly multiplier: number
	readonly jitter?: boolean
}

/**
 * Validate retry configuration
 */
export function validateRetryConfig(config: RetryConfig): void {
	if (!config || typeof config !== 'object') {
		throw new ConfigValidationError('Retry configuration must be an object')
	}

	if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > METRICS_MAX_RETRIES) {
		throw new ConfigValidationError(
			`Retry maxRetries must be an integer between 0 and ${METRICS_MAX_RETRIES}`
		)
	}

	validateInterval(config.baseDelayMs, 'Retry baseDelayMs')
	validateInterval(config.maxDelayMs, 'Retry maxDelayMs')

	if (config.baseDelayMs > config.maxDelayMs) {
		throw new ConfigValidationError(
			`Retry baseDelayMs (${config.baseDelayMs}ms) must be <= maxDelayMs (${config.maxDelayMs}ms)`
		)
	}

	if (!Number.isFinite(config.multiplier) || config.multiplier <= 0) {
		throw new ConfigValidationError(
			`Retry multiplier must be positive, got ${config.multiplier}`
		)
	}
	if (config.jitter !== undefined && typeof config.jitter !== 'boolean') {
		throw new ConfigValidationError('Retry jitter must be a boolean')
	}

}

/**
 * Label limits configuration
 */
export interface LabelLimits {
	readonly maxLabels: number
	readonly maxCardinality: number
	readonly maxLabelValueLength?: number
}

/**
 * Validate label limits
 */
export function validateLabelLimits(limits: LabelLimits): void {
	if (!limits || typeof limits !== 'object') {
		throw new ConfigValidationError('Label limits must be an object')
	}

	if (!Number.isInteger(limits.maxLabels) || limits.maxLabels <= 0 || limits.maxLabels > METRIC_MAX_RAW_LABELS) {
		throw new ConfigValidationError(
			`Label maxLabels must be between 1 and ${METRIC_MAX_RAW_LABELS}, got ${limits.maxLabels}`
		)
	}

	if (!Number.isInteger(limits.maxCardinality) || limits.maxCardinality <= 0
		|| limits.maxCardinality > CARDINALITY_TRACKER_MAX_SERIES) {
		throw new ConfigValidationError(
			`Label maxCardinality must be between 1 and ${CARDINALITY_TRACKER_MAX_SERIES}, got ${limits.maxCardinality}`
		)
	}

	if (limits.maxLabelValueLength !== undefined) {
		if (!Number.isInteger(limits.maxLabelValueLength) || limits.maxLabelValueLength <= 0
			|| limits.maxLabelValueLength > METRIC_MAX_RAW_LABEL_VALUE_LENGTH) {
			throw new ConfigValidationError(
				`Label maxLabelValueLength must be between 1 and ${METRIC_MAX_RAW_LABEL_VALUE_LENGTH}, got ${limits.maxLabelValueLength}`
			)
		}
	}
}

/**
 * Validate host for HTTP server
 * Warns if host is 0.0.0.0 (binds to all interfaces, security risk)
 */
export function validateHost(host: string, allowAllInterfaces = false): void {

	if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
		throw new ConfigValidationError(
			'Host must be a non-empty string no longer than 253 characters'
		)
	}

	if (host === '0.0.0.0' && !allowAllInterfaces) {
		throw new ConfigValidationError(
			'Host "0.0.0.0" binds to all interfaces and is not allowed for security. Use "127.0.0.1" for localhost-only access.'
		)
	}

	// Basic IP/hostname validation
	const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/
	const ipv6Pattern = /^\[?([0-9a-fA-F:]+)\]?$/
	const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

	const isValidIpv4 = ipv4Pattern.test(host)
		&& host.split('.').every((octet) => {
			const value = Number(octet)
			return Number.isInteger(value) && value >= 0 && value <= 255
		})
	if (ipv4Pattern.test(host) && !isValidIpv4) {
		throw new ConfigValidationError(
			`Host must be a valid IP address or hostname, got "${host}"`
		)
	}

	if (
		host !== 'localhost' &&
		host !== '127.0.0.1' &&
		!isValidIpv4 &&
		!ipv6Pattern.test(host) &&
		!hostnamePattern.test(host)
	) {
		throw new ConfigValidationError(
			`Host must be a valid IP address or hostname, got "${host}"`
		)
	}
}
