import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {JobsRuntime} from '@ooopsstudio/core/ports/jobs'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Container} from '@ooopsstudio/core/runtime'
import {captureSyncMethod, isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomJobsOptions} from './public/custom'
import type {DevelopmentJobsOptions} from './public/development'
import type {ProductionJobsOptions} from './public/production'
import {snapshotJobsOptions} from './utils/options'

type Injected = 'clock' | 'lifecycle'
export type JobsOptions =
	| {preset: 'development'; options?: Omit<DevelopmentJobsOptions, Injected>}
	| {preset: 'production'; options: Omit<ProductionJobsOptions, Injected>}
	| {preset: 'custom'; options: Omit<CustomJobsOptions, Injected>}

const REGISTRATION_FIELDS = new Set(['preset', 'options'])
const PRESET_OPTION_FIELDS = {
	development: new Set(['namespace', 'defaultQueue']),
	production: new Set(['backend', 'namespace', 'defaultQueue', 'maxConcurrentRuns', 'lease']),
	custom: new Set([
		'backend', 'retry', 'lease', 'namespace', 'pollIntervalMs', 'defaultQueue',
		'maxConcurrentRuns', 'terminalRetentionMs', 'maxCatchUp'
	])
} as const
const registrations = new WeakSet<object>()

interface ContainerBoundary {
	has(token: symbol): boolean
	get(token: symbol): unknown
	tryGet(token: symbol): unknown
	bind(token: symbol, value: unknown): void
	unbind(token: symbol): unknown
}

function captureContainer(value: Container): ContainerBoundary {
	const has = captureSyncMethod<[symbol], boolean>(value, 'has')
	const get = captureSyncMethod<[symbol], unknown>(value, 'get')
	const tryGet = captureSyncMethod<[symbol], unknown>(value, 'tryGet')
	const bind = captureSyncMethod<[symbol, unknown], void>(value, 'bind')
	const unbind = captureSyncMethod<[symbol], unknown>(value, 'unbind')
	if (!has || !get || !tryGet || !bind || !unbind) throw new TypeError('JOBS_CONTAINER_INVALID')
	return {
		has(token) {
			const result = has(token)
			isolateUnexpectedThenable(result)
			if (typeof result !== 'boolean') throw new TypeError('JOBS_CONTAINER_INVALID')
			return result
		},
		get(token) { const result = get(token); isolateUnexpectedThenable(result); return result },
		tryGet(token) { const result = tryGet(token); isolateUnexpectedThenable(result); return result },
		bind(token, item) { const result = bind(token, item); isolateUnexpectedThenable(result) },
		unbind(token) { const result = unbind(token); isolateUnexpectedThenable(result); return result }
	}
}

export async function registerJobs(containerValue: Container, configuration: JobsOptions): Promise<void> {
	if (!containerValue || (typeof containerValue !== 'object' && typeof containerValue !== 'function')) {
		throw new TypeError('JOBS_CONTAINER_INVALID')
	}
	if (registrations.has(containerValue)) throw new Error('Jobs service is already registered')
	registrations.add(containerValue)
	let runtime: JobsRuntime | undefined
	let container: ContainerBoundary | undefined
	const ownedBindings: Array<readonly [symbol, unknown]> = []
	try {
		const config = snapshotJobsOptions<{preset: JobsOptions['preset']; options?: unknown}>(
			configuration, REGISTRATION_FIELDS, 'Jobs registration'
		)
		if (!['development', 'production', 'custom'].includes(config.preset)) {
			throw new Error(`Unknown jobs preset: ${String(config.preset)}`)
		}
		const preset = config.preset
		if ((preset === 'production' || preset === 'custom') && config.options === undefined) {
			throw new Error(`Jobs ${preset} preset options are required`)
		}
		const options = config.options === undefined
			? {}
			: snapshotJobsOptions<Record<string, unknown>>(
				config.options, PRESET_OPTION_FIELDS[preset], `Jobs ${preset} preset options`
			)
		container = captureContainer(containerValue)
		if (container.has(TOK.Jobs) || container.has(TOK.JobsAdmin)) {
			throw new Error('Jobs service is already registered')
		}
		const lifecycle = container.tryGet(TOK.Lifecycle) as LifecyclePort | undefined
		const common = {
			clock: container.get(TOK.Clock) as Clock,
			...(lifecycle ? {lifecycle} : {})
		}
		if (preset === 'development') {
			const {createDevelopmentJobs} = await import('./public/development')
			runtime = await createDevelopmentJobs({...options, ...common} as DevelopmentJobsOptions)
		} else if (preset === 'production') {
			const {createProductionJobs} = await import('./public/production')
			runtime = await createProductionJobs({...options, ...common} as ProductionJobsOptions)
		} else {
			const {createCustomJobs} = await import('./public/custom')
			runtime = await createCustomJobs({...options, ...common} as CustomJobsOptions)
		}
		if (container.has(TOK.Jobs) || container.has(TOK.JobsAdmin)) {
			throw new Error('Jobs service was registered during runtime creation')
		}
		const bindOwned = (token: symbol, value: unknown): void => {
			if (container!.has(token)) throw new Error('Jobs service was registered during binding')
			try {
				container!.bind(token, value)
			} catch(error) {
				if (container!.tryGet(token) === value) ownedBindings.push([token, value])
				throw error
			}
			if (container!.tryGet(token) !== value) {
				throw new Error('Jobs container did not retain the registered runtime')
			}
			ownedBindings.push([token, value])
		}
		bindOwned(TOK.Jobs, runtime.jobs)
		if (runtime.admin) bindOwned(TOK.JobsAdmin, runtime.admin)
	} catch(error) {
		const cleanupFailures: unknown[] = []
		if (container) for (const [token, value] of ownedBindings.reverse()) {
			try {
				if (container.tryGet(token) === value) container.unbind(token)
				if (container.tryGet(token) === value) {
					throw new Error('Jobs registration rollback could not restore the unbound state')
				}
			} catch(cleanupError) { cleanupFailures.push(cleanupError) }
		}
		if (runtime) try { await runtime.jobs.shutdown() } catch(cleanupError) { cleanupFailures.push(cleanupError) }
		if (cleanupFailures.length > 0) {
			throw new AggregateError([error, ...cleanupFailures], 'Jobs registration and rollback failed')
		}
		throw error
	} finally { registrations.delete(containerValue) }
}

export * from './public/types'
