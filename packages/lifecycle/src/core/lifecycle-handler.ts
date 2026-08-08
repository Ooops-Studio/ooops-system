import type {
	LifecycleFlushContext,
	LifecycleHealthState,
	LifecycleRuntimeState,
	LifecycleShutdownContext,
	LifecycleShutdownReason,
	LifecycleStartupContext,
	LifecycleStartupStage,
	LifecycleStatus
} from '@ooopsstudio/core/contracts/lifecycle'
import {
	LifecycleError,
	LifecycleShutdownTimeoutError,
	LifecycleStartupError
} from '@ooopsstudio/core/contracts/lifecycle'
import type {ManagedLifecycle} from '@ooopsstudio/core/ports/lifecycle'

import type {ResolvedLifecycleOptions} from '../types/lifecycle'

import {HealthManager} from './health-manager'
import {
	HookManager,
	startupExecutionBatches,
	type FlushHookEntry,
	type ShutdownHookEntry,
	type StartupHookEntry
} from './hook-manager'
import {stableErrorMessage} from './lifecycle-handler-validation'
import {ProbeManager} from './probe-manager'
import {
	registerLifecycleCleanupCapability,
	unregisterLifecycleCleanupCapability
} from './runtime-capabilities'
import {
	LifecycleTelemetryController,
	registerLifecycleTelemetry,
	unregisterLifecycleTelemetry
} from './telemetry-controller'

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve()
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', abort)
			resolve()
		}
		const abort = (): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(signal?.reason instanceof Error ? signal.reason : new Error('LIFECYCLE_ABORTED'))
		}
		const timer = setTimeout(finish, ms)
		if (signal?.aborted) abort()
		else signal?.addEventListener('abort', abort, {once: true})
	})
}

function raceBounded<T>(
	promise: Promise<T>,
	timeoutMs: number,
	code: string,
	signal?: AbortSignal,
	onTimeout?: () => void
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	let removeAbort: (() => void) | undefined
	const competitors: Promise<T>[] = [promise]
	competitors.push(new Promise<T>((_resolve, reject) => {
		timer = setTimeout(() => {
			onTimeout?.()
			reject(new Error(code))
		}, timeoutMs)
	}))
	if (signal) competitors.push(new Promise<T>((_resolve, reject) => {
		const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('LIFECYCLE_ABORTED'))
		if (signal.aborted) abort()
		else {
			signal.addEventListener('abort', abort, {once: true})
			removeAbort = () => signal.removeEventListener('abort', abort)
		}
	}))
	return Promise.race(competitors).finally(() => {
		if (timer) clearTimeout(timer)
		removeAbort?.()
	})
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error('LIFECYCLE_ABORTED')
	}
}

