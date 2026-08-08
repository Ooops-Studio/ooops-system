/**
 * @file Internal lifecycle wiring helpers for metrics handlers.
 */

import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'

import type {MetricsHandlerPort} from '../types/ports'
import {getLogger, isSafeLogger} from '../utils/logger'

const METRICS_LIFECYCLE_WIRED = Symbol.for('@ooopsstudio/metrics/lifecycle-wired')

type LifecycleManagedMetrics = MetricsHandlerPort & {
	[METRICS_LIFECYCLE_WIRED]?: true
}

function captureLifecycleMethod(
	lifecycle: LifecyclePort,
	key: 'registerShutdownHook' | 'registerFlushHook'
): ((...args: unknown[]) => unknown) | undefined {
	let cursor: object | null = lifecycle as object
	const visited = new Set<object>()
	try {
		while (cursor && !visited.has(cursor) && visited.size < 32) {
			visited.add(cursor)
			const descriptor = Object.getOwnPropertyDescriptor(cursor, key)
			if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function'
				? descriptor.value as (...args: unknown[]) => unknown : undefined
			cursor = Object.getPrototypeOf(cursor)
		}
	} catch { /* invalid capability */ }
	return undefined
}

export interface MetricsLifecycleWiringOptions {
	readonly onError?: (error: unknown, context?: Record<string, string>) => void
	readonly logger?: Logging
}

export function hasManagedMetricsLifecycle(metrics: unknown): metrics is LifecycleManagedMetrics {
	return Boolean(
		metrics &&
		typeof metrics === 'object' &&
		Reflect.get(metrics, METRICS_LIFECYCLE_WIRED) === true
	)
}

export async function wireMetricsLifecycle(
	handler: MetricsHandlerPort,
	lifecycle?: LifecyclePort,
	options: MetricsLifecycleWiringOptions = {}
): Promise<MetricsHandlerPort> {
	if (!lifecycle || hasManagedMetricsLifecycle(handler)) {
		return handler
	}
	const stableLogger = isSafeLogger(options.logger) ? getLogger(options.logger) : undefined
	const shutdownCapability = captureLifecycleMethod(lifecycle, 'registerShutdownHook')
	const flushCapability = captureLifecycleMethod(lifecycle, 'registerFlushHook')

	const observeLifecycleHookFailure = (operation: string, error: unknown): void => {
		try {
			options.onError?.(error, {operation})
		} catch {
			// Diagnostics must never replace the lifecycle finalization failure.
		}
		try {
			stableLogger?.warn('metrics.lifecycle_hook_failed', {
				operation,
				error: 'metrics_lifecycle_hook_failed'
			})
		} catch {
			// A custom logger is an observer, not part of the hook's outcome.
		}
	}
	const runLifecycleHook = async(operation: string, action: () => Promise<void>): Promise<void> => {
		try {
			await action()
		} catch(error) {
			observeLifecycleHookFailure(operation, error)
			throw error
		}
	}
	let active = false
	const hookDisposers: Array<() => void> = []
	const retainDisposer = (value: unknown): void => {
		if (typeof value !== 'function') {
			throw new Error('Lifecycle registration must return a disposer')
		}
		hookDisposers.push(value as () => void)
	}
	const deactivate = (): void => {
		active = false
		for (const dispose of hookDisposers.splice(0).reverse()) {
			try {
				dispose()
			} catch(error) {
				observeLifecycleHookFailure('dispose', error)
			}
		}
	}
	const originalShutdown = handler.shutdown

	try {
		if (!shutdownCapability || !flushCapability) {
			throw new Error('Requires stable shutdown and flush registration functions')
		}
		const shutdownDisposer = Reflect.apply(shutdownCapability, lifecycle, ['observability', async() => {
			if (!active) return
			await runLifecycleHook('shutdown', async() => {
				await handler.shutdown?.()
			})
		}, {priority: 5}])
		retainDisposer(shutdownDisposer)

		const flushDisposer = Reflect.apply(flushCapability, lifecycle, ['metrics', async() => {
			if (!active) return
			await runLifecycleHook('flush', async() => {
				await handler.flush?.()
			})
		}])
		retainDisposer(flushDisposer)

		if (originalShutdown) {
			handler.shutdown = async() => {
				await originalShutdown.call(handler)
				deactivate()
			}
		}
		Object.defineProperty(handler, METRICS_LIFECYCLE_WIRED, {
			value: true,
			enumerable: false,
			configurable: false
		})
		active = true
	} catch(error) {
		deactivate()
		if (originalShutdown) try { handler.shutdown = originalShutdown } catch { /* rollback best-effort */ }
		try { await originalShutdown?.call(handler) } catch(cleanupError) {
			observeLifecycleHookFailure('wiring-cleanup', cleanupError)
		}
		throw error
	}
	return handler
}
