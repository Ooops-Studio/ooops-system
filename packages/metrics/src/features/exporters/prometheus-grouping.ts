import type {MetricRecord} from '../../types/metric-record'
import {safeJsonStringify} from '../../utils/safe-json-stringify'

export interface HistogramBucketSample {
	readonly le: number;
	readonly record: MetricRecord;
}
export interface HistogramGroup {
	readonly baseName: string;
	readonly labels: Record<string, string>;
	metadata?: MetricRecord['metadata'];
	timestamp: number;
	buckets: HistogramBucketSample[];
	overflowBucket?: MetricRecord;
	sum?: MetricRecord;
	count?: MetricRecord;
}
export function isHistogramPart(record: MetricRecord): boolean {
	const instrument = record.metadata?.instrument
	return (
		(instrument === 'histogram' || instrument === 'timer') &&
		(record.name.endsWith('_bucket') ||
			record.name.endsWith('_sum') ||
			record.name.endsWith('_count'))
	)
}
export function histogramBaseName(record: MetricRecord): string {
	return record.name.endsWith('_bucket')
		? record.name.slice(0, -7)
		: record.name.endsWith('_sum')
			? record.name.slice(0, -4)
			: record.name.endsWith('_count')
				? record.name.slice(0, -6)
				: record.name
}
export function labelsWithoutBucket(
	labels: Record<string, string>
): Record<string, string> {
	const {le: _le, ...rest} = labels
	return rest
}
export function prometheusGroupKey(
	baseName: string,
	labels: Record<string, string>
): string {
	return safeJsonStringify([
		baseName,
		Object.entries(labels).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
	])
}

function mergeFamilyMetadata(
	baseName: string,
	existing: MetricRecord['metadata'] | undefined,
	incoming: MetricRecord['metadata'] | undefined
): MetricRecord['metadata'] | undefined {
	if (!existing) return incoming
	if (!incoming) return existing
	for (const field of ['instrument', 'temporality', 'description', 'unit'] as const) {
		if (existing[field] !== undefined && incoming[field] !== undefined
			&& existing[field] !== incoming[field]) {
			throw new Error(`Prometheus metric family "${baseName}" contains conflicting ${field} metadata`)
		}
	}
	const instrument = existing.instrument ?? incoming.instrument
	const temporality = existing.temporality ?? incoming.temporality
	const description = existing.description ?? incoming.description
	const unit = existing.unit ?? incoming.unit
	const monotonic = existing.monotonic ?? incoming.monotonic
	return {
		...(instrument !== undefined ? {instrument} : {}),
		...(temporality !== undefined ? {temporality} : {}),
		...(description !== undefined ? {description} : {}),
		...(unit !== undefined ? {unit} : {}),
		...(monotonic !== undefined ? {monotonic} : {})
	}
}

export function getHistogramGroup(
	groups: Map<string, HistogramGroup>,
	baseName: string,
	labels: Record<string, string>,
	record: MetricRecord
): HistogramGroup {
	const baseLabels = labelsWithoutBucket(labels)
	const key = prometheusGroupKey(baseName, baseLabels)
	const existing = groups.get(key)
	if (existing) {
		existing.timestamp = Math.max(existing.timestamp, record.timestamp)
		existing.metadata = mergeFamilyMetadata(baseName, existing.metadata, record.metadata)
		return existing
	}
	const group: HistogramGroup = {
		baseName,
		labels: baseLabels,
		timestamp: record.timestamp,
		buckets: [],
		...(record.metadata ? {metadata: record.metadata} : {})
	}
	groups.set(key, group)
	return group
}
export function assertCompleteHistogramGroup(group: HistogramGroup): void {
	if (!group.sum || !group.count)
		throw new Error(
			`Prometheus histogram family "${group.baseName}" requires both _sum and _count records`
		)
}
