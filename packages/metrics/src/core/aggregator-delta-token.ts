import type {MetricRecord} from '../types/metric-record'

import type {MetricState} from './aggregator-state'

export type DeltaSnapshotToken =
	| {type: 'counter'; name: string; labels: Record<string, string>; windowStartedAt: number; snapshotTimestamp: number; eagerlyReset: boolean; sequence: number; value: number; exemplar?: MetricRecord['exemplar']}
	| {type: 'histogram'; name: string; labels: Record<string, string>; windowStartedAt: number; snapshotTimestamp: number; eagerlyReset: boolean; sequence: number; counts: number[]; sum: number; count: number; bucketExemplars: Map<number, NonNullable<MetricRecord['exemplar']>>}

export type DeltaCommitProgress =
	| {type: 'counter'; windowStartedAt: number; sequence: number; value: number}
	| {type: 'histogram'; windowStartedAt: number; sequence: number; counts: number[]; sum: number; count: number}

const tokens = new WeakMap<MetricRecord, DeltaSnapshotToken>()

export function createDeltaSnapshotToken(
	state: MetricState,
	sequence: number,
	progress: DeltaCommitProgress | undefined,
	snapshotTimestamp: number,
	eagerlyReset = false
): DeltaSnapshotToken | undefined {
	if (state.metadata?.temporality !== 'delta' || state.type === 'gauge') return undefined
	const current = progress?.windowStartedAt === state.windowStartedAt && progress.type === state.type
		? progress
		: undefined
	const base = {
		name: state.name,
		labels: {...state.labels},
		windowStartedAt: state.windowStartedAt,
		snapshotTimestamp,
		eagerlyReset,
		sequence
	}
	if (state.type === 'counter')
		return {...base, type: 'counter', value: (current?.type === 'counter' ? current.value : 0) + state.value, ...(state.exemplar ? {exemplar: {...state.exemplar}} : {})}
	if (state.type === 'histogram')
		return {
			...base, type: 'histogram',
			counts: state.counts.map((count, index) => count + (current?.type === 'histogram' ? (current.counts[index] ?? 0) : 0)),
			sum: state.sum + (current?.type === 'histogram' ? current.sum : 0),
			count: state.count + (current?.type === 'histogram' ? current.count : 0),
			bucketExemplars: new Map([...state.bucketExemplars].map(([bucket, exemplar]) => [bucket, {...exemplar}]))
		}
	return undefined
}

export function progressFromToken(token: DeltaSnapshotToken): DeltaCommitProgress {
	if (token.type === 'counter') return {type: token.type, windowStartedAt: token.windowStartedAt, sequence: token.sequence, value: token.value}
	return {
		type: token.type, windowStartedAt: token.windowStartedAt, sequence: token.sequence,
		counts: [...token.counts], sum: token.sum, count: token.count
	}
}

export function attachDeltaSnapshotToken(record: MetricRecord, token: DeltaSnapshotToken | undefined): void {
	if (token) tokens.set(record, token)
}

export function copyDeltaSnapshotToken(source: MetricRecord, target: MetricRecord): void {
	attachDeltaSnapshotToken(target, tokens.get(source))
}

export function getDeltaSnapshotToken(record: MetricRecord): DeltaSnapshotToken | undefined {
	return tokens.get(record)
}
