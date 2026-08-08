import type {PerformancePort} from '@ooopsstudio/core/ports/performance'
import {
	onCLS,
	onFCP,
	onINP,
	onLCP,
	onTTFB,
	type Metric
} from 'web-vitals'

import {captureSingleFlightCallback} from './callback-flight'
import {callBrowserMethod, classifyResourceType, getPerformanceObserver, isDynamicPathSegment, isSafeTelemetryLabelKey, resolveResourceUrl, supportsEntryType, type BrowserEventTarget} from './performance-browser-runtime'
import {capturePerformanceMethod, ignorePromiseRejection} from './performance-port-method'
import {isRuntimeProxy} from './runtime-object'

const captureBrowserPerformanceMethod = captureSingleFlightCallback(
	capturePerformanceMethod as (...args: never[]) => unknown
) as typeof capturePerformanceMethod

const MAX_ROUTE_INPUT_LENGTH = 2_048
const MAX_BROWSER_VALUE_LENGTH = 256
const MAX_ACTIVE_BROWSER_OBSERVERS = 100
const NOOP = (): void => {}

export type WebVitalMetric = 'LCP' | 'FCP' | 'CLS' | 'INP' | 'TTFB'

const webVitalReporters = new Set<(metric: Metric) => void>()
const initializedWebVitalSubscriptions = new Set<(callback: (metric: Metric) => void) => unknown>()
let activeLongTaskObservers = 0
let activeResourceFailureObservers = 0
let activeBrowserObserverStarts = 0
let activePageLoadMeasurements = 0

const isDynamicRouteSegment = (segment: string): boolean => {
	let decoded = segment
	try { decoded = decodeURIComponent(segment) } catch { /* malformed encodings remain opaque input */ }
	return decoded !== segment || !/^[a-z][a-z._~-]*$/i.test(decoded) || isDynamicPathSegment(decoded)
}

const publishWebVital = (metric: Metric): void => {
	for (const reporter of webVitalReporters) {
		try { reporter(metric) } catch { /* one consumer must not break the shared broker */ }
	}
}

export interface BrowserPerformanceOptions {
	performance?: PerformancePort
	route: string
	name?: string
	labels?: Record<string, string>
	now?: () => number
	startTime?: number
}

export interface BrowserInteractionOptions {
	performance?: PerformancePort
	route?: string
	labels?: Record<string, string>
	now?: () => number
}

export interface BrowserObserverOptions {
	performance?: PerformancePort
	route?: string | (() => string)
	hostKind?: string
	labels?: Record<string, string>
	/** Internal/custom event sink. Defaults to PerformancePort.record(). */
	recordEvent?: (name: string, value: number, labels: Record<string, string>) => void
}

export interface BrowserObserverStartOptions extends Omit<BrowserObserverOptions, 'recordEvent'> {
	preset: 'development' | 'production' | 'custom'
	webVitals?: boolean
	longTasks?: boolean
	resourceFailures?: boolean
	aggregationIntervalMs?: number
	maxAggregationKeys?: number
}

type BrowserAggregationBucket = {
	name: string
	labels: Record<string, string>
	count: number
	mean: number
	min: number
	max: number
}

const readDataOption = captureSingleFlightCallback(((value: unknown, key: PropertyKey): unknown => {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value)) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined
	} catch { return undefined }
}) as (...args: never[]) => unknown) as (value: unknown, key: PropertyKey) => unknown

const snapshotObserverOptions = (options: BrowserObserverOptions): BrowserObserverOptions => {
	const performance = readDataOption(options, 'performance')
	const route = readDataOption(options, 'route')
	const hostKind = readDataOption(options, 'hostKind')
	const labels = boundedBrowserLabels(readDataOption(options, 'labels') as Record<string, string> | undefined)
	const recordEvent = readDataOption(options, 'recordEvent')
	return {
		...(performance ? {performance: performance as PerformancePort} : {}),
		...(typeof route === 'function'
			? {route: captureSingleFlightCallback(route as (...args: never[]) => unknown) as () => string}
			: route !== undefined ? {route: route as string} : {}),
		...(typeof hostKind === 'string' && /^[a-z_.-]{1,63}$/i.test(hostKind) ? {hostKind} : {}),
		labels,
		...(typeof recordEvent === 'function' ? {
			recordEvent: captureSingleFlightCallback(
				recordEvent as (...args: never[]) => unknown
			) as NonNullable<BrowserObserverOptions['recordEvent']>
		} : {})
	}
}

