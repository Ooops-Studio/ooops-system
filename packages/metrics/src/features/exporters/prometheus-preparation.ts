import type {MetricRecord} from '../../types/metric-record'

import {
	addPrometheusFamily,
	type FamilyIndexMaps,
	type PrometheusFamily
} from './prometheus-sample-utils'

interface HistogramBucketSample {
	readonly le: number;
	readonly record: MetricRecord;
}
interface HistogramGroup {
	readonly baseName: string;
	readonly labels: Record<string, string>;
	metadata?: MetricRecord['metadata'];
	timestamp: number;
	buckets: HistogramBucketSample[];
	overflowBucket?: MetricRecord;
	sum?: MetricRecord;
	count?: MetricRecord;
}
export interface PreparedPrometheusMetrics {
	readonly records: ReadonlyArray<MetricRecord>;
	readonly families: ReadonlyArray<PrometheusFamily>;
}
export interface PreparationHelpers {
	isHistogramPart(record: MetricRecord): boolean;
	histogramBaseName(record: MetricRecord): string;
	getHistogramGroup(
		groups: Map<string, HistogramGroup>,
		baseName: string,
		labels: Record<string, string>,
		record: MetricRecord,
	): HistogramGroup;
	assertCompleteHistogramGroup(group: HistogramGroup): void;
	createFamilyIndexes(): FamilyIndexMaps;
}

function assertCount(value: number, description: string): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`${description} must be a non-negative safe integer`)
}

function assertFinite(value: number, description: string): void {
	if (!Number.isFinite(value)) throw new Error(`${description} must be finite`)
}

export function preparePrometheusMetrics(
	batch: ReadonlyArray<MetricRecord>,
	helpers: PreparationHelpers
): PreparedPrometheusMetrics {
	const passthrough: MetricRecord[] = []
	const histogramGroups = new Map<string, HistogramGroup>()
	const indexes = helpers.createFamilyIndexes()

	for (const record of batch) {
		if (helpers.isHistogramPart(record)) {
			const baseName = helpers.histogramBaseName(record)
			const group = helpers.getHistogramGroup(
				histogramGroups,
				baseName,
				record.labels,
				record
			)
			if (record.name.endsWith('_bucket')) {
				if (record.labels.le === '+Inf') {
					group.overflowBucket = record
					continue
				}
				const le = Number(record.labels.le)
				if (!Number.isFinite(le))
					throw new Error(`Prometheus histogram family "${baseName}" contains an invalid bound`)
				if (le < 0)
					throw new Error(`Prometheus histogram family "${baseName}" cannot combine negative bounds with a sum`)
				group.buckets.push({le, record})
				continue
			}
			if (record.name.endsWith('_sum')) {
				group.sum = record
				continue
			}
			if (record.name.endsWith('_count')) {
				group.count = record
			}
			continue
		}
		if (record.type === 'histogram') {
			throw new Error(
				`Prometheus histogram family "${record.name}" requires _bucket, _sum and _count records`
			)
		}

		const familyType = record.metadata?.instrument === 'up_down_counter'
			? 'gauge'
			: record.type
		if (familyType === 'counter' && (Number.isNaN(record.value) || record.value < 0)) {
			throw new Error(`Prometheus counter metric "${record.name}" must be non-negative and non-NaN`)
		}
		passthrough.push(record)
	}

	const records: MetricRecord[] = [...passthrough]
	for (const group of histogramGroups.values()) {
		helpers.assertCompleteHistogramGroup(group)
		assertFinite(group.sum!.value, `Prometheus histogram family "${group.baseName}" sum`)
		assertCount(group.count!.value, `Prometheus histogram family "${group.baseName}" count`)
		if (group.overflowBucket)
			assertCount(group.overflowBucket.value, `Prometheus histogram family "${group.baseName}" +Inf bucket`)
		const bounds = new Set<number>()
		let explicitCount = group.overflowBucket?.value ?? 0
		for (const bucket of group.buckets) {
			assertCount(bucket.record.value, `Prometheus histogram family "${group.baseName}" bucket`)
			if (bucket.record.exemplar
				&& (!Number.isFinite(bucket.record.exemplar.value)
					|| bucket.record.exemplar.value > bucket.le)) {
				throw new Error(`Prometheus histogram family "${group.baseName}" exemplar exceeds its bucket bound`)
			}
			if (bounds.has(bucket.le))
				throw new Error(`Prometheus histogram family "${group.baseName}" contains a duplicate bound`)
			bounds.add(bucket.le)
			explicitCount += bucket.record.value
			if (!Number.isSafeInteger(explicitCount))
				throw new Error(`Prometheus histogram family "${group.baseName}" bucket total exceeds the safe integer range`)
		}
		if (group.overflowBucket && explicitCount !== group.count!.value)
			throw new Error(`Prometheus histogram family "${group.baseName}" bucket total does not match its count`)
		if (!group.overflowBucket && explicitCount > group.count!.value)
			throw new Error(`Prometheus histogram family "${group.baseName}" bucket total exceeds its count`)
		const sortedBuckets = [...group.buckets].sort(
			(left, right) => left.le - right.le
		)
		let cumulative = 0
		for (const bucket of sortedBuckets) {
			cumulative += bucket.record.value
			records.push({
				...bucket.record,
				value: cumulative
			})
		}
		const count =
			group.count?.value ?? cumulative + (group.overflowBucket?.value ?? 0)
		records.push({
			...(group.overflowBucket ?? {
				name: `${group.baseName}_bucket`,
				type: 'counter' as const,
				labels: {...group.labels, le: '+Inf'},
				timestamp: group.timestamp,
				...(group.metadata ? {metadata: group.metadata} : {})
			}),
			value: count
		})
		if (group.sum) {
			records.push(group.sum)
		}
		if (group.count) {
			records.push(group.count)
		}
	}
	const familyMap = new Map<string, PrometheusFamily>()
	for (const record of passthrough) {
		const familyType = record.metadata?.instrument === 'up_down_counter'
			? 'gauge'
			: record.type
		const familyName = familyType === 'counter' && record.name.endsWith('_total')
			? record.name.slice(0, -'_total'.length)
			: record.name
		addPrometheusFamily(
			familyMap,
			familyName,
			familyType,
			record.metadata,
			indexes
		)
	}
	for (const group of histogramGroups.values()) {
		addPrometheusFamily(
			familyMap,
			group.baseName,
			'histogram',
			group.metadata,
			indexes
		)
	}
	return {
		records,
		families: [...familyMap.values()]
	}
}
