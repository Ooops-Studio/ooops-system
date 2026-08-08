import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {
	CARDINALITY_TRACKER_MAX_KEYS,
	CARDINALITY_TRACKER_MAX_SERIES,
	METRIC_MAX_RAW_LABELS,
	METRIC_MAX_RAW_LABEL_VALUE_LENGTH,
	METRICS_MAX_EXPORT_SNAPSHOT_BYTES
} from '../constants'

import {readMetricsClock, snapshotMetricsClock, validateMetricsTimestamp} from './clock'
import {validateLabelLimits} from './config-validation'
import {createMetricKey} from './helpers'

export interface LabelLimits {
	readonly maxLabels: number;
	readonly maxCardinality: number;
	readonly maxLabelValueLength?: number;
}

export interface CardinalityDiagnosticsEntry {
	readonly metricName: string;
	readonly combinations: number;
	readonly dropped: number;
}

export interface CardinalityTracker {
	check(
		metricName: string,
		labels: Record<string, string>,
		limits: LabelLimits,
		onDrop?: (metricName: string, reason: string) => void,
		recordWeight?: number,
		byteWeight?: number,
	): boolean;
	release(metricName: string, labels: Record<string, string>): boolean;
	getDiagnostics(limit?: number): ReadonlyArray<CardinalityDiagnosticsEntry>;
	reset(): void;
}

export interface CardinalityTrackerOptions {
	readonly clock?: Clock;
	readonly now?: () => number;
	readonly maxSeries?: number;
}
interface Entry {
	readonly metricName: string;
	readonly labelCombinations: Map<string, number>;
	lastAccessed: number;
	dropped: number;
}
const notify = (callback: (() => void) | undefined): void => {
	try {
		callback?.()
	} catch {
		/* observer */
	}
}

function snapshotTrackerOptions(value: CardinalityTrackerOptions): CardinalityTrackerOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Metrics cardinality options must be an object')
	}
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	let symbols: symbol[]
	try {
		prototype = Object.getPrototypeOf(value)
		descriptors = Object.getOwnPropertyDescriptors(value)
		symbols = Object.getOwnPropertySymbols(value)
	} catch {
		throw new Error('Metrics cardinality options must expose stable known data fields')
	}
	if ((prototype !== Object.prototype && prototype !== null) || symbols.length > 0
		|| Object.entries(descriptors).some(([key, descriptor]) =>
			!['clock', 'now', 'maxSeries'].includes(key) || !descriptor.enumerable || !('value' in descriptor))) {
		throw new Error('Metrics cardinality options must expose stable known data fields')
	}
	return Object.freeze(Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
	)) as CardinalityTrackerOptions
}

const nowFor = (options: CardinalityTrackerOptions): (() => number) => {
	if (options.now !== undefined) {
		if (typeof options.now !== 'function') throw new Error('Metrics cardinality now must be a function')
		const suppliedNow = options.now
		return () => validateMetricsTimestamp(suppliedNow(), 'Metrics cardinality clock')
	}
	const clock = snapshotMetricsClock(options.clock ?? createSystemClock(), 'Metrics cardinality clock')
	return () => readMetricsClock(clock, 'Metrics cardinality clock')
}

function validateCheckInput(
	metricName: string,
	labels: Record<string, string>,
	limits: LabelLimits,
	onDrop?: (metricName: string, reason: string) => void
): Record<string, string> {
	if (typeof metricName !== 'string' || metricName.length === 0 || metricName.length > 1_024) {
		throw new Error('Metrics cardinality metricName must be a bounded string')
	}
	if (!labels || typeof labels !== 'object' || Array.isArray(labels)
		|| (Object.getPrototypeOf(labels) !== Object.prototype && Object.getPrototypeOf(labels) !== null)) {
		throw new Error('Metrics cardinality labels must contain string values')
	}
	const descriptors = Object.getOwnPropertyDescriptors(labels)
	if (Object.keys(descriptors).length > METRIC_MAX_RAW_LABELS) {
		throw new Error(`Metrics cardinality labels must contain at most ${METRIC_MAX_RAW_LABELS} fields`)
	}
	if (Object.getOwnPropertySymbols(labels).length > 0
		|| Object.entries(descriptors).some(([key, descriptor]) => key.length > 1_024
			|| !descriptor.enumerable || !('value' in descriptor)
			|| typeof descriptor.value !== 'string'
			|| descriptor.value.length > METRIC_MAX_RAW_LABEL_VALUE_LENGTH)) {
		throw new Error('Metrics cardinality labels must contain string values')
	}
	validateLabelLimits(limits)
	if (onDrop !== undefined && typeof onDrop !== 'function') {
		throw new Error('Metrics cardinality onDrop must be a function')
	}
	return Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, (descriptor as PropertyDescriptor & {value: string}).value])
	)
}

