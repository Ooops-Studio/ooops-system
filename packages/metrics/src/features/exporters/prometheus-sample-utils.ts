import type {MetricRecord} from '../../types/metric-record'
import {
	sanitizeLabelName,
	sanitizeLabelValue,
	sanitizeMetricName
} from '../../utils/label-sanitizer'
import {
	isSecretLikeLabelKey,
	REDACTED_LABEL_VALUE
} from '../../utils/label-value-sanitization'
import {safeJsonStringify} from '../../utils/safe-json-stringify'

import {isHistogramPart} from './prometheus-grouping'

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

export interface PrometheusFamily {
	readonly name: string;
	readonly type: string;
	readonly metadata?: MetricRecord['metadata'];
}
export interface FamilyIndexMaps {
	readonly familyTypes: Map<string, string>;
	readonly reservedChildSeries: Map<string, string>;
}

export function isPrometheusExemplarSample(record: MetricRecord): boolean {
	if (!record.exemplar || record.type !== 'counter'
		|| record.metadata?.instrument === 'up_down_counter') return false
	return record.metadata?.instrument !== 'histogram'
		&& record.metadata?.instrument !== 'timer'
		|| record.name.endsWith('_bucket')
}

export function sanitizePrometheusRecord(
	record: MetricRecord,
	metricOrigins: Map<string, string>
): MetricRecord {
	const normalizedName = sanitizeMetricName(record.name)
	// OpenMetrics reserves leading underscores for names defined by the
	// standard. Move caller-controlled names out of that namespace.
	const sanitizedName = normalizedName.startsWith('_')
		? `exported${normalizedName}`
		: normalizedName
	const isMonotonicCounter = record.type === 'counter'
		&& record.metadata?.instrument !== 'up_down_counter'
		&& record.metadata?.instrument !== 'histogram'
		&& record.metadata?.instrument !== 'timer'
	const name = isMonotonicCounter && !sanitizedName.endsWith('_total')
		? `${sanitizedName}_total`
		: sanitizedName
	const origin = metricOrigins.get(name)
	if (origin !== undefined && origin !== record.name)
		throw new Error(
			`Prometheus metric collision: "${origin}" and "${record.name}" both sanitize to "${name}"`
		)
	metricOrigins.set(name, record.name)
	if (isPrometheusExemplarSample(record)) {
		const exemplar = record.exemplar
		let exemplarLabelLength = 0
		if (exemplar?.traceId) {
			exemplarLabelLength += 'trace_id'.length + Array.from(exemplar.traceId).length
		}
		if (exemplar?.spanId) {
			exemplarLabelLength += 'span_id'.length + Array.from(exemplar.spanId).length
		}
		if (exemplarLabelLength > 128) {
			throw new Error(`Prometheus exemplar labels for metric "${record.name}" exceed 128 characters`)
		}
	}
	const origins = new Map<string, string>()
	const labelEntries: Array<readonly [string, string]> = []
	for (const [key, value] of Object.entries(record.labels)) {
		const normalized = sanitizeLabelName(key)
		// OpenMetrics reserves all leading-underscore label names. Keep caller
		// data, but move it out of that namespace (including __name__).
		const sanitized = normalized.startsWith('_') ? `exported${normalized}` : normalized
		const previous = origins.get(sanitized)
		if (previous !== undefined && previous !== key)
			throw new Error(
				`Prometheus label collision for metric "${record.name}": "${previous}" and "${key}" both sanitize to "${sanitized}"`
			)
		origins.set(sanitized, key)
		labelEntries.push([
			sanitized,
			isSecretLikeLabelKey(sanitized)
				? REDACTED_LABEL_VALUE
				: key === 'le' && isHistogramPart(record) ? value
					: sanitizeLabelValue(value)
		])
	}
	return {
		...record,
		name,
		labels: Object.fromEntries(labelEntries),
		...(record.metadata ? {metadata: {...record.metadata}} : {}),
		...(record.exemplar ? {exemplar: {...record.exemplar}} : {})
	}
}

