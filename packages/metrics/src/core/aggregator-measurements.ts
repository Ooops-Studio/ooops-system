import type {MetricInstrumentDefinition} from '../types/instruments'
import type {Exemplar, MetricMetadata} from '../types/metric-record'

import type {MetricState, MetricStateBase} from './aggregator-state'

type StateTransformer = <T extends MetricStateBase>(state: T) => T

function cloneExemplar(exemplar: Exemplar): Exemplar {
	return {...exemplar}
}

interface MeasurementInput {
	readonly states: Map<string, MetricState>;
	readonly key: string;
	readonly name: string;
	readonly labels: Record<string, string>;
	readonly value: number;
	readonly now: number;
	readonly metadata: MetricMetadata;
	readonly definition: MetricInstrumentDefinition;
	readonly exemplar?: Exemplar;
	readonly existing?: MetricState;
	readonly touchState: StateTransformer;
}

export function recordCounterMeasurement(input: MeasurementInput): void {
	const {
		states,
		key,
		name,
		labels,
		value,
		now,
		metadata,
		definition,
		exemplar,
		existing,
		touchState
	} = input
	if (existing?.type === 'counter') {
		const nextValue = existing.value + value
		if (!Number.isFinite(nextValue))
			throw new Error(`Metric counter aggregate overflow for "${name}"`)
		states.set(
			key,
			touchState({
				...existing,
				value: nextValue,
				metadata,
				...(exemplar ? {exemplar: cloneExemplar(exemplar)} : {})
			})
		)
		return
	}
	states.set(
		key,
		touchState({
			type: 'counter',
			value,
			name,
			labels: {...labels},
			metadata,
			windowStartedAt: now,
			lastSeenAt: now,
			...(definition.staleAfterMs !== undefined
				? {staleAfterMs: definition.staleAfterMs}
				: {}),
			...(exemplar ? {exemplar: cloneExemplar(exemplar)} : {})
		})
	)
}

export function recordGaugeMeasurement(input: MeasurementInput): void {
	const {
		states,
		key,
		name,
		labels,
		value,
		now,
		metadata,
		definition,
		exemplar,
		touchState
	} = input
	states.set(
		key,
		touchState({
			type: 'gauge',
			value,
			name,
			labels: {...labels},
			metadata,
			windowStartedAt: now,
			lastSeenAt: now,
			...(definition.staleAfterMs !== undefined
				? {staleAfterMs: definition.staleAfterMs}
				: {}),
			...(exemplar ? {exemplar: cloneExemplar(exemplar)} : {})
		})
	)
}