export function createCardinalityTracker(
	options: CardinalityTrackerOptions = {}
): CardinalityTracker {
	const stableOptions = snapshotTrackerOptions(options)
	const entries = new Map<string, Entry>()
	const now = nowFor(stableOptions)
	const maxSeries = stableOptions.maxSeries ?? CARDINALITY_TRACKER_MAX_SERIES
	if (!Number.isSafeInteger(maxSeries) || maxSeries <= 0 || maxSeries > CARDINALITY_TRACKER_MAX_SERIES) {
		throw new Error(`Metrics cardinality maxSeries must be between 1 and ${CARDINALITY_TRACKER_MAX_SERIES}`)
	}
	let totalCombinations = 0
	let totalByteWeight = 0
	return {
		check(metricName, labels, limits, onDrop, recordWeight = 1, byteWeight = recordWeight * 672) {
			if (!Number.isSafeInteger(recordWeight) || recordWeight <= 0
				|| !Number.isSafeInteger(byteWeight) || byteWeight <= 0) {
				throw new Error('Metrics cardinality weight is invalid')
			}
			const stableLabels = validateCheckInput(metricName, labels, limits, onDrop)
			let entry = entries.get(metricName)
			const timestamp = now()
			const key = createMetricKey(metricName, stableLabels)
			if (!entry && entries.size >= CARDINALITY_TRACKER_MAX_KEYS) {
				notify(() => onDrop?.(metricName, 'max_metric_names'))
				return true
			}
			if (entry?.labelCombinations.has(key)) return false
			const globalReason = totalByteWeight + byteWeight > METRICS_MAX_EXPORT_SNAPSHOT_BYTES
				? 'max_snapshot_bytes'
				: totalCombinations >= maxSeries ? 'max_global_cardinality' : undefined
			if (globalReason) {
				if (entry) entry.dropped++
				notify(() => onDrop?.(metricName, globalReason))
				return true
			}
			if (!entry) {
				entry = {metricName, labelCombinations: new Map(), lastAccessed: timestamp, dropped: 0}
				entries.set(metricName, entry)
			} else entry.lastAccessed = timestamp
			if (entry.labelCombinations.size >= limits.maxCardinality) {
				entry.dropped++
				notify(() => onDrop?.(metricName, 'max_cardinality'))
				return true
			}
			entry.labelCombinations.set(key, byteWeight)
			totalCombinations++
			totalByteWeight += byteWeight
			return false
		},
		release(metricName, labels) {
			const entry = entries.get(metricName)
			if (!entry) return false
			const key = createMetricKey(metricName, validateCheckInput(metricName, labels, {
				maxLabels: METRIC_MAX_RAW_LABELS,
				maxCardinality: CARDINALITY_TRACKER_MAX_SERIES,
				maxLabelValueLength: 4096
			}))
			const weight = entry.labelCombinations.get(key)
			if (weight === undefined) return false
			entry.labelCombinations.delete(key)
			totalCombinations = Math.max(0, totalCombinations - 1)
			totalByteWeight = Math.max(0, totalByteWeight - weight)
			if (entry.labelCombinations.size === 0) entries.delete(metricName)
			return true
		},
		getDiagnostics: (limit = 10) => {
			if (!Number.isSafeInteger(limit) || limit < 0 || limit > CARDINALITY_TRACKER_MAX_KEYS) {
				throw new Error('Metrics cardinality diagnostics limit is invalid')
			}
			return [...entries.values()]
				.map(({metricName, labelCombinations, dropped}) => ({
					metricName,
					combinations: labelCombinations.size,
					dropped
				}))
				.sort((a, b) => b.combinations - a.combinations)
				.slice(0, limit)
		},
		reset: () => {
			entries.clear()
			totalCombinations = 0
			totalByteWeight = 0
		}
	}
}
