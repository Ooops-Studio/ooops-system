/**
 * @file Shared lifecycle wiring for tracing presets.
 */
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {invokeNativeAsync} from '../core/processor-utils'
import {captureCapability} from '../utils/capabilities'
import {reportTracingFlushError, reportTracingShutdownError} from '../utils/on-error'
/** Register lifecycle hooks that report and surface finalization failures. */
export function registerTracingLifecycle(
	lifecycle: LifecyclePort | undefined,
	tracer: Tracing,
	errors: Errors | undefined,
	preset: string
): () => void {
	let disposeShutdown: (() => void) | undefined
	let disposeFlush: (() => void) | undefined
	try {
		const registerShutdownHook = captureCapability<Parameters<NonNullable<LifecyclePort['registerShutdownHook']>>, ReturnType<NonNullable<LifecyclePort['registerShutdownHook']>>>(lifecycle, 'registerShutdownHook')
		const registerFlushHook = captureCapability<Parameters<NonNullable<LifecyclePort['registerFlushHook']>>, ReturnType<NonNullable<LifecyclePort['registerFlushHook']>>>(lifecycle, 'registerFlushHook')
		const shutdown = captureCapability<[], Promise<void>>(tracer, 'shutdown')
		const forceFlush = captureCapability<[], Promise<void>>(tracer, 'forceFlush')
		if (registerShutdownHook) {
			const disposer = registerShutdownHook('observability', async() => {
				try {
					/* v8 ignore next -- defensive branch not constructible through the public tracing API */
					if (shutdown) await invokeNativeAsync<void>(shutdown, 'Tracing lifecycle shutdown', true)
				} catch(error) {
					reportTracingShutdownError(errors, error, {preset})
					throw error
				}
			}, {name: 'tracing-flush', priority: 20})
			if (typeof disposer === 'function') disposeShutdown = disposer
			else isolateUnexpectedThenable(disposer)
		}
		if (registerFlushHook) {
			const disposer = registerFlushHook('tracing', async() => {
				try {
					/* v8 ignore next -- defensive branch not constructible through the public tracing API */
					if (forceFlush) await invokeNativeAsync<void>(forceFlush, 'Tracing lifecycle flush', true)
				} catch(error) {
					reportTracingFlushError(errors, error, {preset})
					throw error
				}
			})
			if (typeof disposer === 'function') disposeFlush = disposer
			else isolateUnexpectedThenable(disposer)
		}
	} catch(error) {
		try { isolateUnexpectedThenable(disposeShutdown?.()) } catch { /* incomplete lifecycle wiring is best-effort cleaned up */ }
		throw error
	}
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		try { isolateUnexpectedThenable(disposeFlush?.()) } catch { /* lifecycle cleanup is best-effort */ }
		try { isolateUnexpectedThenable(disposeShutdown?.()) } catch { /* lifecycle cleanup is best-effort */ }
	}
}
