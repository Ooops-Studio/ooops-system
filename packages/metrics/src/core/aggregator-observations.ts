import type {MetricInstrumentDefinition} from '../types/instruments'
import type {Exemplar, MetricMetadata} from '../types/metric-record'
import {selectBucket} from '../utils/aggregation'

import type {
	HistogramState,
	MetricState,
	MetricStateBase
} from './aggregator-state'

type StateTransformer = <T extends MetricStateBase>(state: T) => T

function cloneExemplar(exemplar: Exemplar): Exemplar {
	return {...exemplar}
}

function addHistogramExemplar(
	state: HistogramState,
	bucketIndex: number,
	exemplar: Exemplar
): void {
	if (bucketIndex < state.buckets.length) {
		const bucket = state.buckets[bucketIndex]
		if (bucket !== undefined)
			state.bucketExemplars.set(bucket, cloneExemplar(exemplar))
		return
	}
	state.bucketExemplars.set(Number.POSITIVE_INFINITY, cloneExemplar(exemplar))
}

export interface HistogramObservationInput {
	readonly states: Map<string, MetricState>;
	readonly key: string;
	readonly name: string;
	readonly labels: Record<string, string>;
	readonly value: number;
	readonly now: number;
	readonly buckets: ReadonlyArray<number>;
	readonly metadata: MetricMetadata;
	readonly definition: MetricInstrumentDefinition;
	readonly exemplar?: Exemplar;
	readonly existing?: MetricState;
	readonly touchState: StateTransformer;
}

export function recordHistogramObservation(
	input: HistogramObservationInput
): void {
	const {
		states,
		key,
		name,
		labels,
		value,
		now,
		buckets,
		metadata,
		definition,
		exemplar,
		existing,
		touchState
	} = input
	if (existing?.type === 'histogram') {
		const nextSum = existing.sum + value
		if (!Number.isFinite(nextSum))
			throw new Error(`Metric histogram aggregate overflow for "${name}"`)
		const bucketIndex = selectBucket(value, existing.buckets)
		const target = Math.min(bucketIndex, existing.counts.length - 1)
		const counts = [...existing.counts]
		counts[target] = (counts[target] ?? 0) + 1
		const bucketExemplars = new Map(existing.bucketExemplars)
		const updated = {...existing, counts, bucketExemplars}
		if (exemplar) addHistogramExemplar(updated, bucketIndex, exemplar)
		states.set(
			key,
			touchState({
				...updated,
				sum: nextSum,
				count: existing.count + 1,
				metadata
			})
		)
		return
	}
	const counts = new Array(buckets.length + 1).fill(0)
	const bucketIndex = selectBucket(value, buckets)
	counts[Math.min(bucketIndex, counts.length - 1)] = 1
	const bucketExemplars = new Map<number, Exemplar>()
	const state: HistogramState = {
		type: 'histogram',
		buckets: [...buckets],
		counts,
		sum: value,
		count: 1,
		name,
		labels: {...labels},
		metadata,
		windowStartedAt: now,
		lastSeenAt: now,
		bucketExemplars,
		...(definition.staleAfterMs !== undefined
			? {staleAfterMs: definition.staleAfterMs}
			: {})
	}
	if (exemplar) addHistogramExemplar(state, bucketIndex, exemplar)
	states.set(key, touchState(state))
}
