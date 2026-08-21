import type {JobsAdminPort, JobsRuntime, ManagedJobs} from '@ooopsstudio/core/ports/jobs'

import {registerJobsTelemetryTarget} from '../runtime-capabilities'
import type {JobsHandlerOptions} from '../types/jobs'
import {snapshotJobsOptions} from '../utils/options'

import {createJobsAdminPort} from './handler-admin'
import {createJobsKernelContext} from './handler-context'
import {createJobsExecution} from './handler-execution'
import {hasJobsNumberPrecision, validateJobsNamespace} from './handler-helpers'
import {createJobsQueueApi} from './handler-queue-api'
import {runInitialJobsTickWithRetry} from './handler-startup'
import {createJobsTick} from './handler-tick'
import {withJobsTimeout} from './timeout'

const FINALIZATION_TIMEOUT_MS = 5_000
const MAX_TIMER_MS = 2_147_483_647
const MAX_CONCURRENT_RUNS = 1_024
const MAX_RETRY_ATTEMPTS = 100

const waitFor = async(operation: Promise<unknown> | undefined, message: string): Promise<void> => {
	if (!operation) return
	await withJobsTimeout(operation, FINALIZATION_TIMEOUT_MS, message)
}

type SchedulingFactory = (
	context: ReturnType<typeof createJobsKernelContext>
) => {triggerDueSchedules(): Promise<void>}

function captureJobsClock(source: unknown): JobsHandlerOptions['clock'] {
	if (!source || (typeof source !== 'object' && typeof source !== 'function')) {
		throw new Error('Jobs scheduler requires a valid clock')
	}
	let current: object | null = source as object
	try {
		for (let depth = 0; current && depth < 32; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, 'now')
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') break
				const method = descriptor.value as () => number
				return Object.freeze({now: () => Reflect.apply(method, source, []) as number})
			}
			current = Object.getPrototypeOf(current)
		}
	} catch { /* stable error below */ }
	throw new Error('Jobs scheduler requires a valid clock')
}

function validateRuntimeOptions(options: JobsHandlerOptions): void {
	if (!options.clock || typeof options.clock.now !== 'function') throw new Error('Jobs scheduler requires a valid clock')
	if (options.pollIntervalMs !== undefined && (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0 || options.pollIntervalMs > MAX_TIMER_MS)) throw new Error('Invalid Jobs pollIntervalMs')
	if (options.maxConcurrentRuns !== undefined && (!Number.isInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns <= 0 || options.maxConcurrentRuns > MAX_CONCURRENT_RUNS)) throw new Error('Invalid Jobs maxConcurrentRuns')
	if (!Number.isInteger(options.retry.attempts) || options.retry.attempts < 1 || options.retry.attempts > MAX_RETRY_ATTEMPTS || !Number.isSafeInteger(options.retry.baseDelayMs) || options.retry.baseDelayMs < 0 || options.retry.baseDelayMs > MAX_TIMER_MS) throw new Error('Jobs retry policy is invalid')
	if (options.retry.maxDelayMs !== undefined && (!Number.isSafeInteger(options.retry.maxDelayMs) || options.retry.maxDelayMs < 0 || options.retry.maxDelayMs > MAX_TIMER_MS)) throw new Error('Invalid Jobs retry maxDelayMs')
	if (options.retry.backoff && (!['fixed', 'linear', 'exponential'].includes(options.retry.backoff.kind) || (options.retry.backoff.factor !== undefined && (!Number.isFinite(options.retry.backoff.factor) || options.retry.backoff.factor <= 0 || !hasJobsNumberPrecision(options.retry.backoff.factor))))) throw new Error('Invalid Jobs retry backoff policy')
	if (options.retry.jitter !== undefined && !['none', 'full', 'bounded'].includes(options.retry.jitter)) throw new Error('Invalid Jobs retry jitter policy')
	if (options.lease && (!Number.isSafeInteger(options.lease.leaseMs) || options.lease.leaseMs < 200 || options.lease.leaseMs > MAX_TIMER_MS || (options.lease.recoveryAfterMs !== undefined && (!Number.isSafeInteger(options.lease.recoveryAfterMs) || options.lease.recoveryAfterMs < 0 || options.lease.recoveryAfterMs > MAX_TIMER_MS)))) throw new Error('Jobs lease policy is invalid')
	if (!Number.isSafeInteger(options.maintenanceIntervalMs) || options.maintenanceIntervalMs <= 0 || options.maintenanceIntervalMs > MAX_TIMER_MS) throw new Error('Invalid Jobs maintenanceIntervalMs')
	if (!Number.isSafeInteger(options.maxCatchUp) || options.maxCatchUp < 1 || options.maxCatchUp > 100) throw new Error('Invalid Jobs maxCatchUp')
	if (options.terminalRetentionMs !== undefined && (!Number.isSafeInteger(options.terminalRetentionMs) || options.terminalRetentionMs <= 0 || options.terminalRetentionMs > MAX_TIMER_MS)) throw new Error('Invalid Jobs terminalRetentionMs')
	if (options.namespace !== undefined) validateJobsNamespace(options.namespace)
	if (options.defaultQueue !== undefined && !/^[a-z][a-z0-9_.-]{0,63}$/iu.test(options.defaultQueue)) throw new Error('Invalid Jobs defaultQueue')
	if (!options.schedulePolicy.misfire.includes(options.schedulePolicy.defaults.misfire) || !options.schedulePolicy.overlap.includes(options.schedulePolicy.defaults.overlap)) throw new Error('Jobs default schedule policy must be supported')
}

