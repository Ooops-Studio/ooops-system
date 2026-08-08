import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {captureErrorCapability} from '../utils/capabilities'

import type {ReportRuntime} from './report-types'

type LifecycleDisposer = () => void | Promise<void>

function disposeSafely(dispose: LifecycleDisposer): void {
	try {
		void Promise.resolve(dispose()).catch(() => undefined)
	} catch {
		// Lifecycle disposal is best-effort and must never leak a rejection.
	}
}

export function registerErrorLifecycleHooks(
	lifecycle: LifecyclePort | null | undefined,
	reportRuntime: Pick<ReportRuntime, 'flush' | 'shutdown'>
): () => Promise<void> {
	if (!lifecycle) return async() => undefined
	const disposers: LifecycleDisposer[] = []
	let active = false
	try {
		const registerFlushHook = captureErrorCapability(lifecycle, 'registerFlushHook') as LifecyclePort['registerFlushHook']
		const registerShutdownHook = captureErrorCapability(lifecycle, 'registerShutdownHook') as LifecyclePort['registerShutdownHook']
		const flushRegistration: unknown = registerFlushHook.call(
			lifecycle,
			'errors',
			async() => { if (active) await reportRuntime.flush() }
		)
		if (typeof flushRegistration === 'function') disposers.push(flushRegistration as LifecycleDisposer)
		const shutdownRegistration = registerShutdownHook.call(
			lifecycle,
			'observability',
			async() => { if (active) await reportRuntime.shutdown() },
			{name: 'errors'}
		)
		if (typeof shutdownRegistration === 'function') disposers.push(shutdownRegistration)
	} catch {
		active = false
		for (const dispose of disposers.splice(0)) disposeSafely(dispose)
		throw new Error('errors_lifecycle_registration_failed')
	}
	active = true

	return async() => {
		active = false
		const pending = [...disposers]
		const results = await Promise.allSettled(pending.map(async(dispose) => await dispose()))
		for (let index = results.length - 1; index >= 0; index--) {
			if (results[index]?.status === 'fulfilled') disposers.splice(index, 1)
		}
		const failures = results.filter((result) => result.status === 'rejected')
		if (failures.length === 1) throw new Error('Errors lifecycle disposal failed.')
		if (failures.length > 1) {
			throw new AggregateError(
				failures.map(() => new Error('Errors lifecycle disposer failed.')),
				'Errors lifecycle disposal failed.'
			)
		}
	}
}
