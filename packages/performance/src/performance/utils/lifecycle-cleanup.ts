import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import type {PerformanceHandlerPort} from '../types/ports'

import {ignoreRuntimePromiseRejection, isRuntimeProxy} from './safe-object'

type LifecycleRegistrationMethod = 'registerFlushHook' | 'registerShutdownHook'

const captureLifecycleMethod = <K extends LifecycleRegistrationMethod>(
	lifecycle: LifecyclePort,
	key: K
): LifecyclePort[K] | undefined => {
	if (isRuntimeProxy(lifecycle)) return undefined
	try {
		let owner: object | null = lifecycle
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...args: never[]) => unknown
				return ((...args: never[]) => Reflect.apply(method, lifecycle, args)) as LifecyclePort[K]
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

/** Registers flush/shutdown hooks atomically and releases them after cleanup. */
export function registerPerformanceLifecycleCleanup(
	lifecycle: LifecyclePort | undefined,
	handler: PerformanceHandlerPort
): void {
	if (!lifecycle) return
	const registerFlushHook = captureLifecycleMethod(lifecycle, 'registerFlushHook')
	const registerShutdownHook = captureLifecycleMethod(lifecycle, 'registerShutdownHook')
	let disposers: Array<() => void> = []
	const addDisposer = (value: unknown): void => {
		if (typeof value === 'function') disposers.push(value as () => void)
		else ignoreRuntimePromiseRejection(value)
	}
	try {
		if (registerFlushHook && handler.flush) {
			addDisposer(registerFlushHook(
				'performance-export',
				async() => await handler.flush?.()
			))
		}
		if (registerShutdownHook && handler.shutdown) {
			addDisposer(registerShutdownHook(
				'runtime-monitors',
				async() => await handler.shutdown?.(),
				{name: 'performance-cleanup', priority: 30}
			))
		}
	} catch(error) {
		const cleanupErrors: unknown[] = []
		for (const disposer of disposers.reverse()) {
			try { ignoreRuntimePromiseRejection(disposer() as unknown) } catch(cleanupError) { cleanupErrors.push(cleanupError) }
		}
		disposers = []
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], 'Performance lifecycle registration rollback failed')
		}
		throw error
	}
	if (!handler.shutdown || disposers.length === 0) return
	const shutdown = handler.shutdown.bind(handler)
	handler.shutdown = async() => {
		await shutdown()
		const activeDisposers = disposers
		disposers = []
		for (const disposer of activeDisposers.reverse()) {
			try { ignoreRuntimePromiseRejection(disposer() as unknown) } catch {
				// Lifecycle deregistration must not make a completed cleanup fail.
			}
		}
	}
}

/** Preserves the setup failure when best-effort handler cleanup also fails. */
export async function failPerformanceSetup(
	handler: PerformanceHandlerPort,
	setupError: unknown
): Promise<never> {
	try {
		await handler.shutdown?.()
	} catch(cleanupError) {
		throw new AggregateError(
			[setupError, cleanupError],
			'Performance setup and cleanup failed'
		)
	}
	throw setupError
}
