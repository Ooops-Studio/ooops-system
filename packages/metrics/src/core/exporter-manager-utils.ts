import {MAX_METRICS_TIMER_MS, METRICS_MAX_EXPORT_RECORDS} from '../constants'
import type {MetricExporterPort, MetricExportResult} from '../types/exporter'
import type {MetricRecord} from '../types/metric-record'
import {estimateBatchBytes} from '../utils/helpers'
import {snapshotMetricBatch, snapshotMetricRecord} from '../utils/metric-record-snapshot'

import {isMetricsOperationTimeoutError} from './operation-timeout'

type ExporterMethodName = 'export' | 'flush' | 'shutdown'
type ExporterMethod = (...args: unknown[]) => unknown

function inspectExporterMethod(
	value: MetricExporterPort,
	key: ExporterMethodName
): {readonly present: boolean; readonly method?: ExporterMethod} {
	let cursor: object | null = value as object
	const visited = new Set<object>()
	try {
		while (cursor && !visited.has(cursor) && visited.size < 32) {
			visited.add(cursor)
			const descriptor = Object.getOwnPropertyDescriptor(cursor, key)
			if (descriptor) return {
				present: true,
				...('value' in descriptor && typeof descriptor.value === 'function'
					? {method: descriptor.value as ExporterMethod}
					: {})
			}
			cursor = Object.getPrototypeOf(cursor)
		}
	} catch {
		return {present: true}
	}
	return {present: false}
}

/** Captures exporter capabilities once without invoking accessors. */
export function snapshotMetricExporter(exporter: MetricExporterPort): MetricExporterPort {
	if (!exporter || (typeof exporter !== 'object' && typeof exporter !== 'function')) {
		throw new Error('Each metrics exporter must provide export()')
	}
	const exportCapability = inspectExporterMethod(exporter, 'export')
	const flushCapability = inspectExporterMethod(exporter, 'flush')
	const shutdownCapability = inspectExporterMethod(exporter, 'shutdown')
	if (!exportCapability.method) throw new Error('Each metrics exporter must provide export()')
	if (flushCapability.present && !flushCapability.method) {
		throw new Error('Metrics exporter flush must be a function')
	}
	if (shutdownCapability.present && !shutdownCapability.method) {
		throw new Error('Metrics exporter shutdown must be a function')
	}
	let constructor: unknown
	try {
		const prototype = Object.getPrototypeOf(exporter as object) as object | null
		constructor = prototype
			? Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
			: undefined
	} catch { /* keep diagnostics anonymous */ }
	const safePrototype = Object.create(null) as object
	if (typeof constructor === 'function') {
		Object.defineProperty(safePrototype, 'constructor', {value: constructor})
	}
	Object.freeze(safePrototype)
	const stable = Object.create(safePrototype) as MetricExporterPort
	Object.defineProperties(stable, {
		export: {
			enumerable: true,
			value: async(batch: ReadonlyArray<MetricRecord>) =>
				await exportCapability.method!.call(exporter, batch) as void | MetricExportResult
		},
		...(flushCapability.method ? {flush: {
			enumerable: true,
			value: async() => { await flushCapability.method!.call(exporter) }
		}} : {}),
		...(shutdownCapability.method ? {shutdown: {
			enumerable: true,
			value: async() => { await shutdownCapability.method!.call(exporter) }
		}} : {})
	})
	return Object.freeze(stable)
}

export interface MetricsExportError extends Error {
	statusCode?: number
	retryable?: boolean
	code?: string
	retryAfterMs?: number
}

function readDataProperty(value: unknown, key: PropertyKey): unknown {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch {
		return undefined
	}
}

export function cloneMetricBatch(batch: ReadonlyArray<MetricRecord>): ReadonlyArray<MetricRecord> {
	return batch.map((record) => {
		const stable = snapshotMetricRecord(record)
		return {
			...stable,
			labels: {...stable.labels},
			...(stable.metadata ? {metadata: {...stable.metadata}} : {}),
			...(stable.exemplar ? {exemplar: {...stable.exemplar}} : {})
		}
	})
}

