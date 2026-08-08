import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ResiliencePolicyDefinition} from '@ooopsstudio/core/contracts/resilience'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {PerformancePort} from '@ooopsstudio/core/ports/performance'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createManagedResilienceRuntime} from '../core/managed-runtime'
import {copyDataDescriptorValues, getPlainDataDescriptors} from '../utils/data-object'

import type {ManagedResilience} from './types'

export interface StandardResilienceOptions {
	readonly clock?: Clock
	readonly policies?: readonly ResiliencePolicyDefinition[]
	readonly logger?: Logging
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly tracer?: Tracing
	readonly performance?: PerformancePort
	readonly lifecycle?: LifecyclePort
}

const KEYS = new Set(['clock', 'policies', 'logger', 'errors', 'metrics', 'tracer', 'performance', 'lifecycle'])

export function snapshotStandardOptions(value: unknown, extraKeys: readonly string[] = []): Record<string, unknown> {
	if (value === undefined) return Object.freeze(Object.create(null))
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Resilience options must be a plain data object')
	const allowed = new Set([...KEYS, ...extraKeys])
	const descriptors = getPlainDataDescriptors(value, allowed.size)
	if (!descriptors) throw new TypeError('Invalid resilience options')
	if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key) || !descriptors[key]?.enumerable || !('value' in descriptors[key]!))) throw new TypeError('Resilience options contain unexpected or unsafe fields')
	return Object.freeze(copyDataDescriptorValues(descriptors))
}

export function createStandardResilience(options: StandardResilienceOptions = {}): ManagedResilience {
	const snapshot = snapshotStandardOptions(options) as StandardResilienceOptions
	return createManagedResilienceRuntime({
		clock: snapshot.clock === undefined ? createSystemClock() : snapshot.clock,
		...(snapshot.policies !== undefined ? {policies: snapshot.policies} : {}),
		...(snapshot.logger !== undefined ? {logger: snapshot.logger} : {}),
		...(snapshot.errors !== undefined ? {errors: snapshot.errors} : {}),
		...(snapshot.metrics ? {metrics: snapshot.metrics} : {}),
		...(snapshot.tracer !== undefined ? {tracer: snapshot.tracer} : {}),
		...(snapshot.performance ? {performance: snapshot.performance} : {}),
		...(snapshot.lifecycle !== undefined ? {lifecycle: snapshot.lifecycle} : {})
	})
}
