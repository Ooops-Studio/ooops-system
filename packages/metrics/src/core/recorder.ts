/**
 * @file Metric recorder entry point.
 * Normalizes inputs, applies correlation context, and delegates to aggregator.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import {
	CARDINALITY_TRACKER_MAX_KEYS,
	HISTOGRAM_BUCKETS_DEFAULT
} from '../constants'
import type {MetricInstrumentDefinition} from '../types/instruments'
import {readMetricsClock, snapshotMetricsClock} from '../utils/clock'
import {validateLabelLimits} from '../utils/config-validation'
import {createExemplar} from '../utils/correlation-context'
import {estimateMetricRecordSize} from '../utils/helpers'
import {
	createCardinalityTracker,
	normalizeLabels,
	sanitizeLabelName,
	sanitizeMetricName,
	type CardinalityTracker,
	type LabelLimits
} from '../utils/label-sanitizer'
import {createMetricsOnError} from '../utils/on-error'

import type {MetricAggregator} from './aggregator'
import {snapshotMetricDefinition, snapshotMetricLabels} from './instrument-definition'
import {
	validateCounterValue,
	validateGaugeValue,
	validateObservedValue
} from './recorder-values'

export interface MetricRecorderOptions {
	readonly aggregator: MetricAggregator
	readonly clock: Clock
	readonly labelLimits: LabelLimits
	readonly exemplars: boolean
	readonly resourceLabels?: Record<string, string>
	readonly defaultTemporality?: 'cumulative' | 'delta'
	readonly onLabelDrop?: (reason: string, metricName: string) => void
	readonly onCardinalityDrop?: (metricName: string, reason: string) => void
	readonly cardinalityTracker?: CardinalityTracker
	readonly errors?: Errors
}

export class MetricRecorder {

	private readonly aggregator: MetricAggregator
	private readonly clock: Clock
	private readonly labelLimits: LabelLimits
	private readonly exemplars: boolean
	private readonly resourceLabels: Readonly<Record<string, string>>
	private readonly resourceLabelOrigins: ReadonlyMap<string, string>
	private readonly defaultTemporality: 'cumulative' | 'delta'
	private readonly onLabelDrop: ((reason: string, metricName: string) => void) | undefined
	private readonly onCardinalityDrop: ((metricName: string, reason: string) => void) | undefined
	private readonly cardinalityTracker: CardinalityTracker
	private readonly onError: (err: unknown, extra?: Record<string, string>) => void
	private readonly sanitizationCache = new Map<string, string>()
	private readonly sanitizedNameOrigins = new Map<string, string>()
	private readonly definitions = new Map<string, MetricInstrumentDefinition>()
	private readonly labelSchemas = new Map<string, ReadonlySet<string>>()

	constructor(options: MetricRecorderOptions) {
		if (!options || typeof options !== 'object') throw new Error('Recorder options must be an object')
		const {
			aggregator,
			clock,
			labelLimits,
			exemplars,
			resourceLabels = {},
			defaultTemporality = 'cumulative',
			onLabelDrop,
			onCardinalityDrop,
			cardinalityTracker,
			errors
		} = options
		const stableClock = snapshotMetricsClock(clock, 'Metric recorder clock')
		if (!aggregator || typeof aggregator !== 'object'
			|| typeof aggregator.register !== 'function'
			|| typeof aggregator.increment !== 'function'
			|| typeof aggregator.setGauge !== 'function'
			|| typeof aggregator.observeHistogram !== 'function') {
			throw new Error('Recorder requires a valid aggregator')
		}
		validateLabelLimits(labelLimits)
		if (typeof exemplars !== 'boolean') throw new Error('Recorder exemplars must be a boolean')
		if (onLabelDrop !== undefined && typeof onLabelDrop !== 'function') {
			throw new Error('onLabelDrop must be a function')
		}
		if (onCardinalityDrop !== undefined && typeof onCardinalityDrop !== 'function') {
			throw new Error('onCardinalityDrop must be a function')
		}
		if (cardinalityTracker !== undefined && (!cardinalityTracker
			|| typeof cardinalityTracker.check !== 'function'
			|| typeof cardinalityTracker.getDiagnostics !== 'function'
			|| typeof cardinalityTracker.reset !== 'function')) {
			throw new Error('Recorder cardinalityTracker is invalid')
		}
		if (defaultTemporality !== 'cumulative' && defaultTemporality !== 'delta') {
			throw new Error('defaultTemporality must be cumulative or delta')
		}

		this.aggregator = aggregator
		this.clock = stableClock
		this.labelLimits = {...labelLimits}
		this.exemplars = exemplars
		this.resourceLabels = snapshotMetricLabels(resourceLabels, 'Metric recorder resourceLabels') ?? {}
		const resourceLabelOrigins = new Map<string, string>()
		for (const key of Object.keys(this.resourceLabels)) {
			const sanitized = sanitizeLabelName(key)
			const existing = resourceLabelOrigins.get(sanitized)
			if (existing !== undefined && existing !== key) {
				throw new Error(`Resource labels "${existing}" and "${key}" collide after sanitization`)
			}
			resourceLabelOrigins.set(sanitized, key)
		}
		this.resourceLabelOrigins = resourceLabelOrigins
		this.defaultTemporality = defaultTemporality
		this.onLabelDrop = onLabelDrop
		this.onCardinalityDrop = onCardinalityDrop
		this.cardinalityTracker = cardinalityTracker ?? createCardinalityTracker({clock})
		this.onError = createMetricsOnError(errors, {stage: 'recorder'})
	}

	private getSanitizedName(name: string): string {
		if (typeof name !== 'string') throw new Error('name must be a string')
		if (name.length === 0) throw new Error('name must not be empty')
		if (name.length > 1_024) throw new Error('name must not exceed 1024')

		const cached = this.sanitizationCache.get(name)
		if (cached) {
			return cached
		}

		const sanitized = sanitizeMetricName(name)
		const existingOrigin = this.sanitizedNameOrigins.get(sanitized)
		if (existingOrigin !== undefined && existingOrigin !== name) {
			const error = new Error(
				`Metric name collision: "${existingOrigin}" and "${name}" both sanitize to "${sanitized}"`
			)
			this.onError(error, {metricName: sanitized, operation: 'sanitize-name'})
			throw error
		}
		this.sanitizedNameOrigins.set(sanitized, name)
		if (this.sanitizationCache.size >= CARDINALITY_TRACKER_MAX_KEYS) {
			const firstKey = this.sanitizationCache.keys().next().value
			if (firstKey) {
				this.sanitizationCache.delete(firstKey)
			}
		}
		this.sanitizationCache.set(name, sanitized)
		return sanitized
	}

	private getDefinition(
		name: string,
		instrument: MetricInstrumentDefinition['instrument'],
		overrides?: Partial<Omit<MetricInstrumentDefinition, 'name' | 'instrument'>>
	): MetricInstrumentDefinition | undefined {

		const sanitizedName = this.getSanitizedName(name)
		const existing = this.definitions.get(sanitizedName)
		if (existing) {
			this.assertInstrumentCompatible(sanitizedName, existing.instrument, instrument)
			return existing
		}
		if (this.isMetricNameCapacityExceeded(name, sanitizedName)) return undefined

		const definition: MetricInstrumentDefinition = {
			name: sanitizedName,
			instrument,
			temporality: this.defaultTemporality,
			...(overrides ?? {})
		}
		const normalized = snapshotMetricDefinition(
			definition,
			sanitizedName,
			this.defaultTemporality
		)
		return normalized
	}

	private discardUncommittedDefinition(originalName: string, definition: MetricInstrumentDefinition): void {
		if (this.definitions.has(definition.name)) return
		if (this.sanitizedNameOrigins.get(definition.name) === originalName) {
			this.sanitizedNameOrigins.delete(definition.name)
		}
		this.sanitizationCache.delete(originalName)
	}

	private commitGeneratedDefinition(originalName: string, definition: MetricInstrumentDefinition): void {
		if (this.definitions.has(definition.name)) return
		try {
			this.aggregator.register(definition)
			this.definitions.set(definition.name, definition)
		} catch(error) {
			this.discardUncommittedDefinition(originalName, definition)
			throw error
		}
	}

	private isMetricNameCapacityExceeded(originalName: string, sanitizedName: string): boolean {
		if (this.definitions.size < CARDINALITY_TRACKER_MAX_KEYS) return false
		if (this.sanitizedNameOrigins.get(sanitizedName) === originalName) {
			this.sanitizedNameOrigins.delete(sanitizedName)
		}
		this.sanitizationCache.delete(originalName)
		try {
			this.onCardinalityDrop?.(sanitizedName, 'max_metric_names')
		} catch {
			// Cardinality diagnostics must not replace the bounded drop.
		}
		return true
	}

	register<T extends MetricInstrumentDefinition>(definition: T, labelNames?: readonly string[]): T {
		const requested = snapshotMetricDefinition(
			definition,
			undefined,
			this.defaultTemporality
		)
		const sanitizedName = this.getSanitizedName(requested.name)
		const existing = this.definitions.get(sanitizedName)
		if (!existing && this.isMetricNameCapacityExceeded(requested.name, sanitizedName)) {
			throw new Error(`Metrics registered metric limit of ${CARDINALITY_TRACKER_MAX_KEYS} exceeded`)
		}
		if (existing) {
			this.assertInstrumentCompatible(sanitizedName, existing.instrument, requested.instrument)
		}
		const normalized = snapshotMetricDefinition(
			requested,
			sanitizedName,
			this.defaultTemporality
		)

		this.aggregator.register(normalized)
		this.definitions.set(sanitizedName, normalized)
		if (labelNames) this.labelSchemas.set(sanitizedName, new Set(labelNames))
		return normalized as T
	}

	private assertInstrumentCompatible(
		name: string,
		existing: MetricInstrumentDefinition['instrument'],
		requested: MetricInstrumentDefinition['instrument']
	): void {
		if (existing === requested) {
			return
		}
		const error = new Error(
			`Metric "${name}" is already registered as ${existing}; cannot use it as ${requested}`
		)
		this.onError(error, {
			metricName: name,
			existingInstrument: existing,
			requestedInstrument: requested,
			operation: 'register'
		})
		throw error
	}

	counter(name: string, count = 1, labels?: Record<string, string>, definition?: MetricInstrumentDefinition): void {
		validateCounterValue(name, count, true, this.onError)
		const suppliedLabels = labels !== undefined || definition?.labels !== undefined
			? this.prepareLabels(name, labels ?? definition?.labels ?? {}) : undefined
		const resolved = definition ?? this.getDefinition(name, 'counter')
		if (!resolved) return
		const stableLabels = suppliedLabels ?? this.prepareLabels(name, resolved.labels ?? {})
		this.incrementInternal(resolved, stableLabels, count, definition === undefined ? name : undefined)
	}

	upDownCounter(
		name: string,
		delta: number,
		labels?: Record<string, string>,
		definition?: MetricInstrumentDefinition
	): void {
		validateCounterValue(name, delta, false, this.onError)
		const suppliedLabels = labels !== undefined || definition?.labels !== undefined
			? this.prepareLabels(name, labels ?? definition?.labels ?? {}) : undefined
		const resolved = definition ?? this.getDefinition(name, 'up_down_counter')
		if (!resolved) return
		const stableLabels = suppliedLabels ?? this.prepareLabels(name, resolved.labels ?? {})
		this.incrementInternal(resolved, stableLabels, delta, definition === undefined ? name : undefined)
	}

	gauge(
		name: string,
		value: number,
		labels?: Record<string, string>,
		definition?: MetricInstrumentDefinition
	): void {

		validateGaugeValue(name, value, this.onError)
		const suppliedLabels = labels !== undefined || definition?.labels !== undefined
			? this.prepareLabels(name, labels ?? definition?.labels ?? {}) : undefined
		const resolved = definition ?? this.getDefinition(name, 'gauge')
		if (!resolved) return
		const stableLabels = suppliedLabels ?? this.prepareLabels(name, resolved.labels ?? {})
		const normalizedLabels = this.normalizeLabels(resolved.name, stableLabels, resolved)
		if (!normalizedLabels) {
			if (definition === undefined) this.discardUncommittedDefinition(name, resolved)
			return
		}
		if (definition === undefined) this.commitGeneratedDefinition(name, resolved)
		const exemplar = this.exemplars ? createExemplar(value, readMetricsClock(this.clock, 'Metric recorder clock')) : undefined
		this.aggregator.setGauge(resolved.name, normalizedLabels, value, exemplar, resolved)
	}

	histogram(
		name: string,
		value: number,
		labels?: Record<string, string>,
		definition?: MetricInstrumentDefinition
	): void {

		validateObservedValue(name, value, 'histogram', this.onError)
		const suppliedLabels = labels !== undefined || definition?.labels !== undefined
			? this.prepareLabels(name, labels ?? definition?.labels ?? {}, 'le') : undefined
		const resolved = definition ?? this.getDefinition(name, 'histogram')
		if (!resolved) return
		const stableLabels = suppliedLabels ?? this.prepareLabels(name, resolved.labels ?? {}, 'le')
		const normalizedLabels = this.normalizeLabels(resolved.name, stableLabels, resolved)
		if (!normalizedLabels) {
			if (definition === undefined) this.discardUncommittedDefinition(name, resolved)
			return
		}
		if (definition === undefined) this.commitGeneratedDefinition(name, resolved)
		const exemplar = this.exemplars ? createExemplar(value, readMetricsClock(this.clock, 'Metric recorder clock')) : undefined
		this.aggregator.observeHistogram(resolved.name, normalizedLabels, value, exemplar, resolved)
	}

	timer(
		name: string,
		durationMs: number,
		labels?: Record<string, string>,
		definition?: MetricInstrumentDefinition
	): void {
		validateObservedValue(name, durationMs, 'histogram', this.onError)
		const suppliedLabels = labels !== undefined || definition?.labels !== undefined
			? this.prepareLabels(name, labels ?? definition?.labels ?? {}, 'le') : undefined
		const resolved = definition ?? this.getDefinition(name, 'timer', {unit: 'ms'})
		if (!resolved) return
		const stableLabels = suppliedLabels ?? this.prepareLabels(name, resolved.labels ?? {}, 'le')
		const normalizedLabels = this.normalizeLabels(resolved.name, stableLabels, resolved)
		if (!normalizedLabels) {
			if (definition === undefined) this.discardUncommittedDefinition(name, resolved)
			return
		}
		if (definition === undefined) this.commitGeneratedDefinition(name, resolved)
		const exemplar = this.exemplars
			? createExemplar(durationMs, readMetricsClock(this.clock, 'Metric recorder clock')) : undefined
		this.aggregator.observeHistogram(resolved.name, normalizedLabels, durationMs, exemplar, {
			...resolved, instrument: 'timer', unit: resolved.unit ?? 'ms'
		})
	}

	increment(name: string, labels?: Record<string, string>, count = 1): void {
		this.counter(name, count, labels)
	}

	record(name: string, value: number, labels?: Record<string, string>): void {
		this.gauge(name, value, labels)
	}

	observe(name: string, value: number, labels?: Record<string, string>): void {
		this.histogram(name, value, labels)
	}

	private incrementInternal(
		definition: MetricInstrumentDefinition,
		labels: Record<string, string> | undefined,
		count: number,
		generatedFromName?: string
	): void {
		const normalizedLabels = this.normalizeLabels(definition.name, labels ?? definition.labels ?? {}, definition)
		if (!normalizedLabels) {
			if (generatedFromName !== undefined) {
				this.discardUncommittedDefinition(generatedFromName, definition)
			}
			return
		}
		if (generatedFromName !== undefined) {
			this.commitGeneratedDefinition(generatedFromName, definition)
		}
		const exemplar = this.exemplars ? createExemplar(count, readMetricsClock(this.clock, 'Metric recorder clock')) : undefined
		this.aggregator.increment(definition.name, normalizedLabels, count, exemplar, definition)
	}

	private prepareLabels(
		name: string,
		labels: Record<string, string>,
		reservedLabel?: 'le'
	): Record<string, string> {
		const stableLabels = snapshotMetricLabels(labels, 'Metric labels') as Record<string, string>
		const labelSchema = this.labelSchemas.get(sanitizeMetricName(name))
		if (labelSchema) for (const key of Object.keys(stableLabels))
			if (!labelSchema.has(sanitizeLabelName(key))) throw new Error('Label outside schema')
		for (const key of Object.keys(stableLabels)) {
			const resourceOrigin = this.resourceLabelOrigins.get(sanitizeLabelName(key))
			if (resourceOrigin !== undefined) {
				const error = new Error(
					`Metric "${name}" cannot override resource label "${resourceOrigin}"`
				)
				this.onError(error, {metricName: name, operation: 'labels', resourceLabel: resourceOrigin})
				throw error
			}
		}
		if (reservedLabel && [...Object.keys(this.resourceLabels), ...Object.keys(stableLabels)].some(
			(key) => sanitizeLabelName(key) === reservedLabel
		)) {
			const error = new Error(
				`Metric "${name}" cannot use reserved label "${reservedLabel}"`
			)
			this.onError(error, {metricName: name, operation: 'labels', reservedLabel})
			throw error
		}
		return stableLabels
	}

	private normalizeLabels(
		name: string,
		labels: Record<string, string>,
		definition: MetricInstrumentDefinition
	): Record<string, string> | null {
		const callLabels = snapshotMetricLabels(labels, 'Metric labels') as Record<string, string>
		const resolvedLabels = {
			...this.resourceLabels,
			...callLabels
		}

		const tempRecord = {
			name,
			type: 'gauge' as const,
			value: 0,
			labels: resolvedLabels,
			timestamp: readMetricsClock(this.clock, 'Metric recorder clock')
		}
		const histogram = definition.instrument === 'histogram' || definition.instrument === 'timer'
		const recordCount = histogram
			? (definition.histogramBuckets?.length ?? HISTOGRAM_BUCKETS_DEFAULT.length) + 3 : 1

		const normalized =
			normalizeLabels(
				tempRecord,
				this.labelLimits,
				this.onLabelDrop,
				this.onCardinalityDrop,
				this.cardinalityTracker,
				recordCount,
				(normalizedLabels) => {
					return recordCount * (estimateMetricRecordSize({
						name: histogram ? `${definition.name}_bucket` : definition.name,
						labels: histogram ? {...normalizedLabels, le: '+Inf'} : normalizedLabels,
						metadata: definition
					}) + 576 + (this.exemplars ? 1_712 : 0))
				}
			)
		if (!normalized) {
			return null
		}
		return normalized.labels
	}

	/** Release retained configuration and caches after terminal handler shutdown. */
	clear(): void {
		for (const key of Object.keys(this.resourceLabels)) {
			delete (this.resourceLabels as Record<string, string>)[key]
		}
		if (this.resourceLabelOrigins instanceof Map) this.resourceLabelOrigins.clear()
		this.sanitizationCache.clear()
		this.sanitizedNameOrigins.clear()
		this.definitions.clear()
		this.labelSchemas.clear()
	}
}
