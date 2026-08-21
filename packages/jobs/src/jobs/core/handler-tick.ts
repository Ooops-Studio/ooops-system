import type {JobsKernelContext} from './handler-context'
import {addJobsDuration} from './handler-helpers'
import {withJobsTimeout} from './timeout'

const BACKEND_STAGE_TIMEOUT_MS = 5_000
const MAINTENANCE_TIMEOUT_MS = 5_000
const MAINTENANCE_BATCH_SIZE = 100
const MAX_MAINTENANCE_BATCHES = 100

export function createJobsTick(
	context: JobsKernelContext,
	triggerDueSchedules: () => Promise<void>,
	dispatch: () => Promise<void>
) {
	let lastMaintenanceAt: number | undefined
	let maintenance: Promise<void> | undefined
	const activeMaintenance = new Set<Promise<void>>()
	const stages = new Map<string, Promise<void>>()

	const recordBackendSuccess = (): void => {
		const recovered = context.state.backendState !== 'healthy' || context.state.lastFailureCode !== undefined
		context.state.backendState = 'healthy'
		context.state.lastFailureCode = undefined
		if (recovered) context.telemetry.emit({kind: 'recovered'})
	}
	const recordBackendFailure = (code: string, degraded = false): void => {
		context.state.backendState = degraded ? 'degraded' : 'unhealthy'
		context.state.lastFailureCode = code
	}
	const runStage = async(name: string, operation: () => Promise<void>): Promise<void> => {
		let stage = stages.get(name)
		if (!stage) {
			const pending = Promise.resolve().then(operation)
			stages.set(name, pending)
			stage = pending
			void pending.finally(() => {
				if (stages.get(name) === pending) stages.delete(name)
			}).catch(() => undefined)
		}
		try {
			await withJobsTimeout(stage, BACKEND_STAGE_TIMEOUT_MS, `Jobs backend ${name} timed out`)
			recordBackendSuccess()
		} catch(error) {
			recordBackendFailure('JOBS_BACKEND_OPERATION_FAILED')
			throw error
		}
	}

	const runMaintenanceWhenDue = async(): Promise<void> => {
		const now = context.now()
		if (lastMaintenanceAt !== undefined && now >= lastMaintenanceAt
			&& now - lastMaintenanceAt < context.options.maintenanceIntervalMs) return
		if (!maintenance) {
			const pending = (async() => {
				for (let batch = 0; batch < MAX_MAINTENANCE_BATCHES; batch += 1) {
					const cleaned = await context.options.backend.cleanupTerminalRuns(now, MAINTENANCE_BATCH_SIZE)
					if (!Number.isSafeInteger(cleaned) || cleaned < 0 || cleaned > MAINTENANCE_BATCH_SIZE) {
						throw new Error('Jobs backend returned an invalid cleanup result')
					}
					if (cleaned === 0) break
				}
				lastMaintenanceAt = context.now()
			})()
			maintenance = pending
			activeMaintenance.add(pending)
			void pending.finally(() => {
				activeMaintenance.delete(pending)
				if (maintenance === pending) maintenance = undefined
			}).catch(() => undefined)
		}
		try {
			await withJobsTimeout(maintenance, MAINTENANCE_TIMEOUT_MS, 'Jobs maintenance timed out')
			recordBackendSuccess()
		} catch(error) {
			recordBackendFailure('JOBS_MAINTENANCE_FAILED', true)
			context.report(error, 'maintenance')
		}
	}

	const run = async(): Promise<void> => {
		const failures: unknown[] = []
		const attempt = async(name: 'schedule-trigger' | 'stale-recovery' | 'run-claim', operation: () => Promise<void>): Promise<void> => {
			try { await operation() } catch(error) {
				failures.push(error)
				context.report(error, name)
			}
		}
		try {
			await attempt('schedule-trigger', async() => runStage('schedule-trigger', triggerDueSchedules))
			await attempt('stale-recovery', async() => runStage('stale-recovery', async() => {
				const now = context.now()
				const recovered = await context.options.backend.recoverStaleLeases(
					now,
					context.options.lease?.recoveryAfterMs ?? 90_000,
					context.options.terminalRetentionMs === undefined
						? undefined
						: addJobsDuration(now, context.options.terminalRetentionMs, 'Jobs terminal expiry')
				)
				if (!Number.isSafeInteger(recovered) || recovered < 0 || recovered > 1_000) {
					throw new Error('Jobs backend returned an invalid stale recovery result')
				}
			}))
			await attempt('run-claim', async() => runStage('run-claim', dispatch))
		} finally {
			// Cleanup is the recovery path for bounded backends. A full dead-letter
			// bucket can itself make stale recovery fail, so earlier stage failures
			// must never starve terminal retention maintenance.
			await runMaintenanceWhenDue()
		}
		if (failures.length > 0) {
			recordBackendFailure('JOBS_BACKEND_OPERATION_FAILED')
			if (failures.length === 1) throw failures[0]
			throw new AggregateError(failures, 'Jobs scheduler tick stages failed')
		}
	}

	const tick = async(): Promise<void> => {
		if (context.control.destroyed || context.control.draining) return
		if (context.control.tick) return context.control.tick
		context.control.tick = run().finally(() => { context.control.tick = undefined })
		return context.control.tick
	}
	const startLoop = () => {
		if (context.control.timer) return
		context.control.timer = setInterval(() => {
			if (context.control.tick) return
			void tick().catch(() => {
				if (context.state.backgroundFailures.length >= 1_024) context.state.backgroundFailures.shift()
				context.state.backgroundFailures.push(context.diagnosticError('tick'))
			})
		}, context.options.pollIntervalMs ?? 250)
		context.control.timer.unref?.()
	}
	const stopLoop = () => {
		if (context.control.timer) clearInterval(context.control.timer)
		context.control.timer = undefined
	}
	const waitForStages = async(): Promise<void> => {
		const settled = await Promise.allSettled([...stages.values(), ...activeMaintenance])
		const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
		if (failures.length) throw new AggregateError(failures, 'Jobs backend stages failed while draining')
	}
	return {tick, startLoop, stopLoop, waitForStages}
}
