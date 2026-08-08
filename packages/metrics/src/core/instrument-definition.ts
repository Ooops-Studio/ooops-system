import {METRIC_MAX_RAW_LABELS, METRIC_MAX_RAW_LABEL_VALUE_LENGTH} from '../constants'
import type {MetricInstrumentDefinition} from '../types/instruments'
import {safeJsonStringify} from '../utils/safe-json-stringify'

const INSTRUMENTS = new Set([
	'counter', 'up_down_counter', 'gauge', 'histogram', 'timer'
])
const FIELDS = new Set([
	'name', 'instrument', 'description', 'unit', 'temporality', 'labels',
	'histogramBuckets', 'staleAfterMs'
])

function snapshotDataObject(
	value: unknown,
	label: string,
	allowedFields?: ReadonlySet<string>
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	try {
		prototype = Object.getPrototypeOf(value)
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbols')
	} catch { throw new Error(`${label} must expose stable data fields`) }
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`)
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (key.length > 1_024) {
			throw new Error(allowedFields
				? `${label} contains unsupported fields`
				: `${label} names must not exceed 1024 characters`)
		}
		if (!descriptor.enumerable || !('value' in descriptor)
			|| (allowedFields && !allowedFields.has(key)) || key === 'toJSON') {
			throw new Error(`${label} contains unsupported fields`)
		}
	}
	return Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
	)
}

function snapshotNumberArray(value: unknown, label: string): number[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
	let descriptors: PropertyDescriptorMap
	try {
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbols')
	} catch {
		throw new Error(`${label} must expose stable data fields`)
	}
	const lengthDescriptor = descriptors.length
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) {
		throw new Error(`${label} must contain at most 10000 entries`)
	}
	const snapshot: number[] = []
	for (const key of Object.keys(descriptors)) {
		if (key === 'length') continue
		if (key.length > 16 || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
			throw new Error(`${label} contains unsupported fields`)
		}
	}
	for (let index = 0; index < length; index += 1) {
		const descriptor = descriptors[String(index)]
		if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
			|| typeof descriptor.value !== 'number') {
			throw new Error(`${label} must contain stable numeric entries`)
		}
		snapshot.push(descriptor.value)
	}
	return snapshot
}

export function snapshotMetricLabels(value: unknown, label: string): Record<string, string> | undefined {
	if (value === undefined) return undefined
	const stable = snapshotDataObject(value, label)
	if (Object.keys(stable).length > METRIC_MAX_RAW_LABELS) {
		throw new Error(`${label} must contain at most ${METRIC_MAX_RAW_LABELS} fields`)
	}
	const entries: Array<readonly [string, string]> = []
	for (const [key, item] of Object.entries(stable)) {
		if (key.length > 1_024) throw new Error(`${label} names must not exceed 1024 characters`)
		if (typeof item !== 'string' || item.length > METRIC_MAX_RAW_LABEL_VALUE_LENGTH) {
			throw new Error(`${label} values must be strings no longer than ${METRIC_MAX_RAW_LABEL_VALUE_LENGTH} characters`)
		}
		entries.push([key, item])
	}
	return Object.fromEntries(entries)
}

export function snapshotMetricDefinition<T extends MetricInstrumentDefinition>(
	value: T,
	name: string | undefined,
	defaultTemporality: 'cumulative' | 'delta'
): T {
	const stable = snapshotDataObject(value, 'Metric definition', FIELDS)
	if (typeof stable.name !== 'string') throw new Error('Metric definition name must be a string')
	const resolvedName = name ?? stable.name
	if (typeof stable.instrument !== 'string' || !INSTRUMENTS.has(stable.instrument)) throw new Error('Metric definition instrument is invalid')
	if (stable.description !== undefined
		&& (typeof stable.description !== 'string' || stable.description.length > 1_024)) {
		throw new Error('Metric definition description must be a string no longer than 1024 characters')
	}
	if (stable.unit !== undefined
		&& (typeof stable.unit !== 'string' || stable.unit.length > 128)) {
		throw new Error('Metric definition unit must be a string no longer than 128 characters')
	}
	if (stable.temporality !== undefined
		&& stable.temporality !== 'cumulative' && stable.temporality !== 'delta') {
		throw new Error('Metric definition temporality is invalid')
	}
	const histogramBuckets = stable.histogramBuckets === undefined
		? undefined : snapshotNumberArray(stable.histogramBuckets, 'Metric definition histogramBuckets')
	const labels = snapshotMetricLabels(stable.labels, 'Metric definition labels')
	return {
		...stable,
		name: resolvedName,
		...(stable.instrument === 'timer' ? {unit: 'ms'} : {}),
		...(labels ? {labels} : {}),
		...(histogramBuckets ? {histogramBuckets} : {}),
		temporality: stable.temporality ?? defaultTemporality
	} as T
}

export function metricDefinitionsEqual(
	left: MetricInstrumentDefinition,
	right: MetricInstrumentDefinition
): boolean {
	const canonical = (definition: MetricInstrumentDefinition): string => safeJsonStringify({
		name: definition.name,
		instrument: definition.instrument,
		description: definition.description,
		unit: definition.unit,
		temporality: definition.temporality,
		labels: definition.labels ? Object.entries(definition.labels).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : undefined,
		histogramBuckets: definition.histogramBuckets ? [...definition.histogramBuckets] : undefined,
		staleAfterMs: definition.staleAfterMs
	})
	return canonical(left) === canonical(right)
}