export function isPartialExportResult(result: void | MetricExportResult): result is MetricExportResult & {status: 'partial'} {
	return result !== undefined && readDataProperty(result, 'status') === 'partial'
}

export function stableSerialize(value: unknown, ancestors: ReadonlySet<object> = new Set()): string {
	if (value === undefined) return 'undefined'
	if (value === null) return 'null'
	if (typeof value === 'string') return JSON.stringify(value)
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	if (typeof value === 'number') {
		if (Number.isNaN(value)) return 'number:NaN'
		if (value === Number.POSITIVE_INFINITY) return 'number:Infinity'
		if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity'
		return Object.is(value, -0) ? '-0' : String(value)
	}
	if (typeof value === 'bigint') return `bigint:${value.toString()}`
	if (typeof value === 'symbol') return `symbol:${value.description ?? ''}`
	if (typeof value === 'function') {
		throw new Error('Metrics exporter record must expose stable data fields')
	}
	if (ancestors.has(value)) throw new Error('Metrics exporter record must not contain cyclic values')
	const nextAncestors = new Set(ancestors)
	nextAncestors.add(value)
	if (Array.isArray(value)) {
		let descriptors: Record<string, PropertyDescriptor>
		let symbolCount: number
		try {
			descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
			symbolCount = Object.getOwnPropertySymbols(value).length
		} catch {
			throw new Error('Metrics exporter record must expose stable data fields')
		}
		const length = descriptors.length?.value
		if (!Number.isSafeInteger(length) || length < 0 || length > METRICS_MAX_EXPORT_RECORDS
			|| symbolCount > 0
			|| Object.keys(descriptors).some((key) => key !== 'length'
				&& (key.length > 16 || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))
			|| Array.from({length}, (_, index) => descriptors[String(index)])
				.some((descriptor) => !descriptor || !descriptor.enumerable || !('value' in descriptor))) {
			throw new Error('Metrics exporter record must expose stable data fields')
		}
		return `[${Array.from({length}, (_, index) =>
			stableSerialize(descriptors[String(index)]!.value, nextAncestors)).join(',')}]`
	}
	const descriptors = Object.getOwnPropertyDescriptors(value)
	if (Object.getOwnPropertySymbols(value).length > 0
		|| Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
		throw new Error('Metrics exporter record must expose stable data fields')
	}
	return `{${Object.keys(descriptors)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(descriptors[key]?.value, nextAncestors)}`)
		.join(',')}}`
}

export function metricRecordIdentity(record: MetricRecord): string {
	return stableSerialize(record)
}

export function assertFailedRecordsSubset(
	batch: ReadonlyArray<MetricRecord>,
	failedRecords: ReadonlyArray<MetricRecord> | undefined,
	source: string
): asserts failedRecords is ReadonlyArray<MetricRecord> {
	let stableFailedRecords: ReadonlyArray<MetricRecord>
	try { stableFailedRecords = snapshotMetricBatch(failedRecords) } catch {
		throw new Error(`Metrics exporter ${source} must include a bounded stable failedRecords subset`)
	}
	if (stableFailedRecords.length === 0) {
		throw new Error(`Metrics exporter ${source} must include a non-empty failedRecords subset`)
	}

	const available = new Map<string, number>()
	for (const record of batch) {
		const identity = metricRecordIdentity(record)
		available.set(identity, (available.get(identity) ?? 0) + 1)
	}
	for (const record of stableFailedRecords) {
		const identity = metricRecordIdentity(record)
		const remaining = available.get(identity) ?? 0
		if (remaining === 0) {
			throw new Error(`Metrics exporter ${source} contains a failed record outside the exported batch`)
		}
		available.set(identity, remaining - 1)
	}
}

export function assertValidExportResult(
	result: void | MetricExportResult,
	batch: ReadonlyArray<MetricRecord>
): void | MetricExportResult {
	if (result === undefined) {
		return undefined
	}
	if (!result || typeof result !== 'object') {
		throw new Error('Metrics exporter returned an invalid export result')
	}
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	try {
		prototype = Object.getPrototypeOf(result)
		descriptors = Object.getOwnPropertyDescriptors(result)
		if (Object.getOwnPropertySymbols(result).length > 0) throw new Error()
	} catch {
		throw new Error('Metrics exporter result must expose stable data fields')
	}
	if ((prototype !== Object.prototype && prototype !== null)
		|| Object.entries(descriptors).some(([key, descriptor]) =>
			!['status', 'failedRecords', 'retryAfterMs'].includes(key)
			|| !descriptor.enumerable || !('value' in descriptor))) {
		throw new Error('Metrics exporter result must expose stable known data fields')
	}
	const status = descriptors.status?.value as unknown
	const failedRecords = descriptors.failedRecords?.value as ReadonlyArray<MetricRecord> | undefined
	const retryAfterMs = descriptors.retryAfterMs?.value as unknown
	if (status === 'success') {
		if (failedRecords !== undefined || retryAfterMs !== undefined) {
			throw new Error('Metrics exporter success result must not include failure metadata')
		}
		return Object.freeze({status: 'success'})
	}
	if (status === 'partial') {
		let stableFailedRecords: ReadonlyArray<MetricRecord>
		try { stableFailedRecords = snapshotMetricBatch(failedRecords) } catch {
			throw new Error('Metrics exporter partial result must include a bounded stable failedRecords subset')
		}
		assertFailedRecordsSubset(batch, stableFailedRecords, 'partial result')
		if (retryAfterMs !== undefined && (typeof retryAfterMs !== 'number'
			|| !Number.isFinite(retryAfterMs) || retryAfterMs < 0)) {
			throw new Error('Metrics exporter partial result retryAfterMs must be a non-negative finite number')
		}
		return Object.freeze({
			status: 'partial',
			failedRecords: stableFailedRecords,
			...(typeof retryAfterMs === 'number'
				? {retryAfterMs: Math.min(MAX_METRICS_TIMER_MS, retryAfterMs)} : {})
		})
	}
	throw new Error(`Metrics exporter returned unsupported export status "${
		typeof status === 'string' ? status.slice(0, 64) : `<${status === null ? 'null' : typeof status}>`
	}"`)
}

