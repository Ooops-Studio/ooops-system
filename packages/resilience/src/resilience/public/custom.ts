import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createCustomFallbackStage} from '../core/custom-fallback'
import {createManagedResilienceRuntime} from '../core/managed-runtime'
import {captureCapability, captureClock} from '../utils/capabilities'

import {snapshotStandardOptions, type StandardResilienceOptions} from './standard'
import type {ManagedResilience, ResilienceClassifierRegistry, ResilienceFallbackRegistry} from './types'

export interface CustomResilienceOptions extends StandardResilienceOptions {
	readonly classifiers?: ResilienceClassifierRegistry
	readonly fallbacks?: ResilienceFallbackRegistry
}

export function createCustomResilience(options: CustomResilienceOptions): ManagedResilience {
	const snapshot = snapshotStandardOptions(options, ['classifiers', 'fallbacks']) as CustomResilienceOptions
	const clock = captureClock(snapshot.clock === undefined ? createSystemClock() : snapshot.clock)
	const registerShutdownHook = captureCapability<never[], unknown>(snapshot.lifecycle, 'registerShutdownHook')
	if (snapshot.lifecycle !== undefined && !registerShutdownHook) throw new TypeError('Invalid port')
	const lifecycle = registerShutdownHook ? Object.freeze({registerShutdownHook}) : undefined
	const fallbackStage = snapshot.fallbacks === undefined ? undefined : createCustomFallbackStage(snapshot.fallbacks)
	return createManagedResilienceRuntime({
		clock,
		...(snapshot.policies !== undefined ? {policies: snapshot.policies} : {}),
		...(snapshot.classifiers !== undefined ? {classifiers: snapshot.classifiers} : {}),
		...(fallbackStage ? {fallbackStage} : {}),
		...(snapshot.logger !== undefined ? {logger: snapshot.logger} : {}),
		...(snapshot.errors !== undefined ? {errors: snapshot.errors} : {}),
		...(snapshot.metrics ? {metrics: snapshot.metrics} : {}),
		...(snapshot.tracer !== undefined ? {tracer: snapshot.tracer} : {}),
		...(snapshot.performance ? {performance: snapshot.performance} : {}),
		...(lifecycle ? {lifecycle: lifecycle as never} : {})
	})
}
