import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {PerformanceEventExporterPort} from '@ooopsstudio/core/ports/performance'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createBasePerformanceHandler} from '../core/base-handler'
import {isResourceSnapshotEvent} from '../core/utils/event-helpers'
import {toPerformanceEventRecord} from '../core/utils/request-helpers'
import type {BudgetConfig} from '../features/core/budget-engine'
import type {N1DetectorOptions} from '../features/db/n1-detector'
import type {ManagedPerformance} from '../types/ports'
import {failPerformanceSetup, registerPerformanceLifecycleCleanup} from '../utils/lifecycle-cleanup'
import {isSensitivePerformanceKey, sanitizePerformanceLabelValue} from '../utils/safe-identifiers'
import {isRuntimeProxy} from '../utils/safe-object'

export type PerformanceBudgetDefinition = BudgetConfig
export type PerformanceEventExporter = PerformanceEventExporterPort

export interface CustomPerformanceOptions {
	clock?: Clock
	resource?: ObservabilityResource
	errors?: Errors
	tracer?: Tracing
	lifecycle?: LifecyclePort
	budgets?: readonly PerformanceBudgetDefinition[]
	n1Detection?: N1DetectorOptions
	runtimeMonitoring?: {eventLoop?: boolean; gc?: boolean; resources?: boolean}
	destinations?: ReadonlyArray<{name: string; exporter: PerformanceEventExporter}>
	delivery?: {
		maxQueueRecords?: number
		maxQueueBytes?: number
		flushIntervalMs?: number
		retry?: {attempts?: number; baseDelayMs?: number}
		operationTimeoutMs?: number
	}
}

const CUSTOM_FIELDS = new Set([
	'clock', 'resource', 'errors', 'tracer', 'lifecycle', 'budgets', 'n1Detection',
	'runtimeMonitoring', 'destinations', 'delivery'
])
const BUDGET_FIELDS = new Set(['name', 'pattern', 'percentile', 'target', 'window'])
const N1_FIELDS = new Set(['enabled', 'timeWindowMs', 'minDuplicates', 'maxTrackedTraces', 'maxEventsPerTrace'])
const MONITOR_FIELDS = new Set(['eventLoop', 'gc', 'resources'])
const DELIVERY_FIELDS = new Set(['maxQueueRecords', 'maxQueueBytes', 'flushIntervalMs', 'retry', 'operationTimeoutMs'])
const RETRY_FIELDS = new Set(['attempts', 'baseDelayMs'])
const DESTINATION_FIELDS = new Set(['name', 'exporter'])
const snapshotClosed = (
	value: unknown,
	allowed: ReadonlySet<string>,
	label: string
): Record<string, unknown> => {
	try {
		if (!value || typeof value !== 'object' || isRuntimeProxy(value) || Array.isArray(value)) throw new TypeError()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError()
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		let inspected = 0
		for (const key in value) {
			if (inspected >= allowed.size) throw new TypeError()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (key.length > 64 || !descriptor?.enumerable || !('value' in descriptor) || !allowed.has(key)) {
				throw new TypeError()
			}
			inspected += 1
			result[key] = descriptor.value
		}
		return Object.freeze(result)
	} catch { throw new TypeError(`${label} must be a closed plain data object`) }
}

const snapshotArray = (value: unknown, maximum: number, label: string): readonly unknown[] => {
	if (isRuntimeProxy(value) || !Array.isArray(value)) throw new TypeError(`${label} must be an array`)
	let lengthDescriptor: PropertyDescriptor | undefined
	try { lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length') } catch {
		throw new TypeError(`${label} must contain stable data items`)
	}
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
		throw new Error(`${label} supports at most ${maximum === 2 ? 'two' : maximum} items`)
	}
	const result: unknown[] = []
	for (let index = 0; index < length; index += 1) {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)) } catch {
			throw new TypeError(`${label} must contain stable data items`)
		}
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new TypeError(`${label} must contain stable data items`)
		}
		result.push(descriptor.value)
	}
	return Object.freeze(result)
}