export function childSeriesNames(name: string, type: string): string[] {
	return type === 'histogram'
		? [`${name}_bucket`, `${name}_sum`, `${name}_count`, `${name}_created`]
		: type === 'counter'
			? [`${name}_total`, `${name}_created`]
			: []
}

export function addPrometheusFamily(
	families: Map<string, PrometheusFamily>,
	name: string,
	type: string,
	metadata: MetricRecord['metadata'] | undefined,
	indexes: FamilyIndexMaps
): void {
	const reservedBy = indexes.reservedChildSeries.get(name)
	if (reservedBy !== undefined)
		throw new Error(
			`Prometheus metric family "${name}" is reserved as child series for "${reservedBy}"`
		)
	const existingType = indexes.familyTypes.get(name)
	if (existingType !== undefined && existingType !== type)
		throw new Error(
			`Prometheus metric family "${name}" is already exported as ${existingType}; cannot export it as ${type}`
		)
	indexes.familyTypes.set(name, type)
	for (const child of childSeriesNames(name, type)) {
		const familyType = indexes.familyTypes.get(child)
		const owner = indexes.reservedChildSeries.get(child)
		if (familyType !== undefined)
			throw new Error(
				`Prometheus metric family "${child}" is already exported as ${familyType}; cannot reserve it as child series for "${name}"`
			)
		if (owner !== undefined && owner !== name)
			throw new Error(
				`Prometheus metric family "${child}" is already reserved as child series for "${owner}"; cannot reserve it for "${name}"`
			)
		indexes.reservedChildSeries.set(child, name)
	}
	const existing = families.get(name)
	if (existing) {
		if (existing.type !== type)
			throw new Error(
				`Prometheus metric family "${name}" has conflicting types ${existing.type} and ${type}`
			)
		let merged = existing.metadata
		if (merged && metadata) {
			for (const field of ['instrument', 'temporality', 'monotonic', 'description', 'unit'] as const) {
				if (merged[field] !== undefined && metadata[field] !== undefined
					&& merged[field] !== metadata[field]) {
					throw new Error(`Prometheus metric family "${name}" contains conflicting ${field} metadata`)
				}
			}
			const instrument = merged.instrument ?? metadata.instrument
			const temporality = merged.temporality ?? metadata.temporality
			const monotonic = merged.monotonic ?? metadata.monotonic
			const description = merged.description ?? metadata.description
			const unit = merged.unit ?? metadata.unit
			merged = {
				...(instrument !== undefined ? {instrument} : {}),
				...(temporality !== undefined ? {temporality} : {}),
				...(monotonic !== undefined ? {monotonic} : {}),
				...(description !== undefined ? {description} : {}),
				...(unit !== undefined ? {unit} : {})
			}
		} else merged = merged ?? metadata
		if (merged !== existing.metadata) families.set(name, {name, type, metadata: merged})
		return
	}
	families.set(name, {name, type, ...(metadata ? {metadata} : {})})
}

export function prometheusSampleKey(record: MetricRecord): string {
	return safeJsonStringify([
		record.name,
		Object.entries(record.labels).sort(([left], [right]) =>
			compareStrings(left, right)
		)
	])
}
export function assertPrometheusBatchIdentities(
	batch: ReadonlyArray<MetricRecord>
): void {
	const seen = new Map<string, string>()
	for (const record of batch) {
		const key = prometheusSampleKey(record)
		const signature = safeJsonStringify([
			record.type,
			record.metadata?.instrument ?? '',
			record.metadata?.temporality ?? '',
			record.metadata?.monotonic ?? '',
			record.metadata?.description ?? '',
			record.metadata?.unit ?? ''
		])
		const previous = seen.get(key)
		if (previous !== undefined) {
			if (previous !== signature) throw new Error(
				`Prometheus metric sample "${record.name}" has conflicting types for the same label set`
			)
			throw new Error(`Prometheus metric sample "${record.name}" contains duplicate data points`)
		}
		seen.set(key, signature)
	}
}
