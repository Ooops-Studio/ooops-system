import {snapshotDenseDataArray} from '@ooopsstudio/core/utils/validation'

import {
	METRIC_MAX_RAW_LABELS,
	METRIC_MAX_RAW_LABEL_VALUE_LENGTH,
	METRICS_MAX_EXPORT_RECORDS,
	METRICS_MAX_EXPORT_SNAPSHOT_BYTES
} from '../constants'
import type {MetricRecord} from '../types/metric-record'

import {estimateMetricRecordSize} from './helpers'

const RECORD_FIELDS = new Set(['name', 'type', 'value', 'labels', 'timestamp', 'startTimestamp', 'metadata', 'exemplar'])
const METADATA_FIELDS = new Set(['description', 'unit', 'instrument', 'temporality', 'monotonic'])
const EXEMPLAR_FIELDS = new Set(['traceId', 'spanId', 'tenantId', 'userId', 'value', 'timestamp'])
const METRIC_TYPES = new Set(['counter', 'gauge', 'histogram'])
const INSTRUMENT_TYPES = new Set([
	'counter', 'up_down_counter', 'gauge', 'histogram', 'timer'
])

function snapshotObject(
	value: unknown,
	allowedFields: ReadonlySet<string> | undefined,
	label: string
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must expose stable data fields`)
	const prototype = Object.getPrototypeOf(value)
	const descriptors = Object.getOwnPropertyDescriptors(value)
	if ((prototype !== Object.prototype && prototype !== null)
		|| Object.getOwnPropertySymbols(value).length > 0
		|| Object.entries(descriptors).some(([key, descriptor]) =>
			key.length > 1_024 || (allowedFields !== undefined && !allowedFields.has(key))
			|| !descriptor.enumerable || !('value' in descriptor))) {
		throw new TypeError(`${label} must expose stable data fields`)
	}
	return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}

export function snapshotMetricRecord(value: unknown): MetricRecord {
	const record = snapshotObject(value, RECORD_FIELDS, 'Metric record')
	if (typeof record.name !== 'string' || record.name.length === 0 || record.name.length > 1_024
		|| typeof record.type !== 'string' || !METRIC_TYPES.has(record.type)
		|| typeof record.value !== 'number'
		|| typeof record.timestamp !== 'number'
		|| (record.startTimestamp !== undefined && typeof record.startTimestamp !== 'number')) {
		throw new TypeError('Metric record contains invalid core fields')
	}
	const labelValues = snapshotObject(record.labels, undefined, 'Metric labels')
	if (Object.keys(labelValues).length > METRIC_MAX_RAW_LABELS
		|| Object.entries(labelValues).some(([key, item]) => key.length > 1_024 || typeof item !== 'string'
			|| item.length > METRIC_MAX_RAW_LABEL_VALUE_LENGTH)) {
		throw new TypeError('Metric labels must contain bounded string data fields')
	}
	const metadata = record.metadata === undefined
		? undefined
		: snapshotObject(record.metadata, METADATA_FIELDS, 'Metric metadata')
	if (metadata && (
		(metadata.description !== undefined && (typeof metadata.description !== 'string' || metadata.description.length > 1_024))
		|| (metadata.unit !== undefined && (typeof metadata.unit !== 'string' || metadata.unit.length > 128))
		|| (metadata.instrument !== undefined && !INSTRUMENT_TYPES.has(metadata.instrument as string))
		|| (metadata.temporality !== undefined && metadata.temporality !== 'delta' && metadata.temporality !== 'cumulative')
		|| (metadata.monotonic !== undefined && typeof metadata.monotonic !== 'boolean')
	)) throw new TypeError('Metric metadata contains invalid fields')
	const exemplar = record.exemplar === undefined
		? undefined
		: snapshotObject(record.exemplar, EXEMPLAR_FIELDS, 'Metric exemplar')
	if (exemplar && (
		['traceId', 'spanId', 'tenantId', 'userId'].some((key) => exemplar[key] !== undefined
			&& (typeof exemplar[key] !== 'string' || (exemplar[key] as string).length > 256))
		|| typeof exemplar.value !== 'number'
		|| typeof exemplar.timestamp !== 'number'
	)) throw new TypeError('Metric exemplar contains invalid fields')
	return Object.freeze({
		name: record.name,
		type: record.type as MetricRecord['type'],
		value: record.value,
		labels: Object.freeze(labelValues as Record<string, string>),
		timestamp: record.timestamp,
		...(record.startTimestamp !== undefined ? {startTimestamp: record.startTimestamp} : {}),
		...(metadata ? {metadata: Object.freeze(metadata) as MetricRecord['metadata']} : {}),
		...(exemplar ? {exemplar: Object.freeze(exemplar) as unknown as MetricRecord['exemplar']} : {})
	})
}

export function snapshotMetricBatch(value: unknown): ReadonlyArray<MetricRecord> {
	const items = snapshotDenseDataArray(value, METRICS_MAX_EXPORT_RECORDS)
	if (!items) throw new TypeError('Metric batch must be a bounded dense array')
	const records: MetricRecord[] = []
	let bytes = 0
	for (const item of items) {
		const record = snapshotMetricRecord(item)
		bytes += estimateMetricRecordSize(record)
		if (bytes > METRICS_MAX_EXPORT_SNAPSHOT_BYTES) {
			throw new TypeError(`Metric batch exceeds the ${METRICS_MAX_EXPORT_SNAPSHOT_BYTES}-byte snapshot limit`)
		}
		records.push(record)
	}
	return Object.freeze(records)
}
