/**
 * @file Metric aggregator implementation.
 * Maintains in-memory state per metric key and aggregates counters,
 * gauges, and histograms with registration, TTL, and temporality.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import {HISTOGRAM_BUCKETS_DEFAULT} from '../constants'
import type {MetricInstrumentDefinition} from '../types/instruments'
import type {Exemplar, MetricMetadata, MetricRecord} from '../types/metric-record'
import {readMetricsClock, snapshotMetricsClock} from '../utils/clock'
import {
	snapshotHistogramBuckets,
	validateHistogramBuckets,
	validateInterval
} from '../utils/config-validation'
import {createMetricKey} from '../utils/helpers'
import {createMetricsOnError} from '../utils/on-error'

import {commitDeltaSnapshot as commitDeltaSnapshotState} from './aggregator-delta'
import type {DeltaCommitProgress} from './aggregator-delta-token'
import {evictStaleSeries} from './aggregator-eviction'
import {recordCounterMeasurement, recordGaugeMeasurement} from './aggregator-measurements'
import {recordHistogramObservation} from './aggregator-observations'
import {snapshotMetricStates} from './aggregator-snapshot'
import type {MetricState, MetricStateBase} from './aggregator-state'
import {metricDefinitionsEqual, snapshotMetricDefinition, snapshotMetricLabels} from './instrument-definition'

const COUNTER_INSTRUMENTS = new Set<MetricInstrumentDefinition['instrument']>(['counter', 'up_down_counter'])
const GAUGE_INSTRUMENTS = new Set<MetricInstrumentDefinition['instrument']>(['gauge'])
const HISTOGRAM_INSTRUMENTS = new Set<MetricInstrumentDefinition['instrument']>(['histogram', 'timer'])
// timer() accepts milliseconds; the conventional histogram defaults are seconds.
const TIMER_BUCKETS = HISTOGRAM_BUCKETS_DEFAULT.map((bucket) => bucket * 1_000)

export interface MetricAggregatorSnapshotOptions {
	readonly resetDelta?: boolean
	readonly evictStale?: boolean
}

export interface MetricAggregatorOptions {
	readonly clock: Clock
	readonly histogramBuckets?: ReadonlyArray<number>
	readonly defaultTemporality?: 'cumulative' | 'delta'
	readonly staleAfterMs?: number
	readonly onStaleEvict?: (name: string, labels: Record<string, string>) => void
	readonly errors?: Errors
}

export interface MetricAggregatorDiagnostics {
	readonly registeredMetrics: number
	readonly activeSeries: number
}

export class MetricAggregator {

	private readonly states = new Map<string, MetricState>()
	private readonly definitions = new Map<string, MetricInstrumentDefinition>()
	private readonly deltaCommitProgress = new Map<string, DeltaCommitProgress>()
	private deltaSnapshotSequence = 0
	private readonly clock: Clock
	private readonly histogramBuckets: ReadonlyArray<number>
	private readonly defaultTemporality: 'cumulative' | 'delta'
	private readonly defaultStaleAfterMs: number | undefined
	private readonly onStaleEvict: ((name: string, labels: Record<string, string>) => void) | undefined
	private readonly onError: (err: unknown, extra?: Record<string, string>) => void

	constructor(options: MetricAggregatorOptions) {
		if (!options || typeof options !== 'object') throw new Error('Aggregator options must be an object')
		const {
			clock,
			histogramBuckets = HISTOGRAM_BUCKETS_DEFAULT,
			defaultTemporality = 'cumulative',
			staleAfterMs,
			onStaleEvict,
			errors
		} = options
		const stableClock = snapshotMetricsClock(clock, 'Metric aggregator clock')
		const stableHistogramBuckets = snapshotHistogramBuckets(histogramBuckets)
		const defaultTemporalityValue: unknown = defaultTemporality
		if (defaultTemporalityValue !== 'cumulative' && defaultTemporalityValue !== 'delta') {
			throw new Error(`defaultTemporality must be cumulative or delta; got ${typeof defaultTemporalityValue === 'string' ? defaultTemporalityValue.slice(0, 64) : typeof defaultTemporalityValue}`)
		}
		if (staleAfterMs !== undefined) {
			validateInterval(staleAfterMs, 'Metric aggregator staleAfterMs')
		}
		this.onError = createMetricsOnError(errors, {stage: 'aggregator'})
		this.clock = stableClock
		this.histogramBuckets = stableHistogramBuckets
		this.defaultTemporality = defaultTemporality
		this.defaultStaleAfterMs = staleAfterMs
		if (onStaleEvict !== undefined && typeof onStaleEvict !== 'function') {
			throw new Error('Metric aggregator onStaleEvict must be a function')
		}
		this.onStaleEvict = onStaleEvict
	}

	private now(): number {
		return readMetricsClock(this.clock, 'Metric aggregator clock')
	}

	private createKey(name: string, labels: Record<string, string>): string {
		return createMetricKey(name, labels)
	}

	private assertMetricName(name: unknown): asserts name is string {
		if (typeof name !== 'string' || name.length === 0 || name.length > 1_024) {
			throw new Error('Metric name must be a bounded non-empty string')
		}
	}

	private normalizeDefinition(name: string, definition: MetricInstrumentDefinition): MetricInstrumentDefinition {
		const snapshot = snapshotMetricDefinition(definition, name, this.defaultTemporality)
		if (definition.name !== name) {
			throw new Error(`Metric definition name "${definition.name}" does not match "${name}"`)
		}
		if (snapshot.histogramBuckets !== undefined) {
			validateHistogramBuckets(snapshot.histogramBuckets)
		}
		if (snapshot.staleAfterMs !== undefined) {
			validateInterval(snapshot.staleAfterMs, `Metric "${name}" staleAfterMs`)
		}
		return snapshot
	}

	private assertDefinitionCompatible(name: string, requested: MetricInstrumentDefinition): void {
		const existing = this.definitions.get(name)
		if (!existing || metricDefinitionsEqual(existing, requested)) {
			return
		}
		const error = new Error(
			existing.instrument !== requested.instrument
				? `Metric "${name}" is already registered as ${existing.instrument}; cannot use it as ${requested.instrument}`
				: `Metric "${name}" is already registered with a different ${existing.instrument} definition`
		)
		this.onError(error, {
			metricName: name,
			existingInstrument: existing.instrument,
			requestedInstrument: requested.instrument,
			operation: 'register'
		})
		throw error
	}

	private claimDefinition(name: string, requested: MetricInstrumentDefinition): MetricInstrumentDefinition {
		const normalized = this.normalizeDefinition(name, requested)
		this.assertDefinitionCompatible(name, normalized)
		this.definitions.set(name, normalized)
		return normalized
	}

	private assertDefinitionInstrument(
		name: string,
		definition: MetricInstrumentDefinition,
		operation: string,
		accepted: ReadonlySet<MetricInstrumentDefinition['instrument']>
	): void {
		if (accepted.has(definition.instrument)) return
		const error = new Error(
			`Metric "${name}" is already registered as ${definition.instrument}; cannot use it for ${operation}`
		)
		this.onError(error, {
			metricName: name,
			existingInstrument: definition.instrument,
			operation
		})
		throw error
	}

	private claimDefinitionFor(
		name: string,
		requested: MetricInstrumentDefinition,
		operation: string,
		accepted: ReadonlySet<MetricInstrumentDefinition['instrument']>
	): MetricInstrumentDefinition {
		const normalized = this.normalizeDefinition(name, requested)
		this.assertDefinitionInstrument(name, normalized, operation, accepted)
		this.assertDefinitionCompatible(name, normalized)
		this.definitions.set(name, normalized)
		return normalized
	}

	private assertStateCompatible(
		name: string,
		existing: MetricState | undefined,
		requested: MetricState['type']
	): void {
		if (!existing || existing.type === requested) {
			return
		}
		const error = new Error(
			`Metric "${name}" label set is ${existing.type}; cannot record ${requested}`
		)
		this.onError(error, {
			metricName: name,
			existingType: existing.type,
			requestedType: requested,
			operation: 'record'
		})
		throw error
	}

	private resolveDefinition(
		name: string,
		fallbackInstrument: MetricInstrumentDefinition['instrument'],
		operation: string,
		accepted: ReadonlySet<MetricInstrumentDefinition['instrument']>
	): MetricInstrumentDefinition {

		const registered = this.definitions.get(name)
		if (registered) {
			this.assertDefinitionInstrument(name, registered, operation, accepted)
			return registered
		}

		return this.claimDefinition(name, {
			name,
			instrument: fallbackInstrument,
			temporality: this.defaultTemporality,
			...(this.defaultStaleAfterMs !== undefined ? {staleAfterMs: this.defaultStaleAfterMs} : {})
		})
	}

	private buildMetadata(definition: MetricInstrumentDefinition, monotonic?: boolean): MetricMetadata {
		return {
			...(definition.description ? {description: definition.description} : {}),
			...(definition.unit ? {unit: definition.unit} : {}),
			instrument: definition.instrument,
			temporality: definition.temporality ?? this.defaultTemporality,
			...(monotonic !== undefined ? {monotonic} : {})
		}
	}

	private assertFiniteValue(name: string, value: number, operation: string): void {
		const numericValue: unknown = value
		if (typeof numericValue === 'number' && Number.isFinite(numericValue)) {
			return
		}
		const error = new Error(`Metric ${operation} must be finite`)
		this.onError(new Error('metrics_invalid_measurement'), {metricName: 'user_metric', operation, value: 'non_finite'})
		throw error
	}

	private assertFiniteNonNegativeObservation(name: string, value: number, operation: 'histogram'): void {
		this.assertFiniteValue(name, value, operation)
		if (value >= 0) {
			return
		}
		const error = new Error(`Metric ${operation} observation must be non-negative`)
		this.onError(new Error('metrics_invalid_measurement'), {metricName: 'user_metric', operation, value: 'negative'})
		throw error
	}

	register(definition: MetricInstrumentDefinition): void {
		const snapshot = snapshotMetricDefinition(definition, undefined, this.defaultTemporality)
		this.claimDefinition(snapshot.name, snapshot)
	}

	private touchState<T extends MetricStateBase>(
		state: T,
		now: number,
		definition: MetricInstrumentDefinition
	): T {
		return {
			...state,
			lastSeenAt: now,
			staleAfterMs: definition.staleAfterMs ?? this.defaultStaleAfterMs
		}
	}

	increment(
		name: string,
		labels: Record<string, string>,
		count: number,
		exemplar?: Exemplar,
		definition?: MetricInstrumentDefinition
	): void {

		this.assertMetricName(name)
		this.assertFiniteValue(name, count, 'counter increment')
		const stableLabels = snapshotMetricLabels(labels, 'Metric aggregator labels') ?? {}
		const normalized = definition ? this.normalizeDefinition(name, definition) : undefined
		if (normalized) this.assertDefinitionInstrument(name, normalized, 'counter increment', COUNTER_INSTRUMENTS)
		const requestedInstrument = normalized?.instrument ?? this.definitions.get(name)?.instrument ?? 'counter'
		if (count < 0 && requestedInstrument !== 'up_down_counter') {
			const error = new Error('Metric counter increment must be non-negative')
			this.onError(new Error('metrics_invalid_measurement'), {metricName: 'user_metric', operation: 'counter increment', value: 'negative'})
			throw error
		}
		const resolved = normalized
			? this.claimDefinitionFor(name, normalized, 'counter increment', COUNTER_INSTRUMENTS)
			: this.resolveDefinition(name, 'counter', 'counter increment', COUNTER_INSTRUMENTS)
		const metadata = this.buildMetadata(resolved, resolved.instrument !== 'up_down_counter')
		const key = this.createKey(name, stableLabels)
		const now = this.now()
		const existing = this.states.get(key)
		this.assertStateCompatible(name, existing, 'counter')
		recordCounterMeasurement({
			states: this.states, key, name, labels: stableLabels, value: count, now, metadata, definition: resolved, exemplar, existing,
			touchState: (state) => this.touchState(state, now, resolved)
		})
	}

	setGauge(
		name: string,
		labels: Record<string, string>,
		value: number,
		exemplar?: Exemplar,
		definition?: MetricInstrumentDefinition
	): void {

		this.assertMetricName(name)
		this.assertFiniteValue(name, value, 'gauge value')
		const stableLabels = snapshotMetricLabels(labels, 'Metric aggregator labels') ?? {}
		const resolved = definition
			? this.claimDefinitionFor(name, definition, 'gauge record', GAUGE_INSTRUMENTS)
			: this.resolveDefinition(name, 'gauge', 'gauge record', GAUGE_INSTRUMENTS)
		const metadata = this.buildMetadata(resolved)
		const now = this.now()
		const key = this.createKey(name, stableLabels)
		const existing = this.states.get(key)
		this.assertStateCompatible(name, existing, 'gauge')
		recordGaugeMeasurement({
			states: this.states, key, name, labels: stableLabels, value, now, metadata, definition: resolved, exemplar, existing,
			touchState: (state) => this.touchState(state, now, resolved)
		})
	}

	observeHistogram(
		name: string,
		labels: Record<string, string>,
		value: number,
		exemplar?: Exemplar,
		definition?: MetricInstrumentDefinition
	): void {

		this.assertMetricName(name)
		this.assertFiniteNonNegativeObservation(name, value, 'histogram')
		const stableLabels = snapshotMetricLabels(labels, 'Metric aggregator labels') ?? {}
		const resolved = definition
			? this.claimDefinitionFor(name, definition, 'histogram observation', HISTOGRAM_INSTRUMENTS)
			: this.resolveDefinition(name, 'histogram', 'histogram observation', HISTOGRAM_INSTRUMENTS)
		const metadata = this.buildMetadata(resolved)
		const key = this.createKey(name, stableLabels)
		const now = this.now()
		const existing = this.states.get(key)
		this.assertStateCompatible(name, existing, 'histogram')
		const buckets = resolved.histogramBuckets
			?? (resolved.instrument === 'timer' ? TIMER_BUCKETS : this.histogramBuckets)
		recordHistogramObservation({
			states: this.states, key, name, labels: stableLabels, value, now, buckets, metadata, definition: resolved, exemplar, existing,
			touchState: (state) => this.touchState(state, now, resolved)
		})
	}

	evictStale(now = this.now()): number {
		const evicted = evictStaleSeries(this.states, now, (state) => {
			this.onStaleEvict?.(state.name, {...state.labels})
		})
		if (evicted > 0) {
			for (const key of this.deltaCommitProgress.keys()) {
				if (!this.states.has(key)) this.deltaCommitProgress.delete(key)
			}
		}
		return evicted
	}

	snapshot(options: MetricAggregatorSnapshotOptions = {}): ReadonlyArray<MetricRecord> {
		const {resetDelta = false, evictStale = true} = options
		const now = this.now()
		if (evictStale) {
			this.evictStale(now)
		}
		return snapshotMetricStates(
			this.states, now, this.defaultTemporality, resetDelta,
			++this.deltaSnapshotSequence, this.deltaCommitProgress
		)
	}

	commitDeltaSnapshot(snapshot: ReadonlyArray<MetricRecord>): void {
		commitDeltaSnapshotState(this.states, this.deltaCommitProgress, snapshot, (name, labels) => this.createKey(name, labels))
	}

	clear(): void {
		this.states.clear()
		this.definitions.clear()
		this.deltaCommitProgress.clear()
	}

	getDiagnostics(): MetricAggregatorDiagnostics {
		return {
			registeredMetrics: this.definitions.size,
			activeSeries: this.states.size
		}
	}
}
