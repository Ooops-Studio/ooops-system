import {validateHistogramBuckets} from '../utils/config-validation'
import {sanitizeLabelName} from '../utils/label-sanitizer'

import type {MetricInstrumentDefinition, MetricInstrumentKind} from './types'

const FIELDS = new Set([
	'name', 'instrument', 'description', 'unit', 'temporality', 'labels', 'histogramBuckets'
])
const INSTRUMENTS = new Set<MetricInstrumentKind>([
	'counter', 'up_down_counter', 'gauge', 'histogram', 'timer'
])

function dataFields(value: unknown, label: string, allowed: ReadonlySet<string>): Record<string, unknown> {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null
			|| Object.getOwnPropertySymbols(value).length > 0) throw new Error()
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (key.length > 128 || !allowed.has(key)
				|| !descriptor.enumerable || !('value' in descriptor)) throw new Error()
			result[key] = descriptor.value
		}
		return result
	} catch {
		throw new Error(`${label} must contain only stable known data fields`)
	}
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
	let descriptors: PropertyDescriptorMap
	try {
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error()
	} catch { throw new Error(`${label} must expose stable entries`) }
	const length = descriptors.length && 'value' in descriptors.length ? descriptors.length.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
		throw new Error(`${label} must contain at most ${maximum} entries`)
	}
	for (const key of Object.keys(descriptors)) {
		if (key !== 'length' && (key.length > 16
			|| !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length)) {
			throw new Error(`${label} must expose only stable entries`)
		}
	}
	const result: unknown[] = []
	for (let index = 0; index < length; index += 1) {
		const descriptor = descriptors[String(index)]
		if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
			throw new Error(`${label} must be a dense stable array`)
		}
		result.push(descriptor.value)
	}
	return result
}

export function snapshotInstrumentDefinitions(value: unknown): readonly MetricInstrumentDefinition[] {
	if (value === undefined) return Object.freeze([])
	const input = denseArray(value, 'Metrics instruments', 1_000)
	const seen = new Set<string>()
	const definitions = input.map((item) => {
		const fields = dataFields(item, 'Metric instrument definition', FIELDS)
		if (typeof fields.name !== 'string' || fields.name.length === 0 || fields.name.length > 1_024) {
			throw new Error('Metric instrument definition name must be a bounded non-empty string')
		}
		if (seen.has(fields.name)) throw new Error(`Metric instrument "${fields.name}" is defined more than once`)
		seen.add(fields.name)
		if (typeof fields.instrument !== 'string' || !INSTRUMENTS.has(fields.instrument as MetricInstrumentKind)) {
			throw new Error('Metric instrument definition kind is invalid')
		}
		if (fields.description !== undefined && typeof fields.description !== 'string') {
			throw new Error('Metric instrument description must be a string')
		}
		if (fields.unit !== undefined && typeof fields.unit !== 'string') {
			throw new Error('Metric instrument unit must be a string')
		}
		if (fields.temporality !== undefined
			&& fields.temporality !== 'cumulative' && fields.temporality !== 'delta') {
			throw new Error('Metric instrument temporality is invalid')
		}
		const labels = fields.labels === undefined ? undefined
			: denseArray(fields.labels, 'Metric instrument labels', 64).map((label) => {
				if (typeof label !== 'string' || label.length === 0 || label.length > 128) {
					throw new Error('Metric instrument labels must contain bounded non-empty strings')
				}
				return sanitizeLabelName(label)
			})
		if (labels && new Set(labels).size !== labels.length) {
			throw new Error('Metric instrument labels must be unique after sanitization')
		}
		const buckets = fields.histogramBuckets === undefined ? undefined
			: denseArray(fields.histogramBuckets, 'Metric histogram buckets', 256).map((bucket) => {
				if (typeof bucket !== 'number') throw new Error('Metric histogram buckets must be numbers')
				return bucket
			})
		if (buckets) {
			if (fields.instrument !== 'histogram' && fields.instrument !== 'timer') {
				throw new Error('Metric histogram buckets require a histogram or timer')
			}
			validateHistogramBuckets(buckets)
		}
		return Object.freeze({
			name: fields.name,
			instrument: fields.instrument as MetricInstrumentKind,
			...(fields.description !== undefined ? {description: fields.description as string} : {}),
			...(fields.unit !== undefined ? {unit: fields.unit as string} : {}),
			...(fields.temporality !== undefined ? {temporality: fields.temporality as 'cumulative' | 'delta'} : {}),
			...(labels ? {labels: Object.freeze(labels)} : {}),
			...(buckets ? {histogramBuckets: Object.freeze(buckets)} : {})
		})
	})
	return Object.freeze(definitions)
}
