/**
 * @file Self-metrics utilities for services.
 * Provides safe metrics reporting with silent failure handling.
 */

import {AsyncLocalStorage} from 'node:async_hooks'

import type {MetricsPort} from '../ports/metrics'
import {
	containNativePromiseUnchecked,
	isolateUnexpectedThenable
} from '../runtime/async/native-promise'
import {
	addNativeSet,
	deleteNativeSet,
	deleteNativeWeakMap,
	getNativeWeakMap,
	hasNativeSet,
	setNativeWeakMap,
	sizeNativeSet
} from '../runtime/collections/native-collections'

import {hasSafePrototypeChain, isProxyObject} from './safe-object'

const activeMetricCalls = new WeakMap<object, Set<string>>()
const nativeReflectApply = Reflect.apply
const nativeObjectCreate = Object.create
const nativeObjectFreeze = Object.freeze
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const NativeSet = Set
const nativeObjectPrototype = Object.prototype
const nativeAsyncLocalStorageRun = AsyncLocalStorage.prototype.run
const nativeAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore
const metricInvocationContext = new AsyncLocalStorage<{metrics: object; operation: string}>()
type MetricMethod = (...args: unknown[]) => unknown
interface MetricCapabilities {
	readonly increment: MetricMethod | undefined
	readonly record: MetricMethod | undefined
}
const metricCapabilities = new WeakMap<object, MetricCapabilities>()
const EMPTY_METRIC_TAGS = nativeObjectFreeze(nativeObjectCreate(null)) as Record<string, string>

function containMetricTags(tags: unknown): void {
	containNativePromiseUnchecked(tags)
	if (!tags || typeof tags !== 'object' || !hasSafePrototypeChain(tags)) return
	try {
		let fields = 0
		for (const key in tags) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(tags, key)
			if (!descriptor) break
			if (++fields > 256) return
			if (descriptor && 'value' in descriptor) containNativePromiseUnchecked(descriptor.value)
		}
	} catch { /* Metrics remain best effort. */ }
}

function captureMetricMethod(metrics: object, key: 'increment' | 'record'): MetricMethod | undefined {
	if (isProxyObject(metrics)) return undefined
	let current: object | null = metrics
	try {
		for (let depth = 0; current && current !== nativeObjectPrototype && depth < 16; depth += 1) {
			if (isProxyObject(current)) return undefined
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, key)
			if (descriptor) {
				if (!('value' in descriptor)) return undefined
				containNativePromiseUnchecked(descriptor.value)
				return typeof descriptor.value === 'function' ? descriptor.value as MetricMethod : undefined
			}
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function getMetricCapabilities(metrics: object): MetricCapabilities {
	const existing = getNativeWeakMap(metricCapabilities, metrics)
	if (existing) return existing
	const captured = {
		increment: captureMetricMethod(metrics, 'increment'),
		record: captureMetricMethod(metrics, 'record')
	}
	setNativeWeakMap(metricCapabilities, metrics, captured)
	return captured
}

function invokeMetricSafely(
	metrics: MetricsPort | undefined,
	operation: string,
	invoke: (metrics: MetricsPort) => unknown
): void {
	containNativePromiseUnchecked(metrics)
	if (!metrics || (typeof metrics !== 'object' && typeof metrics !== 'function')) return
	try {
		const current = nativeReflectApply(
			nativeAsyncLocalStorageGetStore, metricInvocationContext, []
		) as {metrics: object; operation: string} | undefined
		if (current?.metrics === metrics && current.operation === operation) return
	} catch { return }
	let active = getNativeWeakMap(activeMetricCalls, metrics as object)
	if (!active) {
		active = new NativeSet<string>()
		setNativeWeakMap(activeMetricCalls, metrics as object, active)
	}
	// Metrics implementations commonly emit their own diagnostics. Suppress only
	// synchronous re-entry for the same destination/operation; later calls remain
	// observable and a different operation may still proceed.
	if (hasNativeSet(active, operation)) return
	addNativeSet(active, operation)
	try {
		const result = nativeReflectApply(nativeAsyncLocalStorageRun, metricInvocationContext, [
			{metrics: metrics as object, operation},
			() => invoke(metrics)
		])
		// MetricsPort methods are synchronous fire-and-forget capabilities. Observe
		// genuine native promise failures from permissive implementations, but never
		// assimilate an arbitrary caller-controlled thenable.
		isolateUnexpectedThenable(result)
	} catch(error) {
		containNativePromiseUnchecked(error)
		// Self-observability must never alter the owning service operation.
	} finally {
		deleteNativeSet(active, operation)
		if (sizeNativeSet(active) === 0) deleteNativeWeakMap(activeMetricCalls, metrics as object)
	}
}

/**
 * Get metrics port from provided parameter.
 * In token-based DI architecture, metrics must be explicitly provided.
 * @param provided - Optional provided metrics port
 * @returns Metrics port or undefined
 */
export function getMetricsPort(provided?: MetricsPort): MetricsPort | undefined {
	containNativePromiseUnchecked(provided)
	return provided
}

/**
 * Safely increment a metric with silent failure handling
 * @param metrics - Optional metrics port
 * @param name - Metric name
 * @param tags - Optional tags
 * @param count - Optional increment amount
 */
export function safeIncrement(
	metrics: MetricsPort | undefined,
	name: string,
	tags?: Record<string, string>,
	count?: number
): void {
	containNativePromiseUnchecked(name)
	containMetricTags(tags)
	containNativePromiseUnchecked(count)

	invokeMetricSafely(metrics, 'increment', (port) => {
		const increment = getMetricCapabilities(port as object).increment
		return increment ? nativeReflectApply(increment, port,
			count === undefined ? [name, tags ?? EMPTY_METRIC_TAGS] : [name, tags ?? EMPTY_METRIC_TAGS, count]) : undefined
	})
}

/**
 * Safely record a metric value with silent failure handling
 * @param metrics - Optional metrics port
 * @param name - Metric name
 * @param value - Metric value
 * @param tags - Optional tags
 */
export function safeRecord(
	metrics: MetricsPort | undefined,
	name: string,
	value: number,
	tags?: Record<string, string>
): void {
	containNativePromiseUnchecked(name)
	containNativePromiseUnchecked(value)
	containMetricTags(tags)

	invokeMetricSafely(metrics, 'record', (port) => {
		const record = getMetricCapabilities(port as object).record
		return record ? nativeReflectApply(record, port, [name, value, tags ?? EMPTY_METRIC_TAGS]) : undefined
	})
}