export function createLifecycleHandler(options: ResolvedLifecycleOptions): ManagedLifecycle {
	let state: LifecycleRuntimeState = 'idle'
	let startupStage: LifecycleStartupStage | undefined
	let lastFailureCode: string | undefined
	let registrationsClosed = false
	let activeHooks = 0
	let startPromise: Promise<void> | undefined
	let shutdownPromise: Promise<void> | undefined
	let flushPromise: Promise<void> | undefined
	let startupController: AbortController | undefined
	let drainStartedAt: number | undefined
	let drainReason: LifecycleShutdownReason = 'manual'
	const activePhysical = new Set<Promise<unknown>>()

	const telemetry = new LifecycleTelemetryController(options.observability)
	const hooks = new HookManager(options.shutdownGroups)
	const health = new HealthManager({
		clock: options.clock,
		intervalMs: options.healthIntervalMs,
		checkTimeoutMs: options.healthCheckTimeoutMs,
		runTimeoutMs: options.healthRunTimeoutMs,
		concurrency: options.healthConcurrency,
		onHealthFailure: (criticality) => telemetry.healthFailure(criticality),
		onDegradation: (severity) => telemetry.degradation(severity)
	})
	const currentHealth = (): LifecycleHealthState => {
		if (state === 'closed') return 'closed'
		if (lastFailureCode) return 'unhealthy'
		return health.getHealth()
	}
	const probes = new ProbeManager({
		clock: options.clock,
		...(options.resource ? {resource: options.resource} : {}),
		getState: () => state,
		getHealth: currentHealth
	})

	const status = (): LifecycleStatus => Object.freeze({
		state,
		health: currentHealth(),
		...(startupStage ? {startupStage} : {}),
		activeHooks,
		failedChecks: health.failedChecks(),
		...(lastFailureCode ? {lastFailureCode} : {})
	})

	const lifecycleError = (message: string, cause?: unknown): LifecycleError => (
		new LifecycleError(message, {
			...(cause === undefined ? {} : {cause}),
			state,
			health: currentHealth()
		})
	)

	const assertRegistrationOpen = (): void => {
		if (registrationsClosed || state !== 'idle' || startPromise) {
			throw lifecycleError('Lifecycle registration is closed')
		}
	}

	const trackPhysical = <T>(physical: Promise<T>): Promise<T> => {
		activePhysical.add(physical)
		activeHooks++
		void physical.finally(() => {
			activePhysical.delete(physical)
			activeHooks = Math.max(0, activeHooks - 1)
		}).catch(() => undefined)
		return physical
	}

	const executeStartupEntry = async(
		entry: StartupHookEntry,
		stage: LifecycleStartupStage,
		parentSignal: AbortSignal
	): Promise<boolean> => {
		const controller = new AbortController()
		const abort = (): void => controller.abort(parentSignal.reason)
		parentSignal.addEventListener('abort', abort, {once: true})
		const context: LifecycleStartupContext = Object.freeze({
			stage,
			startedAt: options.clock.now(),
			signal: controller.signal
		})
		let physical: Promise<void>
		try { physical = trackPhysical(Promise.resolve(Reflect.apply(entry.hook, undefined, [context]))) } catch {
			physical = trackPhysical(Promise.reject(new Error('LIFECYCLE_HOOK_FAILURE')))
		}
		try {
			await raceBounded(
				physical,
				stage === 'warm' ? options.warmTimeoutMs : options.initTimeoutMs,
				'LIFECYCLE_STARTUP_HOOK_TIMEOUT',
				parentSignal,
				() => controller.abort(new Error('LIFECYCLE_STARTUP_HOOK_TIMEOUT'))
			)
			return true
		} catch {
			telemetry.hookFailure(stage)
			return false
		} finally {
			parentSignal.removeEventListener('abort', abort)
		}
	}

	const executeStartupStage = async(
		stage: LifecycleStartupStage,
		signal: AbortSignal
	): Promise<void> => {
		startupStage = stage
		const entries = hooks.startupEntries(stage)
		const batches = startupExecutionBatches(entries)
		const controller = new AbortController()
		const abort = (): void => controller.abort(signal.reason)
		signal.addEventListener('abort', abort, {once: true})
		const timeoutMs = stage === 'warm' ? options.warmTimeoutMs : options.initTimeoutMs
		const timer = setTimeout(() => {
			controller.abort(new Error('LIFECYCLE_STARTUP_STAGE_TIMEOUT'))
		}, timeoutMs)
		const completed = new Set<number>()
		const degrade = (entry: StartupHookEntry): void => {
			health.recordDegradation(`warm:${entry.id}`, 'warning')
		}
		try {
			for (const batch of batches) {
				if (controller.signal.aborted) break
				const results = await Promise.all(batch.map(async(entry) => ({
					entry,
					success: await executeStartupEntry(entry, stage, controller.signal)
				})))
				for (const result of results) {
					completed.add(result.entry.id)
					if (result.success) continue
					if (result.entry.required) throw new Error('LIFECYCLE_REQUIRED_STARTUP_HOOK_FAILURE')
					degrade(result.entry)
				}
			}
			throwIfAborted(signal)
			if (controller.signal.aborted) {
				for (const entry of entries) {
					if (completed.has(entry.id)) continue
					if (entry.required) throw new Error('LIFECYCLE_STARTUP_STAGE_TIMEOUT')
					degrade(entry)
				}
			}
		} finally {
			clearTimeout(timer)
			signal.removeEventListener('abort', abort)
		}
	}

	const beginDrainNow = (reason: LifecycleShutdownReason = 'manual'): void => {
		if (state === 'closed' || state === 'draining') return
		const startedAt = options.monotonicClock.now()
		drainReason = reason
		drainStartedAt = startedAt
		registrationsClosed = true
		state = 'draining'
		startupStage = undefined
		health.beginDrain()
		startupController?.abort(new Error('LIFECYCLE_DRAINING'))
	}
	const beginDrain = async(reason: LifecycleShutdownReason = 'manual'): Promise<void> => {
		beginDrainNow(reason)
	}

	const waitForActivePhysical = async(signal: AbortSignal): Promise<void> => {
		throwIfAborted(signal)
		while (activePhysical.size > 0) {
			await raceBounded(
				Promise.allSettled([...activePhysical]).then(() => undefined),
				options.hookTimeoutMs,
				'LIFECYCLE_ACTIVE_WORK_TIMEOUT',
				signal
			)
			throwIfAborted(signal)
		}
	}

	const executeShutdownEntry = async(
		entry: ShutdownHookEntry,
		context: LifecycleShutdownContext,
		attemptSignal: AbortSignal
	): Promise<boolean> => {
		if (entry.done) return true
		const controller = new AbortController()
		const abort = (): void => controller.abort(attemptSignal.reason)
		attemptSignal.addEventListener('abort', abort, {once: true})
		let physical = entry.physical
		if (!physical) {
			const hookContext = Object.freeze({...context, abortSignal: controller.signal})
			try { physical = trackPhysical(Promise.resolve(Reflect.apply(entry.hook, undefined, [hookContext]))) } catch {
				physical = trackPhysical(Promise.reject(new Error('LIFECYCLE_HOOK_FAILURE')))
			}
			entry.physical = physical
			void physical.then(() => { entry.done = true }).finally(() => {
				if (entry.physical === physical) entry.physical = undefined
			}).catch(() => undefined)
		}
		try {
			await raceBounded(
				physical,
				options.hookTimeoutMs,
				'LIFECYCLE_SHUTDOWN_HOOK_TIMEOUT',
				attemptSignal,
				() => controller.abort(new Error('LIFECYCLE_SHUTDOWN_HOOK_TIMEOUT'))
			)
			entry.done = true
			return true
		} catch {
			telemetry.hookFailure('shutdown')
			return false
		} finally {
			attemptSignal.removeEventListener('abort', abort)
		}
	}

	const executeFlushEntry = async(
		entry: FlushHookEntry,
		terminal: boolean,
		attemptSignal?: AbortSignal
	): Promise<boolean> => {
		if (terminal && entry.terminalDone) return true
		const controller = new AbortController()
		const abort = (): void => controller.abort(attemptSignal?.reason)
		attemptSignal?.addEventListener('abort', abort, {once: true})
		let physical = entry.physical
		if (!physical) {
			const context: LifecycleFlushContext = Object.freeze({signal: controller.signal})
			try { physical = trackPhysical(Promise.resolve(Reflect.apply(entry.hook, undefined, [context]))) } catch {
				physical = trackPhysical(Promise.reject(new Error('LIFECYCLE_HOOK_FAILURE')))
			}
			entry.physical = physical
			void physical.then(() => {
				if (terminal) entry.terminalDone = true
			}).finally(() => {
				if (entry.physical === physical) entry.physical = undefined
			}).catch(() => undefined)
		}
		try {
			await raceBounded(
				physical,
				options.flushTimeoutMs,
				'LIFECYCLE_FLUSH_HOOK_TIMEOUT',
				attemptSignal,
				() => controller.abort(new Error('LIFECYCLE_FLUSH_HOOK_TIMEOUT'))
			)
			if (terminal) entry.terminalDone = true
			return true
		} catch {
			telemetry.hookFailure('flush')
			return false
		} finally {
			attemptSignal?.removeEventListener('abort', abort)
		}
	}

	const runFlush = async(terminal: boolean, signal?: AbortSignal): Promise<void> => {
		const results = await Promise.all(hooks.flushEntries(terminal).map(
			async(entry) => await executeFlushEntry(entry, terminal, signal)
		))
		if (results.some((success) => !success)) throw new Error('LIFECYCLE_FLUSH_FAILURE')
	}

	const flush = async(): Promise<void> => {
		if (state === 'closed') return
		if (state === 'draining') {
			if (shutdownPromise) return shutdownPromise
			throw lifecycleError('Lifecycle is draining; retry shutdown to continue finalization')
		}
		if (flushPromise) return flushPromise
		// Publish ownership before a caller-controlled hook can synchronously
		// re-enter flush and start a second execution.
		const execution = Promise.resolve().then(async() => await runFlush(false)).catch((error: unknown) => {
			throw lifecycleError('Lifecycle flush failed', error)
		}).finally(() => {
			if (flushPromise === execution) flushPromise = undefined
		})
		flushPromise = execution
		return execution
	}

	const runShutdownAttempt = async(
		reason: LifecycleShutdownReason,
		signal: AbortSignal
	): Promise<void> => {
		beginDrainNow(reason)
		throwIfAborted(signal)
		await raceBounded(
			health.drain(), options.healthRunTimeoutMs, 'LIFECYCLE_HEALTH_DRAIN_TIMEOUT', signal
		)
		throwIfAborted(signal)
		await waitForActivePhysical(signal)
		const elapsedDrain = drainStartedAt === undefined
			? 0
			: Math.max(0, options.monotonicClock.now() - drainStartedAt)
		await delay(Math.max(0, options.drainGracePeriodMs - elapsedDrain), signal)
		throwIfAborted(signal)
		const context: LifecycleShutdownContext = Object.freeze({
			reason: drainReason,
			startedAt: options.clock.now(),
			abortSignal: signal
		})
		for (const tier of hooks.shutdownTiers()) {
			throwIfAborted(signal)
			const results = await Promise.all(tier.entries.map(
				async(entry) => await executeShutdownEntry(entry, context, signal)
			))
			if (results.some((success) => !success)) throw new Error('LIFECYCLE_SHUTDOWN_HOOK_FAILURE')
		}
		throwIfAborted(signal)
		await runFlush(true, signal)
		throwIfAborted(signal)
		telemetry.dispose()
		health.close()
		hooks.clear()
		state = 'closed'
		lastFailureCode = undefined
	}

	const shutdown = async(reason: LifecycleShutdownReason = 'manual'): Promise<void> => {
		if (state === 'closed') return
		if (shutdownPromise) return shutdownPromise
		// Publish shutdownPromise without yielding so concurrent callers cannot start
		// independent finalization attempts.
		beginDrainNow(reason)
		const controller = new AbortController()
		const startedAt = options.monotonicClock.now()
		// Defer caller-controlled work until shutdownPromise has been published.
		const attempt = Promise.resolve().then(async() => await runShutdownAttempt(reason, controller.signal))
		const exposed = raceBounded(
			attempt,
			options.shutdownTimeoutMs,
			'LIFECYCLE_SHUTDOWN_TIMEOUT',
			undefined,
			() => controller.abort(new Error('LIFECYCLE_SHUTDOWN_TIMEOUT'))
		).then(() => {
			telemetry.shutdown('success', Math.max(0, options.monotonicClock.now() - startedAt))
			unregisterLifecycleTelemetry(api)
			unregisterLifecycleCleanupCapability(api)
		}).catch((error: unknown) => {
			const timeoutFailure = stableErrorMessage(error) === 'LIFECYCLE_SHUTDOWN_TIMEOUT'
			lastFailureCode = timeoutFailure ? 'LIFECYCLE_SHUTDOWN_TIMEOUT' : 'LIFECYCLE_SHUTDOWN_FAILURE'
			telemetry.shutdown(timeoutFailure ? 'timeout' : 'failure', Math.max(0, options.monotonicClock.now() - startedAt))
			if (timeoutFailure) throw new LifecycleShutdownTimeoutError('Lifecycle shutdown timed out', {
				cause: error, state, health: currentHealth()
			})
			throw lifecycleError('Lifecycle shutdown failed', error)
		})
		shutdownPromise = exposed
		void attempt.finally(() => {
			if (shutdownPromise === exposed) shutdownPromise = undefined
		}).catch(() => undefined)
		return exposed
	}

	const start = async(): Promise<void> => {
		if (state === 'running') return
		if (startPromise) return startPromise
		if (state !== 'idle') throw lifecycleError('Lifecycle cannot start from its current state')
		registrationsClosed = true
		state = 'starting'
		startupController = new AbortController()
		const controller = startupController
		const startedAt = options.monotonicClock.now()
		const execution = (async() => {
			try {
				for (const stage of ['init', 'warm', 'ready'] as const) {
					await executeStartupStage(stage, controller.signal)
				}
				await health.start()
				if (controller.signal.aborted) throw controller.signal.reason
				startupStage = undefined
				state = 'running'
				telemetry.startup('success', Math.max(0, options.monotonicClock.now() - startedAt))
			} catch(error) {
				lastFailureCode = 'LIFECYCLE_STARTUP_FAILURE'
				telemetry.startup('failure', Math.max(0, options.monotonicClock.now() - startedAt))
				await beginDrain('error')
				try { await shutdown('error') } catch { /* startup error remains primary */ }
				throw new LifecycleStartupError('Lifecycle startup failed', {
					cause: error, state, health: currentHealth()
				})
			}
		})().finally(() => {
			if (startupController === controller) startupController = undefined
			if (startPromise === execution) startPromise = undefined
		})
		startPromise = execution
		return execution
	}

	const api: ManagedLifecycle = {
		start,
		getStatus: status,
		registerStartupHook(stage, hook, hookOptions) {
			assertRegistrationOpen()
			return hooks.registerStartupHook(stage, hook, hookOptions)
		},
		registerShutdownHook(group, hook, hookOptions) {
			assertRegistrationOpen()
			return hooks.registerShutdownHook(group, hook, hookOptions)
		},
		registerFlushHook(name, hook) {
			assertRegistrationOpen()
			return hooks.registerFlushHook(name, hook)
		},
		registerHealthCheck(definition) {
			assertRegistrationOpen()
			return health.register(definition)
		},
		recordDegradation(code, severity) { health.recordDegradation(code, severity) },
		clearDegradation(code) { health.clearDegradation(code) },
		getHealthSnapshot: () => health.getSnapshot(),
		getLivenessStatus: () => probes.getLivenessStatus(),
		getReadinessStatus: () => probes.getReadinessStatus(),
		beginDrain,
		flush,
		shutdown
	}

	registerLifecycleTelemetry(api, telemetry)
	registerLifecycleCleanupCapability(api, (cleanup) => telemetry.attachCleanup(cleanup))
	return api
}
