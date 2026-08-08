import {recordPerformanceMetric} from '@ooopsstudio/sdk/performance'

import {buildBrowserLabels, mergeLabels, resolveSvelteRoute} from './labels'
import {snapshotAdapterOptions} from './options'
import type {MetricsContextOptions} from './types'

type ListenerOptions = boolean | globalThis.AddEventListenerOptions | undefined
type EventListenerLike = globalThis.EventListenerOrEventListenerObject
type DomElement = globalThis.Element
type VisibilityObserver = InstanceType<typeof globalThis.IntersectionObserver>

export interface MetricActionOptions extends MetricsContextOptions {
	name: string
	eventLabel?: string
	once?: boolean
	listenerOptions?: ListenerOptions
}

export interface VisibleActionOptions extends MetricActionOptions {
	threshold?: number
	rootMargin?: string
	fallback?: 'noop' | 'record'
}

export interface ActionHandle<TOptions> {
	update(nextOptions: TOptions): void
	destroy(): void
}

type EventTargetLike = {
	addEventListener(type: string, listener: EventListenerLike, options?: ListenerOptions): void
	removeEventListener(type: string, listener: EventListenerLike, options?: ListenerOptions): void
}

const ACTION_OPTION_KEYS: readonly (keyof VisibleActionOptions)[] = [
	'performance', 'tracing', 'route', 'labels', 'name', 'eventLabel', 'once',
	'listenerOptions', 'threshold', 'rootMargin', 'fallback'
]

const snapshotActionOptions = <TOptions extends MetricActionOptions>(options: TOptions): TOptions =>
	snapshotAdapterOptions(options, ACTION_OPTION_KEYS as readonly (keyof TOptions)[])

const recordAction = (
	options: MetricActionOptions,
	kind: string
): void => {
	try {
		recordPerformanceMetric(
			options.performance,
			options.name,
			1,
			buildBrowserLabels(
				kind,
				resolveSvelteRoute(undefined, undefined, options.route),
				mergeLabels(options.labels, options.eventLabel ? {event: options.eventLabel} : undefined)
			)
		)
	} catch {
		// DOM instrumentation must never escape into application event handling.
	}
}

const bindMetricAction = (
	node: EventTargetLike,
	eventName: string,
	kind: string,
	initialOptions: MetricActionOptions
): ActionHandle<MetricActionOptions> => {
	let options = snapshotActionOptions(initialOptions)
	const listener = () => {
		recordAction(options, kind)
		if (options.once) {
			try { node.removeEventListener(eventName, listener, options.listenerOptions) } catch {
				// DOM instrumentation cleanup is best-effort.
			}
		}
	}
	const remove = () => {
		try { node.removeEventListener(eventName, listener, options.listenerOptions) } catch {
			// DOM instrumentation cleanup is best-effort.
		}
	}
	const add = () => {
		try { node.addEventListener(eventName, listener, options.listenerOptions) } catch {
			// DOM instrumentation setup is best-effort.
		}
	}

	add()

	return {
		update(nextOptions) {
			remove()
			options = snapshotActionOptions(nextOptions)
			add()
		},
		destroy() {
			remove()
		}
	}
}

export function measureClick(
	node: EventTargetLike,
	options: MetricActionOptions
): ActionHandle<MetricActionOptions> {
	return bindMetricAction(node, 'click', 'click', options)
}

export function measureSubmit(
	node: EventTargetLike,
	options: MetricActionOptions
): ActionHandle<MetricActionOptions> {
	return bindMetricAction(node, 'submit', 'submit', options)
}

export function measureVisible(
	node: DomElement,
	initialOptions: VisibleActionOptions
): ActionHandle<VisibleActionOptions> {
	let options = snapshotActionOptions(initialOptions)
	let observer: VisibilityObserver | undefined

	const connect = () => {
		let Observer: typeof globalThis.IntersectionObserver | undefined
		try { Observer = globalThis.IntersectionObserver } catch { Observer = undefined }
		if (typeof Observer !== 'function') {
			try { if (options.fallback === 'record') recordAction(options, 'visible') } catch { /* fail open */ }
			return
		}
		try { observer = new Observer((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) {
					continue
				}
				recordAction(options, 'visible')
				if (options.once !== false) {
					try { observer?.disconnect() } catch { /* fail-open observer cleanup */ }
					break
				}
			}
		}, {
			...(options.threshold !== undefined ? {threshold: options.threshold} : {}),
			...(options.rootMargin ? {rootMargin: options.rootMargin} : {})
		})
		observer.observe(node)
		} catch {
			try { observer?.disconnect() } catch { /* best-effort cleanup */ }
			observer = undefined
		}
	}

	connect()

	return {
		update(nextOptions) {
			try { observer?.disconnect() } catch { /* best-effort cleanup */ }
			options = snapshotActionOptions(nextOptions)
			connect()
		},
		destroy() {
			try { observer?.disconnect() } catch { /* best-effort cleanup */ }
		}
	}
}
