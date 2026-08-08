import type {MetricRecord} from '../../types/metric-record'
import {sanitizeLabelName, sanitizeLabelValue} from '../../utils/label-sanitizer'
import {isSecretLikeLabelKey, REDACTED_LABEL_VALUE} from '../../utils/label-value-sanitization'
import {safeJsonStringify} from '../../utils/safe-json-stringify'

interface HistogramGroup {
	baseName: string
	labels: Record<string, string>
	timestamp: number
	startTimestamp?: number
	sum?: number
	count?: number
	buckets: Array<{le: number; count: number; exemplar?: MetricRecord['exemplar']}>
	overflowCount?: number
	overflowExemplar?: MetricRecord['exemplar']
	metadata?: MetricRecord['metadata']
}

const OTLP_NANOSECONDS_PER_MILLISECOND = BigInt(1_000_000)
const OTLP_UINT64_MAX = BigInt('18446744073709551615')

export function convertToOtlp(batch: ReadonlyArray<MetricRecord>): unknown {

	const toNanoTime = (value: number): string => {
		if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
			throw new Error(`OTLP metric timestamp must be finite, non-negative, and safe, got ${value}`)
		}
		const nanoseconds = BigInt(Math.trunc(value)) * OTLP_NANOSECONDS_PER_MILLISECOND
		if (nanoseconds > OTLP_UINT64_MAX) {
			throw new Error(`OTLP metric timestamp exceeds the unsigned 64-bit nanosecond range, got ${value}`)
		}
		return nanoseconds.toString()
	}
	const toJsonDouble = (value: number): number | 'NaN' | 'Infinity' | '-Infinity' => {
		if (Number.isNaN(value)) return 'NaN'
		if (value === Number.POSITIVE_INFINITY) return 'Infinity'
		if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
		return value
	}
	const toInt64String = (value: number): string | undefined => {
		return Number.isInteger(value) && Number.isSafeInteger(value) ? String(value) : undefined
	}
	const toUInt64String = (value: number): string => {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`OTLP metric count must be a non-negative safe integer, got ${value}`)
		}
		return String(value)
	}
	const toNumberDataPointValue = (value: number): {asInt: string} | {asDouble: number | 'NaN' | 'Infinity' | '-Infinity'} => {
		const asInt = toInt64String(value)
		return asInt === undefined ? {asDouble: toJsonDouble(value)} : {asInt}
	}
	const normalizeHexId = (value: string | undefined, expectedLength: number): string | undefined => {
		if (!value) {
			return undefined
		}
		const normalized = value.toLowerCase()
		return /^[\da-f]+$/u.test(normalized) && normalized.length === expectedLength
			? normalized
			: undefined
	}
	const toExemplar = (exemplar: MetricRecord['exemplar']): unknown => {
		if (!exemplar) {
			return undefined
		}
		const spanId = normalizeHexId(exemplar.spanId, 16)
		const traceId = normalizeHexId(exemplar.traceId, 32)
		return {
			timeUnixNano: toNanoTime(exemplar.timestamp),
			asDouble: toJsonDouble(exemplar.value),
			...(spanId ? {spanId} : {}),
			...(traceId ? {traceId} : {})
		}
	}
	const labelsWithoutBucket = (labels: Record<string, string>): Record<string, string> => {
		const {le: _le, ...rest} = labels
		return rest
	}
	const labelsKey = (labels: Record<string, string>): string => safeJsonStringify(
		Object.entries(labels).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
	)
	const mergeFamilyMetadata = (
		baseName: string,
		existing: MetricRecord['metadata'] | undefined,
		incoming: MetricRecord['metadata'] | undefined
	): MetricRecord['metadata'] | undefined => {
		if (!existing) return incoming
		if (!incoming) return existing
		for (const field of ['instrument', 'temporality', 'description', 'unit', 'monotonic'] as const) {
			if (existing[field] !== undefined && incoming[field] !== undefined
				&& existing[field] !== incoming[field]) {
				throw new Error(`OTLP metric family "${baseName}" contains conflicting ${field} metadata`)
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
	const histogramGroups = new Map<string, HistogramGroup>()
	const passthrough: MetricRecord[] = []
	const outputFamilies = new Map<string, {
		kind: 'sum' | 'gauge' | 'histogram'
		metadata: MetricRecord['metadata'] | undefined
	}>()
	const claimOutputFamily = (
		name: string,
		kind: 'sum' | 'gauge' | 'histogram',
		metadata: MetricRecord['metadata'] | undefined
	): MetricRecord['metadata'] | undefined => {
		const existing = outputFamilies.get(name)
		if (!existing) {
			outputFamilies.set(name, {kind, metadata})
			return metadata
		}
		if (existing.kind !== kind) {
			throw new Error(`OTLP metric "${name}" contains conflicting ${existing.kind} and ${kind} families`)
		}
		const merged = mergeFamilyMetadata(name, existing.metadata, metadata)
		existing.metadata = merged
		return merged
	}

	const getHistogramGroup = (
		baseName: string,
		labels: Record<string, string>,
		record: MetricRecord
	): HistogramGroup => {
		const baseLabels = labelsWithoutBucket(labels)
		const key = `${baseName}:${labelsKey(baseLabels)}`
		const existing = histogramGroups.get(key)
		if (existing) {
			if (existing.timestamp !== record.timestamp) {
				throw new Error(`OTLP histogram metric "${baseName}" contains inconsistent timestamps`)
			}
			if (existing.startTimestamp !== undefined && record.startTimestamp !== undefined
				&& existing.startTimestamp !== record.startTimestamp) {
				throw new Error(`OTLP histogram metric "${baseName}" contains inconsistent start timestamps`)
			}
			existing.startTimestamp ??= record.startTimestamp
			existing.metadata = mergeFamilyMetadata(baseName, existing.metadata, record.metadata)
			return existing
		}
		const created: HistogramGroup = {
			baseName,
			labels: baseLabels,
			timestamp: record.timestamp,
			...(record.startTimestamp !== undefined ? {startTimestamp: record.startTimestamp} : {}),
			buckets: [],
			...(record.metadata ? {metadata: record.metadata} : {})
		}
		histogramGroups.set(key, created)
		return created
	}
	for (const record of batch) {
		const isHistogramInstrument = record.metadata?.instrument === 'histogram' ||
				record.metadata?.instrument === 'timer'
		if (isHistogramInstrument && record.name.endsWith('_bucket')) {
			const group = getHistogramGroup(record.name.slice(0, -'_bucket'.length), record.labels, record)
			if (record.labels.le === '+Inf') {
				if (group.overflowCount !== undefined) {
					throw new Error(`OTLP histogram metric "${group.baseName}" contains duplicate bounds`)
				}
				group.overflowCount = record.value
				if (record.exemplar) {
					group.overflowExemplar = record.exemplar
				}
			} else {
				const rawBound = record.labels.le
				const upperBound = typeof rawBound === 'string' && rawBound.trim().length > 0
					? Number(rawBound) : Number.NaN
				if (!Number.isFinite(upperBound)) {
					throw new Error(`OTLP histogram metric "${group.baseName}" contains an invalid bound`)
				}
				group.buckets.push({
					le: upperBound,
					count: record.value,
					...(record.exemplar ? {exemplar: record.exemplar} : {})
				})
			}
			continue
		}
		if (isHistogramInstrument && record.name.endsWith('_sum')) {
			const group = getHistogramGroup(record.name.slice(0, -'_sum'.length), record.labels, record)
			if (group.sum !== undefined) throw new Error(`OTLP histogram metric "${group.baseName}" contains duplicate _sum records`)
			group.sum = record.value
			continue
		}
		if (isHistogramInstrument && record.name.endsWith('_count')) {
			const group = getHistogramGroup(record.name.slice(0, -'_count'.length), record.labels, record)
			if (group.count !== undefined) throw new Error(`OTLP histogram metric "${group.baseName}" contains duplicate _count records`)
			group.count = record.value
			continue
		}
		if (record.type === 'histogram') {
			throw new Error(
				`OTLP histogram metric "${record.name}" requires exploded _bucket, _sum and _count records`
			)
		}
		passthrough.push(record)
	}

	const metrics: unknown[] = []
	const sumGroups = new Map<string, {
		name: string
		metadata: MetricRecord['metadata'] | undefined
		dataPoints: unknown[]
		pointKeys: Set<string>
	}>()
	const gaugeGroups = new Map<string, {
		name: string
		metadata: MetricRecord['metadata'] | undefined
		dataPoints: unknown[]
		pointKeys: Set<string>
	}>()

	for (const record of passthrough) {
		const isCounter = record.type === 'counter'
		const isGauge = record.type === 'gauge'
		if (isCounter) {
			const isMonotonic = record.metadata?.monotonic
				?? record.metadata?.instrument !== 'up_down_counter'
			if (isMonotonic && (Number.isNaN(record.value) || record.value < 0)) {
				throw new Error(`OTLP monotonic sum metric "${record.name}" must be non-negative and non-NaN`)
			}
			const metadata = claimOutputFamily(record.name, 'sum', record.metadata)
			const existing = sumGroups.get(record.name)
			const exemplar = toExemplar(record.exemplar)
			const attributes = convertLabels(record.labels)
			const timeUnixNano = toNanoTime(record.timestamp)
			const startTimeUnixNano = record.startTimestamp === undefined
				? undefined : toNanoTime(record.startTimestamp)
			if (record.startTimestamp !== undefined && record.startTimestamp > record.timestamp) {
				throw new Error(`OTLP metric "${record.name}" start timestamp exceeds its timestamp`)
			}
			const pointKey = safeJsonStringify(attributes)
			const dataPoint = {
				attributes,
				...toNumberDataPointValue(record.value),
				timeUnixNano,
				...(startTimeUnixNano !== undefined ? {startTimeUnixNano} : {}),
				...(exemplar ? {exemplars: [exemplar]} : {})
			}
			if (existing) {
				if (existing.pointKeys.has(pointKey)) throw new Error(`OTLP metric "${record.name}" contains duplicate data points`)
				existing.pointKeys.add(pointKey)
				existing.metadata = metadata
				existing.dataPoints.push(dataPoint)
			} else {
				sumGroups.set(record.name, {
					name: record.name,
					metadata,
					dataPoints: [dataPoint],
					pointKeys: new Set([pointKey])
				})
			}
			continue
		}

		if (isGauge) {
			const metadata = claimOutputFamily(record.name, 'gauge', record.metadata)
			const existing = gaugeGroups.get(record.name)
			const exemplar = toExemplar(record.exemplar)
			const attributes = convertLabels(record.labels)
			const timeUnixNano = toNanoTime(record.timestamp)
			const pointKey = safeJsonStringify(attributes)
			const dataPoint = {
				attributes,
				asDouble: toJsonDouble(record.value),
				timeUnixNano,
				...(exemplar ? {exemplars: [exemplar]} : {})
			}
			if (existing) {
				if (existing.pointKeys.has(pointKey)) throw new Error(`OTLP metric "${record.name}" contains duplicate data points`)
				existing.pointKeys.add(pointKey)
				existing.metadata = metadata
				existing.dataPoints.push(dataPoint)
			} else {
				gaugeGroups.set(record.name, {
					name: record.name,
					metadata,
					dataPoints: [dataPoint],
					pointKeys: new Set([pointKey])
				})
			}
		}
	}

	for (const group of sumGroups.values()) {
		metrics.push({
			name: group.name,
			description: group.metadata?.description ?? '',
			unit: group.metadata?.unit ?? '',
			sum: {
				dataPoints: group.dataPoints,
				aggregationTemporality: group.metadata?.temporality === 'delta' ? 1 : 2,
				isMonotonic: group.metadata?.monotonic
					?? group.metadata?.instrument !== 'up_down_counter'
			}
		})
	}

	for (const group of gaugeGroups.values()) {
		metrics.push({
			name: group.name,
			description: group.metadata?.description ?? '',
			unit: group.metadata?.unit ?? '',
			gauge: {
				dataPoints: group.dataPoints
			}
		})
	}

	const histogramOutputs = new Map<string, {
		metadata: MetricRecord['metadata'] | undefined
		dataPoints: unknown[]
		pointKeys: Set<string>
	}>()
	for (const group of histogramGroups.values()) {
		if (group.sum === undefined || group.count === undefined) {
			throw new Error(
				`OTLP histogram metric "${group.baseName}" is missing required _sum and _count records`
			)
		}
		const sortedBuckets = [...group.buckets].sort((left, right) => left.le - right.le)
		for (let index = 0; index < sortedBuckets.length; index++) {
			const current = sortedBuckets[index]
			const previous = sortedBuckets[index - 1]
			if (!current || previous?.le === current.le) {
				throw new Error(`OTLP histogram metric "${group.baseName}" contains duplicate bounds`)
			}
			toUInt64String(current.count)
		}
		const bucketCounts = [
			...sortedBuckets.map((bucket) => bucket.count),
			group.overflowCount ?? Math.max((group.count ?? 0) - sortedBuckets.reduce((total, bucket) => total + bucket.count, 0), 0)
		]
		const declaredCount = toUInt64String(group.count)
		const observedCount = bucketCounts.reduce((total, count) => total + count, 0)
		if (observedCount !== group.count) {
			throw new Error(`OTLP histogram metric "${group.baseName}" bucket counts do not match its count`)
		}
		const encodedBucketCounts = bucketCounts.map(toUInt64String)
		const exemplars = [
			...sortedBuckets.map((bucket) => toExemplar(bucket.exemplar)).filter(Boolean),
			toExemplar(group.overflowExemplar)
		].filter(Boolean)
		const metadata = claimOutputFamily(group.baseName, 'histogram', group.metadata)
		const attributes = convertLabels(group.labels)
		const timeUnixNano = toNanoTime(group.timestamp)
		const startTimeUnixNano = group.startTimestamp === undefined
			? undefined : toNanoTime(group.startTimestamp)
		if (group.startTimestamp !== undefined && group.startTimestamp > group.timestamp) {
			throw new Error(`OTLP histogram metric "${group.baseName}" start timestamp exceeds its timestamp`)
		}
		const pointKey = safeJsonStringify(attributes)
		const dataPoint = {
			attributes,
			count: declaredCount,
			sum: toJsonDouble(group.sum ?? 0),
			bucketCounts: encodedBucketCounts,
			explicitBounds: sortedBuckets.map((bucket) => bucket.le),
			timeUnixNano,
			...(startTimeUnixNano !== undefined ? {startTimeUnixNano} : {}),
			exemplars: exemplars.length > 0 ? exemplars : undefined
		}
		const existing = histogramOutputs.get(group.baseName)
		if (existing) {
			if (existing.pointKeys.has(pointKey)) throw new Error(`OTLP metric "${group.baseName}" contains duplicate data points`)
			existing.pointKeys.add(pointKey)
			existing.metadata = metadata
			existing.dataPoints.push(dataPoint)
		} else {
			histogramOutputs.set(group.baseName, {metadata, dataPoints: [dataPoint], pointKeys: new Set([pointKey])})
		}
	}
	for (const [name, group] of histogramOutputs) metrics.push({
		name,
		description: group.metadata?.description ?? '',
		unit: group.metadata?.unit ?? '',
		histogram: {
			dataPoints: group.dataPoints,
			aggregationTemporality: group.metadata?.temporality === 'delta' ? 1 : 2
		}
	})

	return {
		resourceMetrics: [
			{
				scopeMetrics: [
					{
						metrics
					}
				]
			}
		]
	}
}
/**
	 * Convert labels to OTLP attributes
 */
function convertLabels(
	labels: Record<string, string>
): Array<{key: string; value: {stringValue: string}}> {
	const origins = new Map<string, string>()
	return Object.entries(labels).map(([key, value]) => {
		if (typeof value !== 'string') throw new Error('OTLP metric labels must contain string values')
		const sanitizedKey = sanitizeLabelName(key)
		const origin = origins.get(sanitizedKey)
		if (origin !== undefined && origin !== key) {
			throw new Error(`OTLP metric label collision for "${sanitizedKey}"`)
		}
		origins.set(sanitizedKey, key)
		return {
			key: sanitizedKey,
			value: {
				stringValue: isSecretLikeLabelKey(sanitizedKey)
					? REDACTED_LABEL_VALUE
					: sanitizeLabelValue(value)
			}
		}
	}).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
}