export function extractHttpStatus(error: unknown): number | undefined {

	if (error && typeof error === 'object') {
		const statusCode = readDataProperty(error, 'statusCode')
		if (typeof statusCode === 'number') {
			return statusCode
		}
		const status = readDataProperty(error, 'status')
		if (typeof status === 'number') {
			return status
		}
		const responseStatus = readDataProperty(readDataProperty(error, 'response'), 'status')
		if (typeof responseStatus === 'number') {
			return responseStatus
		}
	}

	if (error instanceof Error) {
		const message = readDataProperty(error, 'message')
		const match = typeof message === 'string' ? message.match(/\b(\d{3})\b/) : undefined
		if (match?.[1]) {
			return Number.parseInt(match[1], 10)
		}
	}

	return undefined
}

export function extractRetryAfterMs(error: unknown): number | undefined {
	if (error && typeof error === 'object') {
		const retryAfterMs = readDataProperty(error, 'retryAfterMs')
		if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
			return Math.min(MAX_METRICS_TIMER_MS, retryAfterMs)
		}
	}
	return undefined
}

export function extractFailedRecords(
	error: unknown,
	batch: ReadonlyArray<MetricRecord>
): ReadonlyArray<MetricRecord> {
	if (error && typeof error === 'object') {
		const failedRecords = readDataProperty(error, 'failedRecords') as ReadonlyArray<MetricRecord> | undefined
		if (failedRecords !== undefined) {
			let stableFailedRecords: ReadonlyArray<MetricRecord>
			try { stableFailedRecords = snapshotMetricBatch(failedRecords) } catch {
				throw new Error('Metrics exporter error must include a bounded stable failedRecords subset')
			}
			assertFailedRecordsSubset(batch, stableFailedRecords, 'error')
			return stableFailedRecords
		}
	}
	return batch
}