const captureExporterMethod = (
	exporter: unknown,
	key: 'export' | 'flush' | 'shutdown'
): ((...args: never[]) => unknown) | undefined => {
	if (isRuntimeProxy(exporter) || ((!exporter || typeof exporter !== 'object') && typeof exporter !== 'function')) return undefined
	try {
		let owner: object | null = exporter as object
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...args: never[]) => unknown
				return (...args: never[]) => Reflect.apply(method, exporter, args)
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

const hasExporterMethodField = (exporter: unknown, key: 'flush' | 'shutdown'): boolean => {
	if (isRuntimeProxy(exporter) || ((!exporter || typeof exporter !== 'object') && typeof exporter !== 'function')) return false
	try {
		let owner: object | null = exporter as object
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return true
			if (Object.getOwnPropertyDescriptor(owner, key)) return true
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return true }
	return false
}

const snapshotDestination = (value: unknown): {name: string; exporter: PerformanceEventExporter} => {
	const destination = snapshotClosed(value, DESTINATION_FIELDS, 'Custom performance destination')
	const exportBatch = captureExporterMethod(destination.exporter, 'export')
	const flush = captureExporterMethod(destination.exporter, 'flush')
	const shutdown = captureExporterMethod(destination.exporter, 'shutdown')
	if (!exportBatch) throw new TypeError('Custom performance destination exporter must provide export()')
	if ((hasExporterMethodField(destination.exporter, 'flush') && !flush) ||
		(hasExporterMethodField(destination.exporter, 'shutdown') && !shutdown)) {
		throw new TypeError('Custom performance destination lifecycle hooks must be data-method functions')
	}
	return Object.freeze({
		name: destination.name as string,
		exporter: Object.freeze({
			export: exportBatch as PerformanceEventExporter['export'],
			...(flush ? {flush: flush as NonNullable<PerformanceEventExporter['flush']>} : {}),
			...(shutdown ? {shutdown: shutdown as NonNullable<PerformanceEventExporter['shutdown']>} : {})
		})
	})
}

const snapshotResource = (value: unknown): ObservabilityResource | undefined => {
	if (value === undefined) return undefined
	const resource = snapshotClosed(
		value,
		new Set(['serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime', 'attributes']),
		'Performance resource'
	)
	if (typeof resource.serviceName !== 'string' || resource.serviceName.length > 128 || !resource.serviceName.trim()) {
		throw new TypeError('Performance resource serviceName must be a non-empty string of at most 128 characters')
	}
	const result: ObservabilityResource = {serviceName: resource.serviceName}
	for (const key of ['serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime'] as const) {
		const field = resource[key]
		if (field !== undefined) {
			if (typeof field !== 'string' || field.length > 256) throw new TypeError(`Performance resource ${key} is invalid`)
			Object.assign(result, {[key]: field})
		}
	}
	if (resource.attributes !== undefined) {
		let remainingNodes = 128
		let remainingCharacters = 8_192
		const capture = (current: unknown, key: string, depth: number): unknown => {
			if (key.length > 128) throw new TypeError('Performance resource attribute keys must be at most 128 characters')
			if (isSensitivePerformanceKey(key)) return '[redacted]'
			if (typeof current === 'string') {
				const bounded = current.slice(0, Math.min(256, remainingCharacters))
				remainingCharacters -= bounded.length
				return sanitizePerformanceLabelValue(bounded)
			}
			if (typeof current === 'number') return Number.isFinite(current) ? current : undefined
			if (typeof current === 'boolean' || current === null) return current
			if (!current || typeof current !== 'object' || isRuntimeProxy(current) || depth >= 8 || remainingNodes-- <= 0) return undefined
			if (Array.isArray(current)) {
				const values: unknown[] = []
				let lengthDescriptor: PropertyDescriptor | undefined
				try { lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length') } catch { return undefined }
				const length = lengthDescriptor && 'value' in lengthDescriptor && Number.isSafeInteger(lengthDescriptor.value)
					? Math.min(32, lengthDescriptor.value as number) : 0
				for (let index = 0; index < length; index += 1) {
					let descriptor: PropertyDescriptor | undefined
					try { descriptor = Object.getOwnPropertyDescriptor(current, String(index)) } catch { return undefined }
					if (descriptor && 'value' in descriptor) values.push(capture(descriptor.value, key, depth + 1))
				}
				return Object.freeze(values)
			}
			let prototype: object | null
			try { prototype = Object.getPrototypeOf(current) as object | null } catch { return undefined }
			if (prototype !== Object.prototype && prototype !== null) return undefined
			const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
			let inspected = 0
			for (const childKey in current) {
				if (inspected >= 64) break
				let descriptor: PropertyDescriptor | undefined
				try { descriptor = Object.getOwnPropertyDescriptor(current, childKey) } catch { return undefined }
				if (!descriptor?.enumerable || !('value' in descriptor)) continue
				inspected += 1
				const captured = capture(descriptor.value, childKey, depth + 1)
				if (captured !== undefined) result[childKey] = captured
			}
			return Object.freeze(result)
		}
		const attributes = capture(resource.attributes, 'attributes', 0)
		if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
			throw new TypeError('Performance resource attributes must be bounded plain data')
		}
		Object.assign(result, {attributes})
	}
	return Object.freeze(result)
}

export async function createCustomPerformance(options: CustomPerformanceOptions): Promise<ManagedPerformance> {
	const configured = snapshotClosed(options, CUSTOM_FIELDS, 'Custom performance options')
	const rawBudgets = snapshotArray(configured.budgets ?? [], 100, 'Custom performance budgets')
	const budgets = rawBudgets.map((budget) =>
		snapshotClosed(budget, BUDGET_FIELDS, 'Custom performance budget') as unknown as BudgetConfig)
	const names = new Set<string>()
	for (const budget of budgets) {
		if (typeof budget.name !== 'string' || budget.name.length > 128 || names.has(budget.name)) {
			throw new Error('Performance budget names must be unique safe identifiers of at most 128 characters')
		}
		names.add(budget.name)
	}

	const n1Detection = configured.n1Detection === undefined ? undefined
		: snapshotClosed(configured.n1Detection, N1_FIELDS, 'Custom performance N+1 options') as unknown as N1DetectorOptions
	if (n1Detection && n1Detection.enabled !== true) throw new Error('N+1 detection must use enabled: true when configured')
	const monitoring = configured.runtimeMonitoring === undefined ? {}
		: snapshotClosed(configured.runtimeMonitoring, MONITOR_FIELDS, 'Custom performance runtime monitoring')
	for (const value of Object.values(monitoring)) if (typeof value !== 'boolean') throw new TypeError('Runtime monitoring switches must be booleans')

	const destinations = snapshotArray(configured.destinations ?? [], 2, 'Custom performance destinations')
		.map(snapshotDestination)
	const delivery = configured.delivery === undefined ? undefined
		: snapshotClosed(configured.delivery, DELIVERY_FIELDS, 'Custom performance delivery')
	if (delivery && destinations.length === 0) throw new Error('Performance delivery requires at least one destination')
	const retry = delivery?.retry === undefined ? undefined
		: snapshotClosed(delivery.retry, RETRY_FIELDS, 'Custom performance retry')

	const resource = snapshotResource(configured.resource)
	const monitoringEnabled = monitoring.eventLoop === true || monitoring.gc === true || monitoring.resources === true
	const [budgetModule, n1Module, exportModule, monitorModule] = await Promise.all([
		budgets.length > 0 ? import('../features/core/budget-engine') : undefined,
		n1Detection ? import('../features/db/n1-detector') : undefined,
		destinations.length > 0 ? import('../core/event-export-manager') : undefined,
		monitoringEnabled ? import('../core/runtime/monitors') : undefined
	])
	const handler = createBasePerformanceHandler({
		clock: configured.clock === undefined ? createSystemClock() : configured.clock as Clock,
		cardinalityLimit: 100,
		cardinalityMode: 'drop',
		enableEventLoopMonitor: monitoring.eventLoop === true,
		enableGCMonitor: monitoring.gc === true,
		enableResourceMonitor: monitoring.resources === true,
		...(monitorModule ? {createRuntimeMonitoring: (monitorOptions: Parameters<typeof monitorModule.createMonitors>[0]) => {
			const monitors = monitorModule.createMonitors(monitorOptions)
			return {stop: () => monitorModule.stopAllMonitors(monitors)}
		}} : {}),
		...(configured.errors ? {errors: configured.errors as Errors} : {}),
		...(configured.tracer ? {tracer: configured.tracer as Tracing} : {}),
		...((budgetModule || n1Module || exportModule) ? {createExtensions(dispatcher, clock) {
			const budgetEngine = budgetModule?.createBudgetEngine({
				now: clock.now,
				onViolation: (violation) => dispatcher.emit('onBudgetViolation', violation)
			})
			for (const budget of budgets) budgetEngine?.registerBudget(budget)
			const n1Detector = n1Module && n1Detection ? n1Module.createN1Detector(n1Detection) : undefined
			const exportManager = exportModule ? exportModule.createEventExportManager({
				exporters: destinations as Array<{name: string; exporter: PerformanceEventExporter}>,
				maxBufferCount: (delivery?.maxQueueRecords as number | undefined) ?? 1_000,
				maxBufferBytes: (delivery?.maxQueueBytes as number | undefined) ?? 1_048_576,
				flushIntervalMs: (delivery?.flushIntervalMs as number | undefined) ?? 1_000,
				retryAttempts: (retry?.attempts as number | undefined) ?? 2,
				retryBaseDelayMs: (retry?.baseDelayMs as number | undefined) ?? 100,
				operationTimeoutMs: (delivery?.operationTimeoutMs as number | undefined) ?? 5_000,
				observe: (name, value, labels) => dispatcher.emit('onSelfMetric', name, value, labels),
				...(configured.errors ? {errors: configured.errors as Errors} : {})
			}) : undefined
			return {
				onAcceptedEvent(event) {
					budgetEngine?.checkEvent(event)
					for (const pattern of n1Detector?.check(event) ?? []) dispatcher.emit('onN1Pattern', pattern)
					// Resource snapshots are emitted as gauges by the metrics bridge. Their
					// changing values must never become exported label dimensions.
					if (!isResourceSnapshotEvent(event.source, event.name)) {
						exportManager?.enqueue(toPerformanceEventRecord(event, resource))
					}
				},
				getBudgetStatus: (name) => budgetEngine?.getStatus(name),
				flush: async() => exportManager?.flush(),
				shutdown: async() => exportManager?.shutdown(),
				getExportStatus: () => exportManager?.getStatus() ?? {
					queueSize: 0, droppedTotal: 0, retriedTotal: 0, sinkState: 'healthy' as const
				}
			}
		}} : {})
	})
	try { registerPerformanceLifecycleCleanup(configured.lifecycle as LifecyclePort | undefined, handler) }
	catch(error) { return await failPerformanceSetup(handler, error) }
	return handler
}
