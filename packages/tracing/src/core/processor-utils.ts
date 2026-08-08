import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {
	captureNativePromiseResult,
	createNativePromise,
	deferNativePromise,
	raceNativePromises
} from '@ooopsstudio/core/runtime/async/native-promise'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'
import {isPlainObject} from '@ooopsstudio/core/utils/guards'

import type {SpanExporterPort, SpanExportResultPort} from '../types/ports'
import {captureCapability} from '../utils/capabilities'

import type {DeliveryObservableExporter, ProcessorObserver} from './processor-types'

const VALID_EXPORT_STATUSES = new Set(['success', 'partial', 'retryable', 'throttled', 'permanent-failure'])
const PROCESSOR_DRAIN_TIMEOUT_MS = 10_000
const PROCESSOR_SHUTDOWN_TIMEOUT_MS = 15_000
const MAX_SPAN_SNAPSHOT_STRING_UNITS = 16 * 1_024 * 1_024
const MAX_SPAN_SNAPSHOT_KEY_UNITS = 1_024
const nativeArrayIsArray = Array.isArray
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsInteger = Number.isInteger
const nativeObjectFreeze = Object.freeze
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeReflectApply = Reflect.apply
const nativeRegExpTest = RegExp.prototype.test
const nativeSetHas = Set.prototype.has
const nativeStringSlice = String.prototype.slice

export interface TimerOwnership {
	schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
	cancel(timer: ReturnType<typeof setTimeout>): void
}

export function captureTimerOwnership(): TimerOwnership {
	const schedule = globalThis.setTimeout
	const cancel = globalThis.clearTimeout
	return Object.freeze({
		schedule: (callback: () => void, delayMs: number) => nativeReflectApply(
			schedule, globalThis, [callback, delayMs]
		) as ReturnType<typeof setTimeout>,
		cancel: (timer: ReturnType<typeof setTimeout>) => {
			nativeReflectApply(cancel, globalThis, [timer])
		}
	})
}

export function clearTimerSafely(
	timer: ReturnType<typeof setTimeout> | undefined,
	ownership?: TimerOwnership
): void {
	if (!timer) return
	try { ownership ? ownership.cancel(timer) : clearTimeout(timer) } catch {
		try { timer.unref?.() } catch { /* best-effort timer cleanup */ }
	}
}

/** Invoke a caller-owned async capability without assimilating arbitrary thenables. */
export function invokeNativeAsync<T>(
	operation: () => unknown,
	label: string,
	allowSynchronousVoid = false
): Promise<T> {
	return deferNativePromise(() => adoptNativeAsyncResult<T>(operation(), label, allowSynchronousVoid))
}

/** Adopt an already-invoked capability while preserving its synchronous state transition. */
export function adoptNativeAsyncResult<T>(
	result: unknown,
	label: string,
	allowSynchronousVoid = false
): Promise<T> {
	if (allowSynchronousVoid && result === undefined) {
		return createNativePromise<T>((resolve) => { resolve(undefined as T) })
	}
	const completion = captureNativePromiseResult<T>(result)
	if (completion) return completion
	return createNativePromise<T>((_resolve, reject) => {
		reject(new TypeError(`${label} must return a native Promise`))
	})
}

/** Capture exporter methods once so late rewiring cannot change delivery semantics. */
export function captureSpanExporter(exporter: SpanExporterPort): SpanExporterPort {
	const exportSpans = captureCapability<Parameters<SpanExporterPort['export']>, ReturnType<SpanExporterPort['export']>>(
		exporter,
		'export'
	)
	const shutdown = captureCapability<Parameters<SpanExporterPort['shutdown']>, ReturnType<SpanExporterPort['shutdown']>>(
		exporter,
		'shutdown'
	)
	const flush = captureCapability<[], Promise<void>>(exporter, 'flush')
	const prepareShutdown = captureCapability<[], void>(exporter, 'prepareShutdown')
	if (!exportSpans || !shutdown) throw new Error('Tracing exporter must provide data-method export() and shutdown() capabilities')
	return Object.freeze({export: exportSpans, ...(flush ? {flush} : {}), ...(prepareShutdown ? {prepareShutdown} : {}), shutdown})
}

export function captureMetricsPort(metrics: MetricsPort | undefined): MetricsPort | undefined {
	const increment = captureCapability<Parameters<NonNullable<MetricsPort['increment']>>, ReturnType<NonNullable<MetricsPort['increment']>>>(metrics, 'increment')
	const record = captureCapability<Parameters<NonNullable<MetricsPort['record']>>, ReturnType<NonNullable<MetricsPort['record']>>>(metrics, 'record')
	return increment || record ? Object.freeze({...increment && {increment}, ...record && {record}}) : undefined
}

