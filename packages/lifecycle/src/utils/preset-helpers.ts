import {createMonotonicClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {
	DEFAULT_DEPENDENCY_GROUPS,
	DEFAULT_DRAIN_GRACE_PERIOD_MS_DEV,
	DEFAULT_DRAIN_GRACE_PERIOD_MS_PROD,
	DEFAULT_HEALTH_CHECK_INTERVAL_MS_DEV,
	DEFAULT_HEALTH_CHECK_INTERVAL_MS_PROD,
	DEFAULT_HEALTH_CONCURRENCY,
	DEFAULT_HOOK_TIMEOUT_MS,
	DEFAULT_INIT_TIMEOUT_MS_DEV,
	DEFAULT_INIT_TIMEOUT_MS_PROD,
	DEFAULT_SHUTDOWN_TIMEOUT_MS_DEV,
	DEFAULT_SHUTDOWN_TIMEOUT_MS_PROD,
	DEFAULT_WARM_TIMEOUT_MS_DEV,
	DEFAULT_WARM_TIMEOUT_MS_PROD
} from '../constants'
import {
	boundedInteger,
	boundedTimer,
	captureClock,
	snapshotRecord,
	snapshotResource
} from '../core/lifecycle-handler-validation'
import type {
	CustomLifecycleOptions,
	ResolvedLifecycleOptions,
	StandardLifecycleOptions
} from '../types/lifecycle'

const STANDARD_FIELDS = new Set(['resource', 'observability'])
const CUSTOM_FIELDS = new Set(['clock', 'monotonicClock', 'resource', 'observability', 'startup', 'shutdown', 'health'])
const STARTUP_FIELDS = new Set(['initTimeoutMs', 'warmTimeoutMs'])
const SHUTDOWN_FIELDS = new Set(['timeoutMs', 'hookTimeoutMs', 'flushTimeoutMs', 'drainGracePeriodMs', 'groups'])
const HEALTH_FIELDS = new Set(['intervalMs', 'checkTimeoutMs', 'runTimeoutMs', 'concurrency'])
const OBSERVABILITY_FIELDS = new Set(['errors', 'logger', 'metrics', 'tracer', 'selfMetrics'])

function snapshotObservability(value: unknown): ResolvedLifecycleOptions['observability'] {
	if (value === undefined) return undefined
	const record = snapshotRecord(value, 'Lifecycle observability options', OBSERVABILITY_FIELDS)
	if (record.selfMetrics !== undefined && typeof record.selfMetrics !== 'boolean') {
		throw new Error('Lifecycle observability selfMetrics must be a boolean')
	}
	return Object.freeze({...record}) as ResolvedLifecycleOptions['observability']
}

function validateGroups(value: unknown): readonly string[] {
	if (value === undefined) return Object.freeze([...DEFAULT_DEPENDENCY_GROUPS])
	if (!Array.isArray(value)) throw new Error('Lifecycle shutdown groups must be an array')
	let length = -1
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
		if (descriptor && 'value' in descriptor && Number.isSafeInteger(descriptor.value)) length = descriptor.value as number
	} catch { /* invalid below */ }
	if (length < 0 || length > 64) throw new Error('Lifecycle shutdown groups are invalid')
	const groups: string[] = []
	for (let index = 0; index < length; index++) {
		let group: unknown
		try {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			group = descriptor && 'value' in descriptor ? descriptor.value : undefined
		} catch { throw new Error('Lifecycle shutdown groups must contain stable strings') }
		if (typeof group !== 'string' || !group.trim() || group.length > 128 || group !== group.trim()) {
			throw new Error('Lifecycle shutdown group is invalid')
		}
		groups.push(group)
	}
	if (new Set(groups).size !== groups.length) throw new Error('Lifecycle shutdown groups must be unique')
	return Object.freeze(groups)
}