export function normalizeClientRoute(route: string): string {
	if (typeof route !== 'string' || route.length > MAX_ROUTE_INPUT_LENGTH) {
		throw new Error('route max 2048')
	}
	const withoutOrigin = route.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]+/iu, '')
	const pathOnly = withoutOrigin.split(/[?#]/)[0]!
	const normalized = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`
	const parts = normalized.split('/').filter(Boolean).map((segment, index) => {
		if (segment.startsWith(':') || (segment.startsWith('[') && segment.endsWith(']'))) return segment
		return index > 0 || isDynamicRouteSegment(segment) ? ':id' : segment
	})
	return (parts.length === 0 ? '/' : `/${parts.join('/')}`).slice(0, MAX_BROWSER_VALUE_LENGTH)
}

const resolveRoute = (route?: string | (() => string)): string => {
	if (typeof route === 'function') {
		const result: unknown = route()
		ignorePromiseRejection(result)
		return typeof result === 'string' ? result : '/'
	}
	if (typeof route === 'string' && route.trim()) return route
	return '/'
}

const boundedBrowserLabels = (labels?: Record<string, string>): Record<string, string> => {
	const bounded: Record<string, string> = {}
	if (!labels || typeof labels !== 'object' || isRuntimeProxy(labels) || Array.isArray(labels)) return bounded
	try {
		const prototype = Object.getPrototypeOf(labels)
		if (prototype !== Object.prototype && prototype !== null) return bounded
		const keys = Reflect.ownKeys(labels)
		if (keys[20]) return bounded
		for (const key of keys) {
			if (typeof key !== 'string') return bounded
			const descriptor = Object.getOwnPropertyDescriptor(labels, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) continue
			const value = descriptor.value
			if (!isSafeTelemetryLabelKey(key) || typeof value !== 'string') continue
			bounded[key] = value.slice(0, MAX_BROWSER_VALUE_LENGTH)
		}
	} catch { /* malformed labels are omitted */ }
	return bounded
}

const buildBrowserLabels = (
	options: BrowserObserverOptions,
	kind: string,
	extra?: Record<string, string>
): Record<string, string> => ({
	...options.labels,
	runtime: 'browser',
	route: normalizeClientRoute(resolveRoute(options.route)),
	kind,
	...(options.hostKind ? {host_kind: options.hostKind} : {}),
	...boundedBrowserLabels(extra)
})

const recordDuration = (
	performance: PerformancePort | undefined,
	name: string,
	duration: number,
	labels: Record<string, string>
): void => {
	if (!Number.isFinite(duration) || duration < 0) return
	try {
		const record = captureBrowserPerformanceMethod(performance, 'record') as NonNullable<PerformancePort['record']> | undefined
		ignorePromiseRejection(record?.(name, duration, labels))
	} catch {
		// Browser performance observation must never break the host application.
	}
}

const emitBrowserEvent = (options: BrowserObserverOptions, name: string, value: number, labels: Record<string, string>): void => {
	ignorePromiseRejection(value)
	if (!Number.isFinite(value) || value < 0) return
	try {
		if (options.recordEvent) ignorePromiseRejection(options.recordEvent(name, value, labels) as unknown)
		else recordDuration(options.performance, name, value, labels)
	} catch {
		// Custom observation sinks must not break browser callbacks.
	}
}

const emitObservedBrowserEvent = (
	options: BrowserObserverOptions,
	name: string,
	value: number,
	kind: string,
	extra?: Record<string, string>
): void => emitBrowserEvent(options, name, value, buildBrowserLabels(options, kind, extra))

export function measurePageLoad(options: BrowserPerformanceOptions): void {
	if (activePageLoadMeasurements >= MAX_ACTIVE_BROWSER_OBSERVERS) return
	activePageLoadMeasurements += 1
	try {
		const configuredNow = readDataOption(options, 'now')
		const configuredStart = readDataOption(options, 'startTime')
		const startTime = typeof configuredStart === 'number' ? configuredStart : 0
		const configuredName = readDataOption(options, 'name')
		const observedNow: unknown = typeof configuredNow === 'function'
			? configuredNow() : callBrowserMethod(performance, 'now', [])
		ignorePromiseRejection(observedNow)
		if (typeof observedNow !== 'number') return
		const duration = Math.max(0, observedNow - startTime)
		recordDuration(
			readDataOption(options, 'performance') as PerformancePort | undefined,
			typeof configuredName === 'string' ? configuredName : 'browser.page_load',
			duration,
			{
				...boundedBrowserLabels(readDataOption(options, 'labels') as Record<string, string> | undefined),
				runtime: 'browser',
				route: normalizeClientRoute(readDataOption(options, 'route') as string),
				kind: 'page_load'
			}
		)
	} catch {
		// Page-load instrumentation is observational and must not break startup.
	} finally { activePageLoadMeasurements -= 1 }
}

const measureAsyncSafely = async<T>(
	measureAsync: NonNullable<PerformancePort['measureAsync']>,
	name: string,
	fn: () => Promise<T>,
	labels: Record<string, string>
): Promise<T> => {
	let operationPromise: Promise<T> | undefined
	const invokeOnce = (): Promise<T> => {
		operationPromise ??= Promise.resolve().then(fn)
		return operationPromise
	}
	try {
		const instrumentation = measureAsync(name, invokeOnce, labels)
		ignorePromiseRejection(instrumentation)
		// Give a conforming port one microtask to invoke its callback. Business
		// completion must never depend on a port that hangs or ignores the callback.
		await 0
	} catch {
		// Instrumentation failures are isolated. The authoritative operation
		// Promise below preserves completion, result, and failure semantics even
		// when a broken port invokes the callback without awaiting it.
	}
	return await invokeOnce()
}

const measureBrowserOperation = async<T>(
	fn: () => Promise<T>,
	options: BrowserPerformanceOptions | BrowserInteractionOptions,
	name: string,
	kind: 'navigation' | 'interaction',
	requireRoute: boolean
): Promise<T> => {
	if (activePageLoadMeasurements >= MAX_ACTIVE_BROWSER_OBSERVERS) return fn()
	activePageLoadMeasurements++
	let measureAsync: NonNullable<PerformancePort['measureAsync']> | undefined
	let labels: Record<string, string> | undefined
	try {
		const performance = readDataOption(options, 'performance') as PerformancePort | undefined
		measureAsync = captureBrowserPerformanceMethod(performance, 'measureAsync') as NonNullable<PerformancePort['measureAsync']> | undefined
		const configuredName = requireRoute && readDataOption(options, 'name')
		if (typeof configuredName === 'string') name = configuredName
		const route = readDataOption(options, 'route')
		labels = {
			...boundedBrowserLabels(readDataOption(options, 'labels') as Record<string, string> | undefined),
			runtime: 'browser',
			kind,
			...(typeof route === 'string'
				? {route: normalizeClientRoute(route)}
				: requireRoute ? {route: normalizeClientRoute(route as string)} : {})
		}
	} catch { /* malformed instrumentation falls back */ } finally { activePageLoadMeasurements-- }
	return measureAsync && labels
		? measureAsyncSafely(measureAsync, name, fn, labels)
		: fn()
}

export function measureNavigation<T>(
	fn: () => Promise<T>,
	options: BrowserPerformanceOptions
): Promise<T> {
	return measureBrowserOperation(fn, options, 'browser.navigation', 'navigation', true)
}

export function measureInteraction<T>(
	name: string,
	fn: () => Promise<T>,
	options: BrowserInteractionOptions = {}
): Promise<T> {
	return measureBrowserOperation(fn, options, name, 'interaction', false)
}

export function observeWebVitals(options: BrowserObserverOptions): () => void {
	if (webVitalReporters.size >= MAX_ACTIVE_BROWSER_OBSERVERS) return NOOP
	const reservation = (): void => {}
	webVitalReporters.add(reservation)
	const configured = snapshotObserverOptions(options)
	let active = true
	const reportMetric = captureSingleFlightCallback(((metric: Metric): void => {
		if (!active) {
			return
		}
		try {
			emitObservedBrowserEvent(configured, `browser.web_vital.${(metric.name as WebVitalMetric).toLowerCase()}`, metric.value, 'web-vital', {
				...(metric.rating ? {rating: metric.rating} : {}),
				...(metric.navigationType ? {navigation_type: metric.navigationType} : {})
			})
		} catch {
			// Malformed observer records are ignored.
		}
	}) as (...args: never[]) => unknown) as (metric: Metric) => void
	webVitalReporters.delete(reservation)
	webVitalReporters.add(reportMetric)

	for (const subscribe of [onLCP, onINP, onCLS, onFCP, onTTFB]) {
		if (initializedWebVitalSubscriptions.has(subscribe)) continue
		try {
			ignorePromiseRejection(subscribe(publishWebVital))
			initializedWebVitalSubscriptions.add(subscribe)
		} catch {
			// A missing/partial Web Vitals runtime must not break application startup.
		}
	}

	return () => {
		if (!active) return
		active = false
		webVitalReporters.delete(reportMetric)
	}
}

export function observeLongTasks(options: BrowserObserverOptions): () => void {
	if (activeLongTaskObservers >= MAX_ACTIVE_BROWSER_OBSERVERS) return NOOP
	activeLongTaskObservers += 1
	const configured = snapshotObserverOptions(options)
	const Observer = getPerformanceObserver()
	if (!Observer || !supportsEntryType('longtask')) {
		activeLongTaskObservers -= 1
		return NOOP
	}

	let observer: InstanceType<typeof Observer> | undefined
	let active = true
	const disconnect = (): void => {
		try { callBrowserMethod(observer, 'disconnect', []) } catch { /* best-effort cleanup */ }
	}
	try {
		observer = new Observer(captureSingleFlightCallback(((list: {getEntries(): Array<{duration: number; name?: string}>}) => {
			if (!active) return
			try {
				const entries = callBrowserMethod(list, 'getEntries', [])
				if (!Array.isArray(entries)) return
				for (let index = 0; index < MAX_BROWSER_VALUE_LENGTH; index++) {
					const entry = readDataOption(entries, index as never)
					if (!entry) return
					ignorePromiseRejection(entry)
					const duration = readDataOption(entry, 'duration') ?? Reflect.apply(
						Object.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'duration')!.get as never,
						entry, []
					)
					emitObservedBrowserEvent(
						configured, 'browser.long_task', duration as number, 'long_task'
					)
				}
			} catch {
				// Malformed observer records are ignored.
			}
		}) as (...args: never[]) => unknown) as ConstructorParameters<typeof Observer>[0])
		callBrowserMethod(observer, 'observe', [{type: 'longtask', buffered: true}])
	} catch {
		activeLongTaskObservers -= 1
		disconnect()
		return NOOP
	}
	return () => {
		if (!active) return
		active = false
		activeLongTaskObservers -= 1
		disconnect()
	}
}

export function observeResourceFailures(options: BrowserObserverOptions): () => void {
	if (activeResourceFailureObservers >= MAX_ACTIVE_BROWSER_OBSERVERS) return NOOP
	activeResourceFailureObservers += 1
	const configured = snapshotObserverOptions(options)
	const eventTarget = globalThis as BrowserEventTarget
	let active = true
	const listener = captureSingleFlightCallback(((event: Event): void => {
		if (!active) return
		try {
			const target: unknown = (event as {target?: unknown}).target
			ignorePromiseRejection(target)
			if (!target || typeof target !== 'object') {
				return
			}
			const resourceType = classifyResourceType(target as EventTarget)
			if (!resourceType) {
				return
			}
			emitObservedBrowserEvent(configured, 'browser.resource_failure', 1, 'resource_failure', {
				resource_type: resourceType,
				resource: resolveResourceUrl(target as EventTarget)
			})
		} catch {
			// Malformed DOM targets must not break the global error listener.
		}
	}) as (...args: never[]) => unknown) as (event: Event) => void
	const removeListener = (): void => {
		try { callBrowserMethod(eventTarget, 'removeEventListener', ['error', listener, true]) } catch { /* best-effort cleanup */ }
	}

	try {
		callBrowserMethod(eventTarget, 'addEventListener', ['error', listener, true])
	} catch {
		activeResourceFailureObservers -= 1
		removeListener()
		return NOOP
	}
	return () => {
		if (!active) return
		active = false
		activeResourceFailureObservers -= 1
		removeListener()
	}
}

export function startBrowserObservers(options: BrowserObserverStartOptions): () => void {
	if (activeBrowserObserverStarts >= MAX_ACTIVE_BROWSER_OBSERVERS) return NOOP
	activeBrowserObserverStarts += 1
	const preset = readDataOption(options, 'preset')
	if (preset !== 'development' && preset !== 'production' && preset !== 'custom') {
		activeBrowserObserverStarts -= 1
		throw new Error('Unknown browser performance preset')
	}
	const configured = snapshotObserverOptions(options)
	const buckets = new Map<string, BrowserAggregationBucket>()
	const aggregate = preset !== 'development'
	const configuredMaxKeys = readDataOption(options, 'maxAggregationKeys')
	const maxKeys = configuredMaxKeys === undefined ? 100 : configuredMaxKeys as number
	if (!Number.isInteger(maxKeys) || maxKeys <= 0 || maxKeys > 10_000) {
		activeBrowserObserverStarts -= 1
		throw new Error('maxAggregationKeys')
	}
	const configuredInterval = readDataOption(options, 'aggregationIntervalMs')
	const intervalMs = configuredInterval === undefined ? 10_000 : configuredInterval as number
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
		activeBrowserObserverStarts -= 1
		throw new Error('aggregationIntervalMs')
	}
	// Read every setup switch before subscribing so a hostile option accessor
	// cannot leave only a prefix of the observers installed.
	const enableWebVitals = readDataOption(options, 'webVitals') !== false
	const enableLongTasks = readDataOption(options, 'longTasks') !== false
	const enableResourceFailures = readDataOption(options, 'resourceFailures') !== false
	const emitBuckets = (pending: BrowserAggregationBucket[]): void => {
		for (const bucket of pending) {
			const labels = {...bucket.labels, rum_mode: 'aggregated'}
			recordDuration(configured.performance, `${bucket.name}.count`, bucket.count, labels)
			recordDuration(configured.performance, `${bucket.name}.min`, bucket.min, labels)
			recordDuration(configured.performance, `${bucket.name}.max`, bucket.max, labels)
			recordDuration(configured.performance, `${bucket.name}.avg`, bucket.mean, labels)
		}
	}
	const flush = (): void => {
		// Transfer ownership before invoking the external PerformancePort. A
		// record() callback can synchronously produce another browser sample; that
		// sample belongs to the next flush and must not be cleared with this batch.
		const pending = [...buckets.values()]
		buckets.clear()
		emitBuckets(pending)
	}
	const recordEvent = (name: string, value: number, labels: Record<string, string>): void => {
		if (!Number.isFinite(value) || value < 0) return
		if (!aggregate) {
			recordDuration(configured.performance, name, value, {...labels, rum_mode: 'full'})
			return
		}
		const key = `${name}:${JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)))}`
		let bucket = buckets.get(key)
		if (!bucket) {
			if (buckets.size >= maxKeys) {
				// Drain the full set before calling external record() methods, then
				// reserve the current sample. Re-entrant observations can safely join
				// this new bucket instead of being overwritten after the drain.
				const pending = [...buckets.values()]
				buckets.clear()
				bucket = {name, labels, count: 1, mean: value, min: value, max: value}
				buckets.set(key, bucket)
				emitBuckets(pending)
				return
			}
			bucket = {name, labels, count: 0, mean: 0, min: value, max: value}
			buckets.set(key, bucket)
		}
		bucket.count += 1
		bucket.mean += (value - bucket.mean) / bucket.count
		bucket.min = Math.min(bucket.min, value)
		bucket.max = Math.max(bucket.max, value)
	}
	const observerOptions = {...configured, recordEvent}
	const stops: Array<() => void> = []
	let timer: ReturnType<typeof setInterval> | undefined
	try {
		if (enableWebVitals) stops.push(observeWebVitals(observerOptions))
		if (enableLongTasks) stops.push(observeLongTasks(observerOptions))
		if (enableResourceFailures) stops.push(observeResourceFailures(observerOptions))
		if (aggregate && intervalMs > 0) {
			timer = setInterval(flush, intervalMs)
			try { timer.unref?.() } catch { /* optional Node timer optimization */ }
		}
	} catch {
		for (const stop of stops.reverse()) {
			try { stop() } catch { /* partial setup cleanup remains best-effort */ }
		}
		activeBrowserObserverStarts -= 1
		// Runtime observer/timer failures are optional instrumentation failures.
		// Validation above remains strict, but host startup must stay authoritative.
		return NOOP
	}
	let stopped = false

	return () => {
		if (stopped) return
		stopped = true
		activeBrowserObserverStarts -= 1
		try { if (timer !== undefined) clearInterval(timer) } catch { /* observer cleanup continues */ }
		for (const stop of stops) {
			try { stop() } catch { /* one observer must not block the remaining cleanup */ }
		}
		flush()
	}
}