export function captureErrorsPort(errors: Errors | undefined): Errors | undefined {
	const report = captureCapability<Parameters<Errors['report']>, ReturnType<Errors['report']>>(errors, 'report')
	return report ? Object.freeze({report}) as Errors : undefined
}

export function captureProcessorObserver(observer: ProcessorObserver): ProcessorObserver {
	const onExported = captureCapability<Parameters<NonNullable<ProcessorObserver['onExported']>>, void>(observer, 'onExported')
	const onDropped = captureCapability<Parameters<NonNullable<ProcessorObserver['onDropped']>>, void>(observer, 'onDropped')
	const onExportFailure = captureCapability<Parameters<NonNullable<ProcessorObserver['onExportFailure']>>, void>(observer, 'onExportFailure')
	const onPartialDelivery = captureCapability<Parameters<NonNullable<ProcessorObserver['onPartialDelivery']>>, void>(observer, 'onPartialDelivery')
	const onRetry = captureCapability<Parameters<NonNullable<ProcessorObserver['onRetry']>>, void>(observer, 'onRetry')
	const onSinkState = captureCapability<Parameters<NonNullable<ProcessorObserver['onSinkState']>>, void>(observer, 'onSinkState')
	return Object.freeze({
		...onExported && {onExported},
		...onDropped && {onDropped},
		...onExportFailure && {onExportFailure},
		...onPartialDelivery && {onPartialDelivery},
		...onRetry && {onRetry},
		...onSinkState && {onSinkState}
	})
}

export function captureDeliveryObserverSetter(exporter: SpanExporterPort): DeliveryObservableExporter['setDeliveryObserver'] | undefined {
	return captureCapability<Parameters<DeliveryObservableExporter['setDeliveryObserver']>, void>(exporter, 'setDeliveryObserver')
}

/** Bound exporter finalization even when a custom implementation never settles. */
export async function waitForExporterShutdown(shutdown: Promise<void>, timers?: TimerOwnership): Promise<void> {
	return await waitForFinalization(shutdown, PROCESSOR_SHUTDOWN_TIMEOUT_MS, 'Tracing exporter shutdown timed out', timers)
}

/** Bound processor drain so exporter cleanup is still attempted after stalled I/O. */
export async function waitForProcessorDrain(drain: Promise<void>, timers?: TimerOwnership): Promise<void> {
	return await waitForFinalization(drain, PROCESSOR_DRAIN_TIMEOUT_MS, 'Tracing processor drain timed out', timers)
}

async function waitForFinalization(
	operation: Promise<void>, timeoutMs: number, message: string, timers = captureTimerOwnership()
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await raceNativePromises([
			operation,
			createNativePromise<never>((_resolve, reject) => {
				timer = timers.schedule(() => reject(new Error(message)), timeoutMs)
			})
		])
	} finally {
		clearTimerSafely(timer, timers)
	}
}

/** Snapshot exporter-owned outcome data once without executing accessors. */
export function snapshotSpanExportResult(value: unknown, maxAccepted: number): SpanExportResultPort {
	try {
		if (!value || typeof value !== 'object' || nativeArrayIsArray(value)) {
			throw new Error('Tracing exporter returned an invalid result')
		}
		const prototype = nativeObjectGetPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error('Tracing exporter returned an invalid result')
		}
		const read = (key: 'status' | 'acceptedCount' | 'retryAfterMs' | 'error'): unknown => {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
			if (!descriptor) return undefined
			if (!('value' in descriptor)) throw new Error('Tracing exporter returned an accessor-backed result')
			return descriptor.value
		}
		const status = read('status')
		const acceptedCount = read('acceptedCount')
		const retryAfterMs = read('retryAfterMs')
		const error = read('error')
		if (!nativeNumberIsInteger(acceptedCount) || (acceptedCount as number) < 0 || (acceptedCount as number) > maxAccepted) {
			throw new Error('Tracing exporter returned an invalid acceptedCount')
		}
		if (typeof status !== 'string' || !(nativeReflectApply(nativeSetHas, VALID_EXPORT_STATUSES, [status]) as boolean)) {
			throw new Error('Tracing exporter returned an invalid status')
		}
		if (retryAfterMs !== undefined && (!nativeNumberIsFinite(retryAfterMs) || (retryAfterMs as number) < 0
			|| (retryAfterMs as number) > 2_147_483_647)) {
			throw new Error('Tracing exporter returned an invalid retryAfterMs')
		}
		return nativeObjectFreeze({
			status: status as SpanExportResultPort['status'],
			acceptedCount: acceptedCount as number,
			...(retryAfterMs !== undefined ? {retryAfterMs: retryAfterMs as number} : {}),
			...(error !== undefined ? {error: normalizeTracingError(error, 'Tracing exporter reported a failure')} : {})
		})
	} catch(error) {
		throw normalizeTracingError(error, 'Tracing exporter returned an invalid result')
	}
}

