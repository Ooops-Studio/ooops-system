/**
 * @file Cardinality guard for enforcing label dimension limits.
 * Prevents dimension explosion by tracking unique label combinations per metric.
 */

import {createHash} from 'node:crypto'

/**
 * Result of cardinality guard check
 */
export interface CardinalityCheckResult {

	/** Whether the event is allowed */
	allowed: boolean
	/** Rejection reason, or the bounded overflow reason in warn mode. */
	reason?: 'limit-exceeded' | 'invalid-labels'
}

/**
 * Cardinality guard for enforcing label limits
 */
export interface CardinalityGuard {

	/** Check if an event with given labels is allowed */
	check(metricName: string, labels?: Record<string, string>): CardinalityCheckResult

	/** Reset all tracked combinations */
	reset(): void
}

/**
 * Options for creating a cardinality guard
 */
export interface CardinalityGuardOptions {

	/** Maximum unique label combinations per metric (Infinity = disabled) */
	maxCombinations?: number

	/** Mode: 'drop' to reject events, 'warn' to allow but report */
	mode?: 'drop' | 'warn'

	/** Callback when limit is exceeded (used in warn mode) */
	onExceeded?: (metricName: string, reason: string) => void

	/** Maximum tracked metric names (default: 1000) */
	maxMetrics?: number

	/** Stale metric state TTL in milliseconds (default: 1 hour) */
	ttlMs?: number

	/** Clock used for deterministic cleanup in tests */
	now?: () => number
}

const digest = (value: string): string => createHash('sha256').update(value, 'utf16le').digest('base64url')

export function fingerprintLabels(labels?: Record<string, string>): string {

	if (!labels || Object.keys(labels).length === 0) return ''
	const hash = createHash('sha256')
	const entries = Object.entries(labels).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
	for (const [key, value] of entries) {
		hash.update(`${key.length}:${key}${value.length}:${value}`, 'utf16le')
	}
	return hash.digest('base64url')
}

/**
 * Create a cardinality guard.
 * Tracks unique label combinations per metric name to prevent dimension explosion.
 *
 * @param options - Guard options
 * @returns Cardinality guard instance
 */
export function createCardinalityGuard(options: CardinalityGuardOptions = {}): CardinalityGuard {

	const maxCombinations = options.maxCombinations ?? Number.POSITIVE_INFINITY
	const mode = options.mode ?? 'drop'
	const onExceeded = options.onExceeded
	const maxMetrics = options.maxMetrics ?? 1000
	const ttlMs = options.ttlMs ?? 60 * 60 * 1000
	const now = options.now ?? Date.now
	if (maxCombinations !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxCombinations) || maxCombinations < 0)) {
		throw new Error('Cardinality maxCombinations must be a non-negative integer or Infinity')
	}
	if (maxMetrics !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxMetrics) || maxMetrics <= 0)) {
		throw new Error('Cardinality maxMetrics must be a positive integer or Infinity')
	}
	if (!Number.isFinite(ttlMs) || ttlMs < 0) {
		throw new Error('Cardinality ttlMs must be a non-negative finite number')
	}
	if (mode !== 'drop' && mode !== 'warn') {
		throw new Error('Cardinality mode must be drop or warn')
	}
	const combinations = new Map<string, {labels: Set<string>; lastAccessed: number}>()
	const cleanupIntervalMs = ttlMs === 0 ? 0 : Math.min(ttlMs, 60_000)
	let nextCleanupAt = Number.NEGATIVE_INFINITY
	function cleanup(currentTime: number): void {
		// A full map scan on every measurement makes instrumentation cost grow with
		// the number of metric names. TTL cleanup is amortized while preserving the
		// configured expiry bound (at most one minute for the default one-hour TTL).
		if (cleanupIntervalMs > 0 && currentTime < nextCleanupAt) return
		for (const [metricName, entry] of combinations.entries()) {
			if (currentTime - entry.lastAccessed > ttlMs) {
				combinations.delete(metricName)
			}
		}
		nextCleanupAt = currentTime + cleanupIntervalMs
	}

	return {
		check(metricName: string, labels?: Record<string, string>): CardinalityCheckResult {

			// If disabled (Infinity), always allow
			if (!Number.isFinite(maxCombinations)) {
				return {allowed: true}
			}

			let key: string
			try {
				// Validate labels (must be string values)
				if (labels) {
					for (const [, value] of Object.entries(labels)) {
						if (typeof value !== 'string') {
							return {allowed: false, reason: 'invalid-labels'}
						}
					}
				}
				key = fingerprintLabels(labels)
			} catch {
				return {allowed: false, reason: 'invalid-labels'}
			}
			const currentTime = now()
			cleanup(currentTime)
			const metricKey = digest(metricName)
			let metricCombinations = combinations.get(metricKey)

			if (!metricCombinations) {
				if (Number.isFinite(maxMetrics) && combinations.size >= maxMetrics) {
					if (mode === 'warn') {
						try { onExceeded?.(metricName, 'limit-exceeded') } catch { /* observer */ }
						return {allowed: true, reason: 'limit-exceeded'}
					}
					return {allowed: false, reason: 'limit-exceeded'}
				}
				metricCombinations = {labels: new Set<string>(), lastAccessed: currentTime}
				combinations.set(metricKey, metricCombinations)
			}
			metricCombinations.lastAccessed = currentTime
			combinations.delete(metricKey)
			combinations.set(metricKey, metricCombinations)

			// Check if this combination already exists
			if (metricCombinations.labels.has(key)) {
				return {allowed: true}
			}

			// Check if we've exceeded the limit
			if (metricCombinations.labels.size >= maxCombinations) {
				if (mode === 'warn') {
					// Warn mode: report but allow
					if (onExceeded) {
						try {
							onExceeded(metricName, 'limit-exceeded')
						} catch {
							// Warning observers must not change cardinality enforcement.
						}
					}
					return {allowed: true, reason: 'limit-exceeded'}
				}
				// Drop mode: reject
				return {allowed: false, reason: 'limit-exceeded'}
			}

			// Add the new combination
			metricCombinations.labels.add(key)
			return {allowed: true}
		},
		reset(): void {

			combinations.clear()
			nextCleanupAt = Number.NEGATIVE_INFINITY
		}
	}
}
