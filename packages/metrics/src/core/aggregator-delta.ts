import type {MetricRecord} from '../types/metric-record'

import {getDeltaSnapshotToken, progressFromToken, type DeltaCommitProgress, type DeltaSnapshotToken} from './aggregator-delta-token'
import type {MetricState} from './aggregator-state'

const committedDeltaTokens = new WeakSet<object>()

function exemplarsEqual(left: MetricRecord['exemplar'], right: MetricRecord['exemplar']): boolean {
	return left === right || (!!left && !!right && left.traceId === right.traceId && left.spanId === right.spanId &&
		left.tenantId === right.tenantId && left.userId === right.userId && left.value === right.value &&
		left.timestamp === right.timestamp)
}

function commitToken(
	states: Map<string, MetricState>,
	progress: Map<string, DeltaCommitProgress>,
	token: DeltaSnapshotToken,
	key: string
): void {
	const state = states.get(key)
	const previous = progress.get(key)
	if (!state || state.type !== token.type
		|| (state.windowStartedAt !== token.windowStartedAt
			&& previous?.windowStartedAt !== token.windowStartedAt)) return
	if (previous?.windowStartedAt === token.windowStartedAt && previous.sequence >= token.sequence) return
	if (state.type === 'counter' && token.type === 'counter') {
		const committedValue = previous?.type === 'counter' && previous.windowStartedAt === token.windowStartedAt ? previous.value : 0
		state.value -= token.value - committedValue
		if (exemplarsEqual(state.exemplar, token.exemplar)) state.exemplar = undefined
		state.windowStartedAt = token.snapshotTimestamp
		states.set(key, state)
		progress.set(key, progressFromToken(token))
		return
	}
	if (state.type === 'histogram' && token.type === 'histogram') {
		const committed = previous?.type === 'histogram' && previous.windowStartedAt === token.windowStartedAt ? previous : undefined
		state.counts = state.counts.map((count, index) => Math.max(0, count - ((token.counts[index] ?? 0) - (committed?.counts[index] ?? 0))))
		state.sum = Math.max(0, state.sum - (token.sum - (committed?.sum ?? 0)))
		state.count = Math.max(0, state.count - (token.count - (committed?.count ?? 0)))
		for (const [bucket, exemplar] of token.bucketExemplars) {
			if (exemplarsEqual(state.bucketExemplars.get(bucket), exemplar)) state.bucketExemplars.delete(bucket)
		}
		state.windowStartedAt = token.snapshotTimestamp
		states.set(key, state)
		progress.set(key, progressFromToken(token))
		return
	}
}

export function commitDeltaSnapshot(
	states: Map<string, MetricState>,
	progress: Map<string, DeltaCommitProgress>,
	snapshot: ReadonlyArray<MetricRecord>,
	createKey: (name: string, labels: Record<string, string>) => string
): void {
	if (snapshot.length === 0) return
	const committedTokens = new Set<DeltaSnapshotToken>()
	for (const record of snapshot) {
		const token = getDeltaSnapshotToken(record)
		if (!token || token.eagerlyReset || committedTokens.has(token) || committedDeltaTokens.has(token)) continue
		committedTokens.add(token)
		commitToken(states, progress, token, createKey(token.name, token.labels))
		committedDeltaTokens.add(token)
	}
}