export function normalizeTracingError(error: unknown, fallback = 'Tracing operation failed'): Error {
	let message = fallback
	let code: string | undefined
	try {
		if (typeof error === 'string') message = nativeReflectApply(nativeStringSlice, error, [0, 1_024]) as string
		else if (isErrorWithBoundedPrototype(error)) {
			const messageDescriptor = nativeObjectGetOwnPropertyDescriptor(error, 'message')
			if (messageDescriptor && 'value' in messageDescriptor && typeof messageDescriptor.value === 'string') {
				message = nativeReflectApply(nativeStringSlice, messageDescriptor.value, [0, 1_024]) as string
			}
			const codeDescriptor = nativeObjectGetOwnPropertyDescriptor(error, 'code')
			if (codeDescriptor && 'value' in codeDescriptor && typeof codeDescriptor.value === 'string' &&
				nativeReflectApply(nativeRegExpTest, /^[A-Z][A-Z0-9_]{1,63}$/u, [codeDescriptor.value]) as boolean) code = codeDescriptor.value
		}
	} catch { /* use the bounded fallback */ }
	const normalized = new Error(message) as Error & {code?: string}
	if (code) normalized.code = code
	return normalized
}

/** Avoid OrdinaryHasInstance walking an attacker-controlled prototype chain forever. */
function isErrorWithBoundedPrototype(value: unknown): value is Error {
	if (!value || typeof value !== 'object') return false
	try {
		let prototype: object | null = nativeObjectGetPrototypeOf(value) as object | null
		for (let depth = 0; prototype && depth < 32; depth++) {
			if (prototype === Error.prototype) return true
			prototype = nativeObjectGetPrototypeOf(prototype) as object | null
		}
	} catch { return false }
	return false
}

export function estimateSpanSize(span: SpanRecord): number {
	try {
		const snapshot = snapshotSpanRecord(span)
		return snapshot ? byteSize(JSON.stringify(snapshot)) : Number.POSITIVE_INFINITY
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

export function snapshotSpanRecord(span: SpanRecord): SpanRecord | undefined {
	try {
		const state = {nodes: 0, stringUnits: 0, ancestors: new Set<object>()}
		const snapshot = snapshotData(span, 0, state)
		return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
			? snapshot as SpanRecord
			: undefined
	} catch { return undefined }
}

function snapshotData(
	value: unknown,
	depth: number,
	state: {nodes: number; stringUnits: number; ancestors: Set<object>}
): unknown {
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'string') {
		// UTF-16 code units are a lower bound for the work and allocation needed
		// by JSON serialization and UTF-8 sizing. Reject an impossible-to-export
		// graph before either operation receives the attacker-controlled strings.
		if (value.length > MAX_SPAN_SNAPSHOT_STRING_UNITS - state.stringUnits) {
			throw new TypeError('oversized span string data')
		}
		state.stringUnits += value.length
		return value
	}
	if (typeof value === 'number') return Number.isFinite(value) ? value : null
	if (value === undefined) return undefined
	if (!value || typeof value !== 'object' || depth >= 32 || ++state.nodes > 100_000) throw new TypeError('unsafe span data')
	if (state.ancestors.has(value)) throw new TypeError('cyclic span data')
	state.ancestors.add(value)
	try {
		if (Array.isArray(value)) {
			const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
			const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
			if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) throw new TypeError('oversized span array')
			const result: unknown[] = []
			for (let index = 0; index < length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
				if (!descriptor) { result.push(null); continue }
				if (!('value' in descriptor)) throw new TypeError('accessor span data')
				result.push(snapshotData(descriptor.value, depth + 1, state) ?? null)
			}
			// Ignore custom array fields. Enumerating them would invoke a Proxy
			// ownKeys trap before any scan bound could take effect; indexed data was
			// already read through the bounded length snapshot above.
			return result
		}
		if (!isPlainObject(value)) throw new TypeError('non-plain span data')
		const result: Record<string, unknown> = {}
		let entries = 0
		for (const key in value) {
			if (++entries > 1_000) throw new TypeError('oversized span object')
			if (key.length > MAX_SPAN_SNAPSHOT_KEY_UNITS ||
				key.length > MAX_SPAN_SNAPSHOT_STRING_UNITS - state.stringUnits) {
				throw new TypeError('oversized span key data')
			}
			if (!Object.hasOwn(value, key)) continue
			state.stringUnits += key.length
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable) continue
			if (!('value' in descriptor)) throw new TypeError('accessor span data')
			if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
			const nested = snapshotData(descriptor.value, depth + 1, state)
			if (nested !== undefined) Object.defineProperty(result, key, {
				value: nested, enumerable: true, configurable: true, writable: true
			})
		}
		return result
	} finally { state.ancestors.delete(value) }
}