export function toExportError(error: unknown, fallbackMessage: string): Error {
	return error instanceof Error ? error : new Error(fallbackMessage)
}

export function isOperationTimeoutError(error: unknown, operation: 'flush' | 'shutdown'): boolean {
	return isMetricsOperationTimeoutError(error, `exporter-${operation}`)
}

export function isTransientFailure(error: unknown): boolean {
	const retryable = readDataProperty(error, 'retryable')
	if (typeof retryable === 'boolean') {
		return retryable
	}

	if (error instanceof Error) {
		const message = readDataProperty(error, 'message')
		if (typeof message === 'string' && (message.includes('ECONNREFUSED') ||
			message.includes('ETIMEDOUT') ||
			message.includes('ENOTFOUND') ||
			message.includes('ECONNRESET') ||
			message.includes('EAI_AGAIN'))) {
			return true
		}
	}

	const status = extractHttpStatus(error)
	return status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600)
}

export function isRetryableExportFailure(error: unknown): boolean {
	const retryable = readDataProperty(error, 'retryable')
	if (typeof retryable === 'boolean') {
		return retryable
	}
	const status = extractHttpStatus(error)
	if (status !== undefined) {
		return status === 408 || status === 429 || status >= 500
	}
	return true
}

export function toMetricsExportError(
	error: unknown,
	fallbackMessage: string,
	fallbackCode: string
): MetricsExportError {
	const originalMessage = error instanceof Error ? readDataProperty(error, 'message') : undefined
	const typed = new Error(
		typeof originalMessage === 'string' ? originalMessage : fallbackMessage,
		{cause: error}
	) as MetricsExportError & {failedRecords?: ReadonlyArray<MetricRecord>}
	const statusCode = extractHttpStatus(error)
	if (statusCode !== undefined) typed.statusCode = statusCode
	const retryAfterMs = extractRetryAfterMs(error)
	if (retryAfterMs !== undefined) typed.retryAfterMs = retryAfterMs
	const explicitRetryable = readDataProperty(error, 'retryable')
	typed.retryable = typeof explicitRetryable === 'boolean'
		? explicitRetryable
		: isRetryableExportFailure(error)
	const explicitCode = readDataProperty(error, 'code')
	typed.code = typeof explicitCode === 'string' && explicitCode.length > 0
		? explicitCode
		: statusCode !== undefined ? `http_${statusCode}` : fallbackCode
	const failedRecords = readDataProperty(error, 'failedRecords') as ReadonlyArray<MetricRecord> | undefined
	if (failedRecords !== undefined) typed.failedRecords = failedRecords
	return typed
}

export function splitMetricBatch(
	batch: ReadonlyArray<MetricRecord>,
	maxBatchSize: number,
	maxBatchBytes: number
): ReadonlyArray<ReadonlyArray<MetricRecord>> {
	if (batch.length === 0) return []
	const chunks: MetricRecord[][] = []
	let current: MetricRecord[] = []
	let currentBytes = 0
	for (const record of batch) {
		const bytes = estimateBatchBytes([record])
		if (bytes > maxBatchBytes) {
			throw Object.assign(new Error('Metric record exceeds exporter maxBatchBytes'), {
				code: 'metric_record_too_large', retryable: false
			})
		}
		if (current.length >= maxBatchSize || (currentBytes + bytes > maxBatchBytes && current.length > 0)) {
			chunks.push(current); current = []; currentBytes = 0
		}
		current.push(record); currentBytes += bytes
	}
	if (current.length) chunks.push(current)
	return chunks.length ? chunks : [batch]
}