function resolved(
	input: CustomLifecycleOptions,
	defaults: {
		init: number
		warm: number
		shutdown: number
		drain: number
		health: number
	}
): ResolvedLifecycleOptions {
	const root = snapshotRecord(input, 'Lifecycle options', CUSTOM_FIELDS)
	const startup = root.startup === undefined ? {} : snapshotRecord(root.startup, 'Lifecycle startup options', STARTUP_FIELDS)
	const shutdown = root.shutdown === undefined ? {} : snapshotRecord(root.shutdown, 'Lifecycle shutdown options', SHUTDOWN_FIELDS)
	const health = root.health === undefined ? {} : snapshotRecord(root.health, 'Lifecycle health options', HEALTH_FIELDS)
	const clock = captureClock(root.clock, 'Lifecycle clock')
	const monotonicClock = root.monotonicClock === undefined
		? createMonotonicClock()
		: captureClock(root.monotonicClock, 'Lifecycle monotonicClock')
	const hookTimeoutMs = boundedTimer(shutdown.hookTimeoutMs, DEFAULT_HOOK_TIMEOUT_MS, 'Lifecycle hook timeout')
	const resource = snapshotResource(root.resource)
	const observability = snapshotObservability(root.observability)
	return Object.freeze({
		clock,
		monotonicClock,
		...(resource ? {resource} : {}),
		...(observability ? {observability} : {}),
		initTimeoutMs: boundedTimer(startup.initTimeoutMs, defaults.init, 'Lifecycle init timeout'),
		warmTimeoutMs: boundedTimer(startup.warmTimeoutMs, defaults.warm, 'Lifecycle warm timeout'),
		shutdownTimeoutMs: boundedTimer(shutdown.timeoutMs, defaults.shutdown, 'Lifecycle shutdown timeout'),
		hookTimeoutMs,
		flushTimeoutMs: boundedTimer(shutdown.flushTimeoutMs, hookTimeoutMs, 'Lifecycle flush timeout'),
		drainGracePeriodMs: boundedTimer(shutdown.drainGracePeriodMs, defaults.drain, 'Lifecycle drain grace period'),
		shutdownGroups: validateGroups(shutdown.groups),
		healthIntervalMs: boundedTimer(health.intervalMs, defaults.health, 'Lifecycle health interval'),
		healthCheckTimeoutMs: boundedTimer(health.checkTimeoutMs, defaults.health, 'Lifecycle health check timeout'),
		healthRunTimeoutMs: boundedTimer(health.runTimeoutMs, defaults.health, 'Lifecycle health run timeout'),
		healthConcurrency: boundedInteger(health.concurrency, DEFAULT_HEALTH_CONCURRENCY, 1, 16, 'Lifecycle health concurrency')
	})
}

export function createCustomOptions(options: CustomLifecycleOptions): ResolvedLifecycleOptions {
	return resolved(options, {
		init: DEFAULT_INIT_TIMEOUT_MS_PROD,
		warm: DEFAULT_WARM_TIMEOUT_MS_PROD,
		shutdown: DEFAULT_SHUTDOWN_TIMEOUT_MS_PROD,
		drain: DEFAULT_DRAIN_GRACE_PERIOD_MS_PROD,
		health: DEFAULT_HEALTH_CHECK_INTERVAL_MS_PROD
	})
}

function standardToCustom(options: StandardLifecycleOptions | undefined): Pick<CustomLifecycleOptions, 'resource' | 'observability'> {
	if (options === undefined) return {}
	const root = snapshotRecord(options, 'Lifecycle standard options', STANDARD_FIELDS)
	return {
		...(root.resource === undefined ? {} : {resource: root.resource as never}),
		...(root.observability === undefined ? {} : {observability: root.observability as never})
	}
}

export function createDevelopmentOptions(
	options?: StandardLifecycleOptions
): ResolvedLifecycleOptions {
	return resolved({clock: createSystemClock(), ...standardToCustom(options)}, {
		init: DEFAULT_INIT_TIMEOUT_MS_DEV,
		warm: DEFAULT_WARM_TIMEOUT_MS_DEV,
		shutdown: DEFAULT_SHUTDOWN_TIMEOUT_MS_DEV,
		drain: DEFAULT_DRAIN_GRACE_PERIOD_MS_DEV,
		health: DEFAULT_HEALTH_CHECK_INTERVAL_MS_DEV
	})
}

export function createProductionOptions(
	options?: StandardLifecycleOptions
): ResolvedLifecycleOptions {
	return resolved({clock: createSystemClock(), ...standardToCustom(options)}, {
		init: DEFAULT_INIT_TIMEOUT_MS_PROD,
		warm: DEFAULT_WARM_TIMEOUT_MS_PROD,
		shutdown: DEFAULT_SHUTDOWN_TIMEOUT_MS_PROD,
		drain: DEFAULT_DRAIN_GRACE_PERIOD_MS_PROD,
		health: DEFAULT_HEALTH_CHECK_INTERVAL_MS_PROD
	})
}
