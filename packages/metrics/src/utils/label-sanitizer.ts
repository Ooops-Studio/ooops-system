/**
 * @file Label sanitization and cardinality enforcement.
 * Normalizes label names/values and enforces limits to prevent cardinality explosion.
 */

import {METRIC_MAX_RAW_LABELS} from '../constants'
import type {MetricRecord} from '../types/metric-record'

export {
	createCardinalityTracker,
	type CardinalityDiagnosticsEntry,
	type CardinalityTracker,
	type CardinalityTrackerOptions
} from './cardinality-tracker'
import {createCardinalityTracker, type CardinalityDiagnosticsEntry, type CardinalityTracker} from './cardinality-tracker'
import {validateLabelLimits} from './config-validation'
import {isSecretLikeLabelKey, REDACTED_LABEL_VALUE, sanitizeLabelValue} from './label-value-sanitization'
import {sanitizeLabelName} from './metric-name-sanitization'

export {sanitizeLabelValue} from './label-value-sanitization'
export {sanitizeLabelName, sanitizeMetricName, validateMetricName, type MetricNameValidation} from './metric-name-sanitization'

function notifyObserver(callback: (() => void) | undefined): void {
	try {
		callback?.()
	} catch {
		// Label/cardinality diagnostics are observational only.
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
 * Result of enforcing label limits
 */
export interface EnforceLabelLimitsResult {
	readonly labels: Record<string, string>
	readonly dropped: number
	readonly reason: 'max_labels' | 'max_cardinality' | 'none'
}

function snapshotLabels(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Metric labels must be a plain object')
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('Metric labels must be a plain object')
	}
	const descriptors = Object.getOwnPropertyDescriptors(value)
	if (Object.keys(descriptors).length > METRIC_MAX_RAW_LABELS) {
		throw new TypeError(`Metric labels must contain at most ${METRIC_MAX_RAW_LABELS} fields`)
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError('Metric labels must contain only string data fields')
	}
	const entries: Array<readonly [string, string]> = []
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (key.length > 1_024) throw new TypeError('Metric label names must not exceed 1024 characters')
		if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
			throw new TypeError('Metric labels must contain only string data fields')
		}
		entries.push([key, descriptor.value])
	}
	return Object.fromEntries(entries)
}

function snapshotRecord(value: unknown): MetricRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Metric record must be a plain object')
	}
	const prototype = Object.getPrototypeOf(value)
	const descriptors = Object.getOwnPropertyDescriptors(value)
	if ((prototype !== Object.prototype && prototype !== null)
		|| Object.getOwnPropertySymbols(value).length > 0
		|| Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
		throw new TypeError('Metric record must expose stable data fields')
	}
	const record = Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
	) as unknown as MetricRecord
	if (typeof record.name !== 'string') throw new TypeError('Metric record must contain a string name')
	return record
}

/**
 * Enforce label limits by dropping or hashing excess labels
 * @param labels - Labels to enforce limits on
 * @param limits - Label limits configuration
 * @returns Result with sanitized labels and drop information
 */
export function enforceLabelLimits(
	labels: Record<string, string>,
	limits: LabelLimits
): EnforceLabelLimitsResult {
	validateLabelLimits(limits)
	const stableLabels = snapshotLabels(labels)
	const entries = Object.entries(stableLabels)
	const {maxLabels} = limits

	// If within limits, return as-is
	if (entries.length <= maxLabels) {
		return {
			labels: stableLabels,
			dropped: 0,
			reason: 'none'
		}
	}

	// Drop excess labels (keep first maxLabels)
	const kept = entries.slice(0, maxLabels)
	const dropped = entries.length - maxLabels

	return {
		labels: Object.fromEntries(kept),
		dropped,
		reason: 'max_labels'
	}
}

/**
 * Check and track cardinality for a metric
 * @param metricName - Metric name
 * @param labels - Labels to check
 * @param limits - Label limits
 * @param onCardinalityDrop - Callback when cardinality limit hit
 * @returns true if cardinality exceeded (should drop metric)
 * @deprecated This compatibility helper is stateless and only validates a single
 * label set. Prefer createCardinalityTracker({clock}) and pass the tracker
 * explicitly to normalizeLabels() so cardinality state and timing stay isolated
 * and deterministic.
 */
export function checkCardinality(
	metricName: string,
	labels: Record<string, string>,
	limits: LabelLimits,
	onCardinalityDrop?: (metricName: string, reason: string) => void
): boolean {
	return createCardinalityTracker().check(metricName, labels, limits, onCardinalityDrop)
}

/**
 * Normalize and sanitize all labels in a metric record
 * @param record - Metric record to normalize
 * @param limits - Label limits
 * @param onDrop - Callback to emit self-metrics when labels are dropped
 * @param onCardinalityDrop - Callback to emit self-metrics when cardinality is exceeded
 * @returns Normalized record with sanitized labels, or null if dropped due to cardinality
 */
export function normalizeLabels(
	record: MetricRecord,
	limits: LabelLimits,
	onDrop?: (reason: string, metricName: string) => void,
	onCardinalityDrop?: (metricName: string, reason: string) => void,
	cardinalityTracker: CardinalityTracker = createCardinalityTracker(),
	recordWeight = 1,
	measureBytes?: (labels: Record<string, string>) => number
): MetricRecord | null {
	const stableRecord = snapshotRecord(record)
	validateLabelLimits(limits)
	const maxLabelValueLength = limits.maxLabelValueLength ?? 200
	const sanitizedEntries: Array<readonly [string, string]> = []
	const sanitizedOrigins = new Map<string, string>()

	for (const [key, value] of Object.entries(snapshotLabels(stableRecord.labels))) {
		const sanitizedKey = sanitizeLabelName(key)
		const existingOrigin = sanitizedOrigins.get(sanitizedKey)
		if (existingOrigin !== undefined && existingOrigin !== key) {
			notifyObserver(() => onDrop?.('label_collision', stableRecord.name))
			return null
		}
		sanitizedOrigins.set(sanitizedKey, key)
		const sanitizedValue = isSecretLikeLabelKey(sanitizedKey)
			? REDACTED_LABEL_VALUE
			: sanitizeLabelValue(value, maxLabelValueLength)
		sanitizedEntries.push([sanitizedKey, sanitizedValue])
	}
	const sanitizedLabels = Object.fromEntries(sanitizedEntries)

	const {labels: finalLabels, dropped, reason} = enforceLabelLimits(sanitizedLabels, limits)

	if (dropped > 0 && onDrop) {
		// Emit self-metrics for dropped labels
		notifyObserver(() => onDrop(reason, stableRecord.name))
	}
	const cardinalityExceeded =
		cardinalityTracker.check(stableRecord.name, finalLabels, limits, onCardinalityDrop,
			recordWeight, measureBytes?.(finalLabels))
	if (cardinalityExceeded) {
		// Drop metric due to cardinality explosion
		return null
	}

	return {
		...stableRecord,
		labels: finalLabels
	}
}

/**
 * @deprecated Global cardinality diagnostics no longer keep module-level state.
 * Prefer per-handler/per-recorder tracker diagnostics.
 */
export function getCardinalityDiagnostics(limit = 10): ReadonlyArray<CardinalityDiagnosticsEntry> {
	void limit
	return []
}

/**
 * @deprecated Global cardinality diagnostics no longer keep module-level state.
 * Prefer owning a tracker from createCardinalityTracker({clock}).
 */
export function resetCardinalityDiagnostics(): void {
	// No-op: module-level cardinality state was removed.
}
