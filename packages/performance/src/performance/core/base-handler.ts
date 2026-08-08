import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {
	BudgetStatus,
	DBQueryMetadata,
	PerfEvent,
	PerformanceSpanOptions,
	SaturationAlert
} from '@ooopsstudio/core/contracts/performance'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'

import type {PerformanceHandlerPort, PerformanceSinkState} from '../types/ports'
import {createPerformanceOnError} from '../utils/on-error'
import {
	hasControlCharacters,
	isSensitivePerformanceKey,
	sanitizePerformanceEventName,
	sanitizePerformanceLabelValue,
	snapshotPerformanceLabels
} from '../utils/safe-identifiers'

import {
	createPerformanceCallbackDispatcher,
	type PerformanceCallbackDispatcher,
	type PerformanceTelemetryCallbacks
} from './callback-dispatcher'
import {createCardinalityGuard} from './cardinality-guard'
import {createHighResClock} from './clock'
import {createMeasurementPortMethods} from './factories/performance-port-measurements'
import {registerPerformanceDispatcher} from './runtime-capabilities'
import {createPerformanceTracingBridge, snapshotPerformanceSpanOptions} from './tracing-bridge'
import {deepFreezePerformanceValue, isResourceSnapshotEvent, snapshotSafeDBMetadata} from './utils/event-helpers'
import {buildHttpLabels, normalizeHttpMetadata} from './utils/request-helpers'

export interface BaseHandlerExtensions {
	onAcceptedEvent?(event: PerfEvent): void
	flush?(): Promise<void>
	shutdown?(): Promise<void>
	getExportStatus?(): {
		queueSize: number
		droppedTotal: number
		retriedTotal: number
		sinkState: PerformanceSinkState
		lastFailureCode?: string
	}
	getBudgetStatus?(name: string): BudgetStatus | undefined
}

export interface BasePerformanceHandlerOptions {
	clock: Clock
	cardinalityLimit: number
	cardinalityMode: 'warn' | 'drop'
	enableEventLoopMonitor: boolean
	enableGCMonitor: boolean
	enableResourceMonitor: boolean
	errors?: Errors
	tracer?: Tracing
	callbacks?: PerformanceTelemetryCallbacks
	createRuntimeMonitoring?: (options: {
		clock: ReturnType<typeof createHighResClock>
		onPerfEvent: (event: PerfEvent) => void
		onSaturationAlert: (alert: SaturationAlert) => void
		errors?: Errors
		enableEventLoopMonitor: boolean
		enableGCMonitor: boolean
		enableResourceMonitor: boolean
	}) => {stop(): void}
	createExtensions?: (dispatcher: PerformanceCallbackDispatcher, clock: ReturnType<typeof createHighResClock>) => BaseHandlerExtensions
}

const RESOURCE_VALUE_LABELS = new Set(['user', 'system', 'utilization', 'rss', 'heapUsed', 'heapTotal', 'external'])
const snapshotEventLabels = (
	labels: Record<string, string> | undefined,
	options: {preserveHttpRoute?: boolean; preserveResourceValues?: boolean} = {}
): Record<string, string> | undefined => {
	if (!labels) return undefined
	const entries = Object.entries(snapshotPerformanceLabels(labels) ?? {})
	const snapshot: Record<string, string> = {}
	for (const [key, value] of entries) {
		if (!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(key) || typeof value !== 'string' || value.length > 256) {
			throw new Error('Performance event labels exceed safe key/value limits')
		}
		if (options.preserveHttpRoute && key === 'route') {
			if (hasControlCharacters(value)) throw new Error('Performance HTTP routes cannot contain control characters')
			snapshot[key] = value
		} else if (options.preserveResourceValues && RESOURCE_VALUE_LABELS.has(key)) {
			const numeric = Number(value)
			if (!Number.isFinite(numeric) || numeric < 0) throw new Error('Performance resource labels must be non-negative finite numbers')
			snapshot[key] = value
		} else {
			snapshot[key] = isSensitivePerformanceKey(key) ? '[redacted]' : sanitizePerformanceLabelValue(value)
		}
	}
	return snapshot
}

const VALID_EVENT_SOURCES = new Set(['runtime', 'mark', 'feature'])
const VALID_EVENT_OUTCOMES = new Set(['ok', 'client_error', 'server_error', 'timeout', 'aborted'])

