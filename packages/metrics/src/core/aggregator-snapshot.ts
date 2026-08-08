import type {MetricMetadata, MetricRecord} from '../types/metric-record'

import {attachDeltaSnapshotToken, copyDeltaSnapshotToken, createDeltaSnapshotToken, progressFromToken, type DeltaCommitProgress} from './aggregator-delta-token'
import type {MetricState} from './aggregator-state'

function cloneRecord(record: MetricRecord): MetricRecord {
	return {
		...record,
		labels: {...record.labels},
		...(record.metadata ? {metadata: {...record.metadata}} : {}),
		...(record.exemplar ? {exemplar: {...record.exemplar}} : {})
	}
}

function histogramMetadata(
	metadata: MetricMetadata | undefined,
	temporality: 'cumulative' | 'delta',
	monotonic = false
): MetricMetadata {
	return {
		...(metadata ?? {instrument: 'histogram', temporality}),
		instrument: metadata?.instrument ?? 'histogram',
		...(monotonic ? {monotonic: true} : {})
	}
}

function pushHistogramRecords(
	records: MetricRecord[],
	state: Extract<MetricState, {type: 'histogram'}>,
	now: number,
	temporality: 'cumulative' | 'delta'
): void {
	records.push(
		{
			name: `${state.name}_sum`,
			type: 'gauge',
			value: state.sum,
			labels: state.labels,
			timestamp: now,
			startTimestamp: Math.min(state.windowStartedAt, now),
			metadata: histogramMetadata(state.metadata, temporality)
		},
		{
			name: `${state.name}_count`,
			type: 'counter',
			value: state.count,
			labels: state.labels,
			timestamp: now,
			startTimestamp: Math.min(state.windowStartedAt, now),
			metadata: histogramMetadata(state.metadata, temporality, true)
		}
	)
	for (let index = 0; index < state.buckets.length; index++) {
		const bucket = state.buckets[index]
		if (bucket === undefined) continue
		const exemplar = state.bucketExemplars.get(bucket)
		records.push({
			name: `${state.name}_bucket`,
			type: 'counter',
			value: state.counts[index] ?? 0,
			labels: {...state.labels, le: String(bucket)},
			timestamp: now,
			startTimestamp: Math.min(state.windowStartedAt, now),
			metadata: histogramMetadata(state.metadata, temporality, true),
			...(exemplar ? {exemplar} : {})
		})
	}
	const exemplar = state.bucketExemplars.get(Number.POSITIVE_INFINITY)
	records.push({
		name: `${state.name}_bucket`,
		type: 'counter',
		value: state.counts[state.counts.length - 1] ?? 0,
		labels: {...state.labels, le: '+Inf'},
		timestamp: now,
		startTimestamp: Math.min(state.windowStartedAt, now),
		metadata: histogramMetadata(state.metadata, temporality, true),
		...(exemplar ? {exemplar} : {})
	})
}

export function snapshotMetricStates(
	states: Map<string, MetricState>,
	now: number,
	temporality: 'cumulative' | 'delta',
	resetDelta: boolean,
	sequence: number,
	progress: Map<string, DeltaCommitProgress>
): ReadonlyArray<MetricRecord> {
	const records: MetricRecord[] = []
	for (const [key, state] of states) {
		const firstRecordIndex = records.length
		const deltaToken = createDeltaSnapshotToken(state, sequence, progress.get(key), now, resetDelta)
		if (deltaToken?.eagerlyReset) progress.set(key, progressFromToken(deltaToken))
		const attachStateToken = (): void => {
			for (let index = firstRecordIndex; index < records.length; index++)
				attachDeltaSnapshotToken(records[index] as MetricRecord, deltaToken)
		}
		if (state.type === 'counter' || state.type === 'gauge') {
			records.push({
				name: state.name,
				type: state.type,
				value: state.value,
				labels: state.labels,
				timestamp: now,
				...(state.type === 'counter'
					? {startTimestamp: Math.min(state.windowStartedAt, now)} : {}),
				...(state.metadata ? {metadata: state.metadata} : {}),
				...(state.exemplar ? {exemplar: state.exemplar} : {})
			})
			if (
				state.type === 'counter' &&
				resetDelta &&
				state.metadata?.temporality === 'delta'
			) {
				state.value = 0
				state.exemplar = undefined
				state.windowStartedAt = now
				states.set(key, state)
			}
			attachStateToken()
			continue
		}
		if (state.type === 'histogram') {
			pushHistogramRecords(records, state, now, temporality)
			if (resetDelta && state.metadata?.temporality === 'delta') {
				state.counts = new Array(state.buckets.length + 1).fill(0)
				state.sum = 0
				state.count = 0
				state.bucketExemplars = new Map()
				state.windowStartedAt = now
				states.set(key, state)
			}
			attachStateToken()
		}
	}
	return records.map((record) => {
		const cloned = cloneRecord(record)
		copyDeltaSnapshotToken(record, cloned)
		return cloned
	})
}