function snapshotRuntimeOptions(options: JobsHandlerOptions): JobsHandlerOptions {
	const retry = snapshotJobsOptions<JobsHandlerOptions['retry']>(
		options.retry, new Set(['attempts', 'baseDelayMs', 'maxDelayMs', 'backoff', 'jitter']),
		'Jobs retry policy'
	)
	const backoff = retry.backoff === undefined
		? undefined
		: snapshotJobsOptions<NonNullable<JobsHandlerOptions['retry']['backoff']>>(
			retry.backoff, new Set(['kind', 'factor']), 'Jobs retry backoff policy'
		)
	const lease = options.lease === undefined
		? undefined
		: snapshotJobsOptions<NonNullable<JobsHandlerOptions['lease']>>(
			options.lease, new Set(['leaseMs', 'recoveryAfterMs']), 'Jobs lease policy'
		)
	return {
		...options,
		clock: captureJobsClock(options.clock),
		backend: options.backend,
		retry: {...retry, ...(backoff ? {backoff} : {})},
		...(lease ? {lease} : {}),
		schedulePolicy: {
			misfire: [...options.schedulePolicy.misfire],
			overlap: [...options.schedulePolicy.overlap],
			defaults: {...options.schedulePolicy.defaults}
		}
	}
}

export function createJobsRuntime(
	options: JobsHandlerOptions,
	createScheduling: SchedulingFactory
): JobsRuntime {
	const runtimeOptions = snapshotRuntimeOptions(options)
	validateRuntimeOptions(runtimeOptions)
	const context = createJobsKernelContext(runtimeOptions)
	const queueRuntime = createJobsQueueApi(context)
	const scheduling = createScheduling(context)
	const execution = createJobsExecution(context)
	let jobs!: ManagedJobs
	let lifecycleActive = false
	let lifecycleDisposed = false
	const lifecycleDisposers: Array<() => void> = []
	const disposeLifecycle = (): unknown[] => {
		const failures: unknown[] = []
		for (const dispose of [...lifecycleDisposers].reverse()) {
			try {
				dispose()
				const index = lifecycleDisposers.lastIndexOf(dispose)
				if (index >= 0) lifecycleDisposers.splice(index, 1)
			} catch(error) {
				failures.push(error)
				context.report(error, 'lifecycle-dispose')
			}
		}
		return failures
	}
	const tick = createJobsTick(context, scheduling.triggerDueSchedules, execution.dispatch)
	const throwRuntimeFailures = (): void => {
		const failures = [
			...context.state.executionFailures.splice(0),
			...context.state.backgroundFailures.splice(0)
		]
		if (failures.length === 0) return
		throw new AggregateError(failures, 'Jobs background processing failed')
	}

	jobs = {
		registerTask: queueRuntime.api.registerTask,
		enqueue: (...arguments_) => context.trackMutation(() => queueRuntime.api.enqueue(...arguments_)),
		upsertSchedule: (...arguments_) => context.trackMutation(() => queueRuntime.api.upsertSchedule(...arguments_)),
		pauseSchedule: (...arguments_) => context.trackMutation(() => queueRuntime.api.pauseSchedule(...arguments_)),
		resumeSchedule: (...arguments_) => context.trackMutation(() => queueRuntime.api.resumeSchedule(...arguments_)),
		deleteSchedule: (...arguments_) => context.trackMutation(() => queueRuntime.api.deleteSchedule(...arguments_)),
		getRun: (...arguments_) => context.trackMutation(() => queueRuntime.api.getRun(...arguments_)),
		cancelRun: (...arguments_) => context.trackMutation(() => queueRuntime.api.cancelRun(...arguments_)),
		async start() {
			if (context.control.destroyed) throw new Error('Jobs scheduler has been shut down')
			if (context.control.draining) throw new Error('Jobs scheduler is shutting down')
			if (context.control.start) return context.control.start
			if (context.control.started) return
			context.control.registrationClosed = true
			context.control.started = true
			const pending = runInitialJobsTickWithRetry(
				tick.tick,
				({attempt, nextAttempt, delayMs}) => context.log('warn', 'jobs.startup_tick_retry', {
					attempt, nextAttempt, delayMs
				})
			).then(() => { tick.startLoop() }).catch((error) => {
				tick.stopLoop(); context.control.started = false; throw error
			}).finally(() => { if (context.control.start === pending) context.control.start = undefined })
			context.control.start = pending
			return pending
		},
		getStatus() {
			const state = context.control.destroyed ? 'closed'
				: context.control.draining ? 'draining'
					: context.control.started ? 'running' : 'idle'
			return Object.freeze({
				state,
				backendState: context.control.destroyed ? 'closed' : context.state.backendState,
				activeRuns: context.activeExecutions.size,
				activeOperations: context.activeMutations.size + context.activeTaskOperations.size,
				retriedTotal: context.state.retriedTotal,
				deadLetteredTotal: context.state.deadLetteredTotal,
				...(context.state.lastFailureCode ? {lastFailureCode: context.state.lastFailureCode} : {})
			})
		},
		async flush() {
			if (context.control.destroyed) return
			if (context.control.flush) return context.control.flush
			if (context.control.draining) return context.control.shutdown ?? jobs.shutdown()
			const restart = context.control.started && !context.control.draining
			tick.stopLoop()
			const pending = (async() => {
				await waitFor(context.control.tick, 'Jobs flush timed out waiting for scheduler tick')
				await waitFor(tick.waitForStages(), 'Jobs flush timed out waiting for backend stages')
				await waitFor(Promise.allSettled([...context.activeExecutions]), 'Jobs flush timed out waiting for active executions')
				await waitFor(Promise.allSettled([...context.activeTaskOperations]), 'Jobs flush timed out waiting for task handlers')
				await waitFor(Promise.allSettled([...context.activeMutations]), 'Jobs flush timed out waiting for accepted mutations')
				throwRuntimeFailures()
				context.telemetry.emit({kind: 'recovered'})
			})().catch((error) => {
				context.telemetry.emit({
					kind: 'finalization_failed', operation: 'flush',
					code: 'JOBS_FLUSH_FAILED', error
				})
				throw error
			}).finally(() => {
				if (context.control.flush === pending) context.control.flush = undefined
				if (restart && context.control.started
					&& !context.control.destroyed && !context.control.draining) tick.startLoop()
			})
			context.control.flush = pending
			return pending
		},
		async shutdown() {
			if (context.control.destroyed) return
			if (context.control.shutdown) return context.control.shutdown
			context.control.shutdown = (async() => {
				const preparationFailures: unknown[] = []
				const prepare = async(operation: Promise<void>): Promise<void> => {
					try { await operation } catch(error) { preparationFailures.push(error) }
				}
				context.control.draining = true; context.control.registrationClosed = true; tick.stopLoop()
				// Startup, flush and stage failures are important diagnostics, but they
				// must not bypass the handler abort/drain path. A process shutdown hook is
				// commonly one-shot; fail-fast here would leave application side effects
				// and their durable leases running after finalization had already failed.
				await prepare(waitFor(context.control.start, 'Jobs shutdown timed out waiting for scheduler startup'))
				await prepare(waitFor(context.control.flush, 'Jobs shutdown timed out waiting for scheduler flush'))
				await prepare(waitFor(context.control.tick, 'Jobs shutdown timed out waiting for scheduler tick'))
				await prepare(waitFor(tick.waitForStages(), 'Jobs shutdown timed out waiting for backend stages'))
				try {
					await waitFor(Promise.allSettled([
						...context.activeExecutions, ...context.activeTaskOperations
					]), 'Jobs shutdown timed out waiting for active executions')
				} catch {
					for (const controller of context.state.activeControllers.values()) {
						controller.abort(new Error('Jobs scheduler shutdown grace period expired'))
					}
					await waitFor(Promise.allSettled([
						...context.activeExecutions, ...context.activeTaskOperations
					]), 'Jobs shutdown timed out after aborting active executions')
				}
				await prepare(waitFor(
					Promise.allSettled([...context.activeMutations]),
					'Jobs shutdown timed out waiting for accepted mutations'
				))
				try { throwRuntimeFailures() } catch(error) { preparationFailures.push(error) }
				if (preparationFailures.length > 0) {
					throw new AggregateError(preparationFailures, 'Jobs shutdown preparation failed')
				}
				context.control.started = false; lifecycleActive = false
				if (!lifecycleDisposed) {
					const disposalFailures = disposeLifecycle()
					if (disposalFailures.length) {
						throw new AggregateError(disposalFailures, 'Jobs lifecycle cleanup failed')
					}
					lifecycleDisposed = true
				}
				context.control.destroyed = true
				context.state.lastFailureCode = undefined
				context.state.activeControllers.clear()
				context.state.activeRunSchedules.clear()
				context.state.locallyCancelledActiveRunIds.clear()
				context.state.recentlyCancelledRunIds.clear()
				context.state.cancellationFenceOverflow = false
				context.state.cancellationFenceGeneration = 0n
				context.state.timedOutRunIds.clear()
				context.state.timedOutTaskOperations.clear()
				context.state.executionFailures.length = 0
				context.state.backgroundFailures.length = 0
				context.activeTracingOperations.clear()
				context.tasks.clear()
			})().catch((error) => {
				context.control.shutdown = undefined
				context.state.backendState = 'unhealthy'
				context.state.lastFailureCode = 'JOBS_FINALIZATION_FAILED'
				context.telemetry.emit({
					kind: 'finalization_failed', operation: 'shutdown',
					code: 'JOBS_FINALIZATION_FAILED', error
				})
				throw error
			})
			return context.control.shutdown
		}
	}
	Object.freeze(jobs)
	// Admin methods already own one mutation slot. Reuse the raw enqueue operation
	// for retryRun so a full batch cannot deadlock against its own nested admission.
	const rawAdmin = context.options.backend.admin
		? createJobsAdminPort(context, queueRuntime.api.enqueue)
		: undefined
	const admin: JobsAdminPort | undefined = rawAdmin ? Object.freeze<JobsAdminPort>({
		listRuns: (...arguments_) => context.trackMutation(() => rawAdmin.listRuns(...arguments_)),
		listSchedules: (...arguments_) => context.trackMutation(() => rawAdmin.listSchedules(...arguments_)),
		listDeadLetters: (...arguments_) => context.trackMutation(() => rawAdmin.listDeadLetters(...arguments_)),
		getQueueStats: (...arguments_) => context.trackMutation(() => rawAdmin.getQueueStats(...arguments_)),
		pauseQueue: (...arguments_) => context.trackMutation(() => rawAdmin.pauseQueue(...arguments_)),
		resumeQueue: (...arguments_) => context.trackMutation(() => rawAdmin.resumeQueue(...arguments_)),
		retryRun: (...arguments_) => context.trackMutation(() => rawAdmin.retryRun(...arguments_)),
		requeueDeadLetter: (...arguments_) => context.trackMutation(() => rawAdmin.requeueDeadLetter(...arguments_)),
		triggerScheduleNow: (...arguments_) => context.trackMutation(() => rawAdmin.triggerScheduleNow(...arguments_))
	}) : undefined

	const retainDisposer = (value: unknown): void => {
		if (typeof value === 'function') lifecycleDisposers.push(value as () => void)
	}
	try {
		retainDisposer(context.options.lifecycle?.registerShutdownHook?.('runtime-monitors', async() => {
			if (lifecycleActive) await jobs.shutdown()
		}, {name: 'jobs-shutdown', priority: 40}))
		retainDisposer(context.options.lifecycle?.registerFlushHook?.('jobs', async() => {
			if (lifecycleActive) await jobs.flush()
		}))
	} catch(error) {
		const failures = disposeLifecycle()
		if (failures.length) {
			throw new AggregateError([error, ...failures], 'Jobs lifecycle registration rollback failed')
		}
		throw error
	}
	lifecycleActive = true
	registerJobsTelemetryTarget(jobs, context.telemetry)

	return Object.freeze({jobs, ...(admin ? {admin} : {})})
}