export function createBasePerformanceHandler(
	options: BasePerformanceHandlerOptions
): PerformanceHandlerPort {
	const clock = createHighResClock({clock: options.clock})
	const dispatcher = createPerformanceCallbackDispatcher(options.callbacks ?? {})
	const cardinality = createCardinalityGuard({
		maxCombinations: options.cardinalityLimit,
		mode: options.cardinalityMode,
		now: clock.now,
		onExceeded: (name, reason) => dispatcher.emit('onDimensionExplosion', name, reason)
	})
	const tracing = createPerformanceTracingBridge(options.tracer)
	const onError = createPerformanceOnError(options.errors, {operation: 'measure'})
	let extensions: BaseHandlerExtensions = {}
	let state: 'running' | 'draining' | 'closed' = 'running'
	let droppedEvents = 0
	let activeMeasurements = 0
	let activeBarrier: Promise<void> | undefined
	let releaseActiveBarrier: (() => void) | undefined
	let monitorsStopped = false
	let finalizationFailureCode: string | undefined
	const beginMeasurement = (): (() => void) | undefined => {
		if (state !== 'running') return undefined
		activeMeasurements += 1
		dispatcher.emit('onSelfMetric', '_performance_active_measurements', activeMeasurements)
		return () => {
			activeMeasurements -= 1
			dispatcher.emit('onSelfMetric', '_performance_active_measurements', activeMeasurements)
			if (activeMeasurements === 0) {
				releaseActiveBarrier?.()
				releaseActiveBarrier = undefined
				activeBarrier = undefined
			}
		}
	}
	const waitForActive = async(): Promise<void> => {
		if (activeMeasurements === 0) return
		activeBarrier ??= new Promise<void>((resolve) => { releaseActiveBarrier = resolve })
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				activeBarrier,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('PERFORMANCE_DRAIN_TIMEOUT')), 5_000)
				})
			])
		} finally {
			try { if (timer) clearTimeout(timer) } catch { /* completed drain remains authoritative */ }
		}
	}
	const withFailedDBMetadata = (metadata?: DBQueryMetadata): DBQueryMetadata => {
		try { return {...(metadata ?? {}), success: false, failureCode: 'query_failed'} } catch {
			return {success: false, failureCode: 'query_failed'}
		}
	}

	const emitEvent = (event: PerfEvent, metadata?: DBQueryMetadata): void => {
		if (state === 'closed') return
		let enriched: PerfEvent
		let eventName = '<invalid>'
		try {
			const rawName: unknown = event.name
			const validName = typeof rawName === 'string' && rawName.length <= 128 &&
				Boolean(rawName.trim()) && !hasControlCharacters(rawName)
			eventName = validName ? sanitizePerformanceEventName(rawName) : '<invalid>'
			if (
				!validName ||
				!Number.isFinite(event.duration) ||
				event.duration < 0 ||
				!Number.isFinite(event.start) ||
				!Number.isFinite(event.end) ||
				event.end < event.start ||
				!VALID_EVENT_SOURCES.has(event.source) ||
				(event.outcome !== undefined && !VALID_EVENT_OUTCOMES.has(event.outcome))
			) {
				throw new Error('Invalid performance event')
			}
			const correlation = tracing.getCorrelation()
			const resourceSnapshot = isResourceSnapshotEvent(event.source, eventName)
			const http = event.http ? normalizeHttpMetadata(event.http) : undefined
			const labels = snapshotEventLabels(
				http ? buildHttpLabels(http, event.labels) : event.labels,
				{preserveHttpRoute: Boolean(http), preserveResourceValues: resourceSnapshot}
			)
			const resolvedOutcome = event.outcome ?? http?.outcome
			enriched = {
				...event,
				name: eventName,
				...(labels ? {labels} : {}),
				...(http ? {http} : {}),
				...(resolvedOutcome ? {outcome: resolvedOutcome} : {}),
				...(metadata
					? {dbMetadata: snapshotSafeDBMetadata(metadata)}
					: event.dbMetadata
						? {dbMetadata: snapshotSafeDBMetadata(event.dbMetadata)}
						: {}),
				...(event.traceId ?? correlation.traceId
					? {traceId: event.traceId ?? correlation.traceId}
					: {}),
				...(event.spanId ?? correlation.spanId
					? {spanId: event.spanId ?? correlation.spanId}
					: {})
			}
			// CPU/memory snapshot labels are numeric observations that change on
			// every tick. They must not consume the low-cardinality dimension budget.
			const cardinalityLabels = resourceSnapshot
				? undefined
				: enriched.labels
			const check = cardinality.check(enriched.name, cardinalityLabels)
			if (!check.allowed) {
				droppedEvents += 1
				dispatcher.emit('onSelfMetric', '_performance_dropped_total', 1, {reason: check.reason ?? 'cardinality'})
				dispatcher.emit('onDimensionDrop', enriched.name, check.reason ?? 'limit-exceeded')
				return
			}
			if (check.reason) {
				enriched = {
					...enriched,
					name: 'cardinality_overflow',
					labels: {reason: check.reason}
				}
			}
		} catch(error) {
			droppedEvents += 1
			dispatcher.emit('onSelfMetric', '_performance_dropped_total', 1, {reason: 'invalid_event'})
			onError(error, {eventName})
			return
		}
		enriched = deepFreezePerformanceValue(enriched)
		dispatcher.emit('onSelfMetric', '_performance_recorded_total', 1, {source: enriched.source})
		try {
			extensions.onAcceptedEvent?.(enriched)
		} catch(error) {
			onError(error, {eventName: enriched.name, operation: 'accepted-event-extension'})
		}
		dispatcher.emit('onPerfEvent', enriched)
	}

	const measurements = createMeasurementPortMethods({
		clock,
		emitEvent,
		onError,
		withFailedDBMetadata
	})
	let monitoring: {stop(): void} | undefined
	try {
		monitoring = options.createRuntimeMonitoring?.({
			clock,
			onPerfEvent: emitEvent,
			onSaturationAlert: (alert: SaturationAlert) => dispatcher.emit('onSaturationAlert', alert),
			...(options.errors ? {errors: options.errors} : {}),
			enableEventLoopMonitor: options.enableEventLoopMonitor,
			enableGCMonitor: options.enableGCMonitor,
			enableResourceMonitor: options.enableResourceMonitor
		})
		extensions = options.createExtensions?.(dispatcher, clock) ?? {}
	} catch(error) {
		try { monitoring?.stop() } catch { /* preserve the setup failure */ }
		throw error
	}
	let shutdownPromise: Promise<void> | undefined

	const port: PerformanceHandlerPort = {
		record(name, value, labels) {
			const finish = beginMeasurement()
			if (!finish) return
			try { measurements.record(name, value, labels) } finally { finish() }
		},
		async measureAsync(name, fn, labels) {
			const finish = beginMeasurement()
			if (!finish) return await fn()
			try { return await measurements.measureAsync(name, fn, labels) } finally { finish() }
		},
		measureSync(name, fn, labels) {
			const finish = beginMeasurement()
			if (!finish) return fn()
			try { return measurements.measureSync(name, fn, labels) } finally { finish() }
		},
		async measureDBQuery(name, fn, metadata, labels) {
			const finish = beginMeasurement()
			if (!finish) return await fn()
			try { return await measurements.measureDBQuery(name, fn, metadata, labels) } finally { finish() }
		},
		measureDBQuerySync(name, fn, metadata, labels) {
			const finish = beginMeasurement()
			if (!finish) return fn()
			try { return measurements.measureDBQuerySync(name, fn, metadata, labels) } finally { finish() }
		},
		async measureRequest(name, fn, metadata, labels) {
			const finish = beginMeasurement()
			if (!finish) return await fn()
			try { return await measurements.measureRequest(name, fn, metadata, labels) } finally { finish() }
		},
		async measureSpan<T>(name: string, fn: () => Promise<T>, spanOptions?: PerformanceSpanOptions) {
			const finish = beginMeasurement()
			if (!finish) return await fn()
			try {
				const capturedSpanOptions = snapshotPerformanceSpanOptions(spanOptions)
				const traceSpanName = typeof name === 'string' && name.length <= 128 && name.trim() && !hasControlCharacters(name)
					? sanitizePerformanceEventName(name)
					: 'performance.measurement'
				return await tracing.withSpan(traceSpanName, capturedSpanOptions, async(span) => {
					let eventLabels: Record<string, string> | undefined
					let dbMetadata: DBQueryMetadata | undefined
					let httpMetadata: PerformanceSpanOptions['http']
					try {
						eventLabels = snapshotPerformanceLabels(capturedSpanOptions?.labels as Record<string, string> | undefined)
						dbMetadata = snapshotSafeDBMetadata(capturedSpanOptions?.dbMetadata)
						httpMetadata = capturedSpanOptions?.http ? normalizeHttpMetadata(capturedSpanOptions.http) : undefined
					} catch {
					// Optional span metadata must not alter the measured operation.
					}
					const started = clock.now()
					const startedHr = clock.nowHr()
					try {
						const result = await fn()
						const duration = Number(clock.nowHr() - startedHr) / 1_000_000
						const end = Math.max(started, clock.now())
						tracing.annotate(span, capturedSpanOptions, duration, 'ok')
						emitEvent({
							name,
							duration,
							start: started,
							end,
							source: 'mark',
							...(httpMetadata ? {http: httpMetadata} : {}),
							...(httpMetadata?.outcome ? {outcome: httpMetadata.outcome} : {}),
							labels: {...(eventLabels ?? {}), instrumentation: 'span'}
						}, dbMetadata)
						return result
					} catch(error) {
						const duration = Number(clock.nowHr() - startedHr) / 1_000_000
						const end = Math.max(started, clock.now())
						const failureOutcome = httpMetadata?.aborted ? 'aborted' as const
							: httpMetadata?.timedOut ? 'timeout' as const
								: 'server_error' as const
						tracing.annotate(span, capturedSpanOptions, duration, 'error')
						tracing.recordError(span, error)
						emitEvent({
							name,
							duration,
							start: started,
							end,
							source: 'mark',
							outcome: failureOutcome,
							...(httpMetadata ? {http: {
								...httpMetadata, statusCode: undefined, outcome: failureOutcome
							}} : {}),
							labels: {...(eventLabels ?? {}), instrumentation: 'span'}
						}, dbMetadata
							? withFailedDBMetadata(dbMetadata)
							: undefined)
						throw error
					}
				})
			} finally { finish() }
		},
		getBudgetStatus(name) {
			if (typeof name !== 'string' || name.length > 128) return undefined
			try {
				const status = extensions.getBudgetStatus?.(name)
				return status ? Object.freeze({...status}) : undefined
			} catch { return undefined }
		},
		async flush() {
			if (state === 'closed') return
			if (state === 'draining' && shutdownPromise) return await shutdownPromise
			try { await extensions.flush?.() } catch(error) {
				dispatcher.emit('onSelfMetric', '_performance_finalization_failures_total', 1, {operation: 'flush'})
				throw error
			}
		},
		async shutdown() {
			if (state === 'closed') return
			if (!shutdownPromise) {
				shutdownPromise = (async() => {
					state = 'draining'
					if (!monitorsStopped) {
						monitorsStopped = true
						try { monitoring?.stop() } catch(error) {
							onError(error, {operation: 'runtime-monitor.stop'})
						}
					}
					await waitForActive()
					await extensions.shutdown?.()
					state = 'closed'
					finalizationFailureCode = undefined
				})()
			}
			try {
				await shutdownPromise
			} catch(error) {
				finalizationFailureCode = 'PERFORMANCE_FINALIZATION_FAILURE'
				dispatcher.emit('onSelfMetric', '_performance_finalization_failures_total', 1, {operation: 'shutdown'})
				shutdownPromise = undefined
				throw error
			}
		},
		getStatus() {
			let status: ReturnType<NonNullable<BaseHandlerExtensions['getExportStatus']>> | undefined
			try { status = extensions.getExportStatus?.() } catch {
				status = {
					queueSize: 0,
					droppedTotal: 0,
					retriedTotal: 0,
					sinkState: 'unhealthy',
					lastFailureCode: 'PERFORMANCE_STATUS_FAILURE'
				}
			}
			return Object.freeze({
				state,
				activeMeasurements,
				queueSize: status?.queueSize ?? 0,
				droppedTotal: droppedEvents + (status?.droppedTotal ?? 0),
				retriedTotal: status?.retriedTotal ?? 0,
				sinkState: state === 'closed' ? 'closed' : finalizationFailureCode
					? 'unhealthy' : status?.sinkState ?? 'healthy',
				...(finalizationFailureCode ?? status?.lastFailureCode
					? {lastFailureCode: finalizationFailureCode ?? status?.lastFailureCode}
					: {})
			})
		}
	}
	registerPerformanceDispatcher(port, dispatcher)
	return port
}
