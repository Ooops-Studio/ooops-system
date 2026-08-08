/* eslint-disable @stylistic/max-len */
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

import type {JobResult} from '@ooopsstudio/core/contracts/jobs'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'

import type {JobsTracing} from '../runtime-capabilities'
import type {StoredDeadLetter} from '../types/backend'
import type {InternalRun} from '../types/jobs'

import {validateJobsCollectionSize} from './handler-collection-limits'
import {MAX_ACTIVE_JOBS_TRACING_OPERATIONS, type JobsKernelContext} from './handler-context'
import {addJobsDuration, clone, computeRetryDelay, requireBackendBoolean, snapshotJobResult, snapshotJobTraceContext, validateResourceId, validateStoredJobRun} from './handler-helpers'
import {projectJobFailure} from './handler-projections'
import {withJobsTimeout} from './timeout'

export function createJobsExecution(context: JobsKernelContext) {
	const leaseMs = context.options.lease?.leaseMs ?? 60_000
	const renewalIntervalMs = Math.max(100, Math.floor(leaseMs / 2))
	const clearLease = (run: InternalRun) => {
		run.leaseOwner = undefined
		run.leaseToken = undefined
		run.leaseExpiresAt = undefined
		run.lastHeartbeatAt = undefined
	}
	const reportLeaseLoss = (run: InternalRun, operation: string) => context.report(
		new Error(`Jobs lease lost during ${operation}`),
		'lease-transition',
		{runId: run.id, operation}
	)
	const commitTransition = async(
		next: InternalRun,
		operation: () => Promise<boolean>,
		label: string
	): Promise<boolean> => {
		const expected = clone(next)
		try { return requireBackendBoolean(await operation(), label) } catch(error) {
			let recovered
			try { recovered = await context.options.backend.getRun(next.id) } catch(recoveryError) {
				throw new AggregateError([error, recoveryError], `Jobs ${label} recovery failed`)
			}
			if (recovered) validateStoredJobRun(recovered)
			if (recovered && isDeepStrictEqual(recovered, expected)) return true
			throw error
		}
	}
	const complete = async(run: InternalRun, output: JobResult | undefined, leaseToken: string | undefined) => {
		const next = clone(run); next.status = 'completed'; next.output = output
		next.failureCode = undefined; next.error = undefined
		next.updatedAt = Math.max(context.now(), run.createdAt, run.updatedAt)
		next.completedAt = next.updatedAt; next.terminalAt = next.updatedAt; clearLease(next)
		next.terminalExpiresAt = context.options.terminalRetentionMs === undefined ? undefined
			: addJobsDuration(next.updatedAt, context.options.terminalRetentionMs, 'Jobs terminal expiry')
		if (!leaseToken) throw new Error('Jobs completion requires a lease')
		if (!await commitTransition(
			next, async() => await context.options.backend.completeRun(next, leaseToken), 'completion'
		)) {
			reportLeaseLoss(run, 'complete'); return
		}
		Object.assign(run, next)
		context.metric('jobs_runs_completed_total', undefined, {queue: run.queue, task: run.task})
	}
	const fail = async(run: InternalRun, error: unknown, leaseToken: string | undefined) => {
		const next = clone(run); next.failureCode = projectJobFailure(error); next.error = next.failureCode
		next.updatedAt = Math.max(context.now(), run.createdAt, run.updatedAt)
		if (next.attempt < next.maxAttempts) {
			next.status = 'retryable'; next.runAt = addJobsDuration(
				next.updatedAt, computeRetryDelay(next.attempt, next.retryPolicy), 'Jobs retry schedule'
			); clearLease(next)
			if (!leaseToken) throw new Error('Jobs retry requires a lease')
			if (!await commitTransition(
				next, async() => await context.options.backend.markRunRetryable(next, leaseToken), 'retry'
			)) {
				reportLeaseLoss(run, 'retry'); return
			}
			context.state.retriedTotal += 1
			context.metric('jobs_runs_retried_total')
			context.telemetry.emit({kind: 'execution', result: 'retryable'})
			context.log('warn', 'jobs.run.retry_scheduled', {attempt: next.attempt, runAt: next.runAt})
		} else {
			const failureCode = next.failureCode ?? next.error ?? 'JOB_FAILED'
			const dead: StoredDeadLetter = {id: randomUUID(), runId: next.id, queue: next.queue, task: next.task, failureCode, reason: failureCode, attempts: next.attempt, failedAt: next.updatedAt, payload: clone(next.payload)}
			next.status = 'dead-lettered'; next.terminalAt = next.updatedAt; clearLease(next)
			next.terminalExpiresAt = context.options.terminalRetentionMs === undefined ? undefined
				: addJobsDuration(next.updatedAt, context.options.terminalRetentionMs, 'Jobs terminal expiry')
			if (!leaseToken) throw new Error('Jobs dead-lettering requires a lease')
			if (!await commitTransition(
				next,
				async() => await context.options.backend.deadLetterRun(next, leaseToken, dead),
				'dead-letter'
			)) { reportLeaseLoss(run, 'dead-letter'); return }
			context.state.deadLetteredTotal += 1
			context.metric('jobs_runs_dead_lettered_total')
			context.log('error', 'jobs.run.dead_lettered', {attempt: next.attempt})
		}
		Object.assign(run, next)
		if (next.status === 'dead-lettered') context.report(error, 'task-run')
	}
	const runWithSignal = async(run: InternalRun): Promise<JobResult> => {
		const registration = context.tasks.get(run.task); if (!registration) throw new Error('Task not registered')
		const controller = new AbortController()
		context.state.activeControllers.set(run.id, controller)
		context.state.activeRunSchedules.set(run.id, run.scheduleId)
		let timeout: ReturnType<typeof setTimeout> | undefined
		let timedOut = false
		try {
			const execute = async() => await registration.handler({runId: run.id, attempt: run.attempt, queue: run.queue, payload: clone(run.payload), signal: controller.signal})
			let execution: Promise<JobResult> | undefined
			const invoke = () => execution ??= Promise.resolve().then(execute)
			let observed: Promise<JobResult>
			let inSpan: Tracing['inSpan'] | undefined
			let withExtractedHeaders: JobsTracing['withExtractedHeaders'] | undefined
			const tracer = context.getTracer()
			try {
				inSpan = tracer?.inSpan
				withExtractedHeaders = tracer?.withExtractedHeaders
			} catch(error) { context.report(error, 'tracing', {runId: run.id}) }
			if (typeof inSpan === 'function' && context.activeTracingOperations.size < MAX_ACTIVE_JOBS_TRACING_OPERATIONS) {
				let tracing: Promise<JobResult> | undefined
				try {
					let carrier: Record<string, string> = {}
					try {
						const stored = snapshotJobTraceContext(run.traceContext)
						if (stored) carrier = {...stored}
					} catch(error) { context.report(error, 'tracing', {runId: run.id}) }
					const enter = () => inSpan!.call(tracer, 'jobs.task', () => invoke(), {
						kind: 'consumer', attributes: context.sanitizeAttributes({
							runId: run.id, queue: run.queue, task: run.task
						}) as never
					})
					tracing = Promise.resolve((typeof withExtractedHeaders === 'function'
						? withExtractedHeaders.call(tracer, carrier, enter)
						: enter()) as Promise<JobResult>)
				} catch(error) { context.report(error, 'tracing', {runId: run.id}) }
				if (tracing) {
					const activeTracing = tracing
					context.activeTracingOperations.add(activeTracing)
					const physicalExecution = invoke()
					const tracingObservation = activeTracing.catch((error) => {
						context.report(error, 'tracing', {runId: run.id})
					}).finally(() => context.activeTracingOperations.delete(activeTracing))
					void tracingObservation.catch(() => undefined)
					observed = physicalExecution
				} else observed = invoke()
			} else observed = invoke()
			const taskOwnership = observed.then(() => undefined, () => undefined)
			context.activeTaskOperations.add(taskOwnership)
			void taskOwnership.finally(() => {
				context.activeTaskOperations.delete(taskOwnership)
				if (timedOut) {
					context.state.timedOutRunIds.delete(run.id)
					if (context.state.timedOutTaskOperations.get(run.id) === taskOwnership) {
						context.state.timedOutTaskOperations.delete(run.id)
					}
				}
			})
			if (!registration.definition.timeoutMs) return await observed
			const deadline = new Promise<Error>((resolve) => {
				timeout = setTimeout(() => {
					const error = new Error(`Job timed out after ${registration.definition.timeoutMs}ms`)
					timedOut = true
					context.state.timedOutRunIds.add(run.id)
					context.state.timedOutTaskOperations.set(run.id, taskOwnership)
					controller.abort(error); resolve(error)
				}, registration.definition.timeoutMs)
			})
			const outcome = await Promise.race([
				observed.then((value) => ({kind: 'result' as const, value})),
				deadline.then((error) => ({kind: 'timeout' as const, error}))
			])
			if (outcome.kind === 'result') return outcome.value
			// Timeout closes logical success but not physical ownership. The lease and
			// concurrency permit remain held until the handler settles, preventing a
			// retry from overlapping application side effects that ignored abort.
			await observed.catch(() => undefined)
			throw outcome.error
		} finally {
			if (timeout) clearTimeout(timeout)
			context.state.activeControllers.delete(run.id)
			context.state.activeRunSchedules.delete(run.id)
		}
	}
	const execute = async(run: InternalRun) => {
		if (context.state.recentlyCancelledRunIds.delete(run.id)) return
		const leaseToken = run.leaseToken
		let renewal: Promise<void> | undefined
		let renewalGuard: Promise<void> | undefined
		let renewalGeneration = 0
		let leaseActive = true
		let renewalsEnabled = true
		const recoverRenewal = async(error: unknown, token: string, expires: number): Promise<boolean> => {
			let current
			try {
				current = await withJobsTimeout(
					Promise.resolve(context.options.backend.getRun(run.id)),
					renewalIntervalMs,
					'Jobs lease renewal recovery timed out'
				)
			} catch(recoveryError) {
				context.report(new AggregateError([error, recoveryError], 'Jobs lease renewal recovery failed'), 'renew-lease', {runId: run.id})
				return false
			}
			if (current) validateStoredJobRun(current)
			if (current?.status !== 'running' || current.leaseToken !== token
				|| current.leaseExpiresAt === undefined || current.leaseExpiresAt < expires) {
				context.report(error, 'renew-lease', {runId: run.id})
				return false
			}
			run.leaseExpiresAt = current.leaseExpiresAt
			run.lastHeartbeatAt = current.lastHeartbeatAt
			run.updatedAt = current.updatedAt
			return true
		}
		const renewLease = (): void => {
			try {
				if (!renewalsEnabled || !leaseActive || !run.leaseToken || run.status !== 'running' || renewal) return
				const generation = ++renewalGeneration
				const token = run.leaseToken
				const renewalNow = context.now()
				const expires = Math.max(
					run.leaseExpiresAt ?? 0,
					addJobsDuration(renewalNow, leaseMs, 'Jobs lease renewal')
				)
				const rawRenewal = context.trackMutation(() => Promise.resolve(
					context.options.backend.renewLease(run.id, token, expires, renewalNow)
				), true)
				const operation = rawRenewal.then(async(value) => {
					if (generation !== renewalGeneration) return
					const renewed = requireBackendBoolean(value, 'lease renewal')
					if (!leaseActive || run.status !== 'running' || run.leaseToken !== token) return
					if (!renewed) {
						if (await recoverRenewal(
							new Error('Jobs lease renewal returned an ambiguous negative result'),
							token,
							expires
						)) return
						if (generation !== renewalGeneration || !leaseActive
							|| run.status !== 'running' || run.leaseToken !== token) return
						leaseActive = false
						context.state.activeControllers.get(run.id)?.abort(new Error('Jobs lease lost'))
					}
					else {
						run.leaseExpiresAt = expires
						run.lastHeartbeatAt = Math.max(run.lastHeartbeatAt ?? 0, renewalNow)
						run.updatedAt = Math.max(run.updatedAt, renewalNow)
					}
				}).catch(async(error) => {
					if (generation !== renewalGeneration) return
					if (!leaseActive || run.status !== 'running' || run.leaseToken !== token) return
					if (await recoverRenewal(error, token, expires)) return
					leaseActive = false
					context.state.activeControllers.get(run.id)?.abort(new Error('Jobs lease renewal failed'))
				})
				const ownedRenewal = operation.finally(() => { if (renewal === ownedRenewal) renewal = undefined })
				renewal = ownedRenewal
				const guard = withJobsTimeout(renewal, renewalIntervalMs, 'Jobs lease renewal timed out')
					.catch(async(error) => {
						if (generation !== renewalGeneration) return
						if (!leaseActive || run.status !== 'running' || run.leaseToken !== token) return
						if (await recoverRenewal(error, token, expires)) {
							// The write committed but its provider response is still pending.
							// Fence that stale observation and allow the next heartbeat to
							// extend the recovered lease again. A late false/error from the
							// old request must not revoke a newer successful renewal.
							if (generation === renewalGeneration) {
								renewalGeneration += 1
								renewal = undefined
								queueMicrotask(renewLease)
							}
							return
						}
						leaseActive = false
						context.state.activeControllers.get(run.id)?.abort(new Error('Jobs lease renewal failed'))
					})
				const ownedGuard = guard.finally(() => { if (renewalGuard === ownedGuard) renewalGuard = undefined })
				renewalGuard = ownedGuard
			} catch(error) {
				leaseActive = false
				context.report(error, 'renew-lease', {runId: run.id})
				context.state.activeControllers.get(run.id)?.abort(new Error('Jobs lease renewal failed'))
			}
		}
		const heartbeat = setInterval(renewLease, renewalIntervalMs)
		try {
			let output: JobResult | undefined
			let taskFailure: unknown
			let taskFailed = false
			try {
				output = snapshotJobResult(await runWithSignal(run))
			} catch(error) { taskFailed = true; taskFailure = error }
			// A timeout only ends logical observation of the task. Keep the durable
			// lease and running state until the handler physically settles, otherwise
			// another worker can reclaim the retry while the timed-out attempt still
			// performs side effects.
			const timedOutTask = context.state.timedOutTaskOperations.get(run.id)
			if (timedOutTask) await timedOutTask
			renewalsEnabled = false
			const pendingRenewal = renewalGuard
			if (pendingRenewal) await pendingRenewal
			if (!leaseActive) {
				const locallyCancelled = context.state.locallyCancelledActiveRunIds.has(run.id)
				const current = locallyCancelled ? undefined : await context.options.backend.getRun(run.id)
				if (current) validateStoredJobRun(current)
				if (locallyCancelled || current?.status === 'cancelled') return
				throw new Error('Jobs lease renewal failed')
			}
			if (taskFailed) await fail(run, taskFailure, leaseToken)
			else await complete(run, output, leaseToken)
		} finally {
			clearInterval(heartbeat)
			context.state.locallyCancelledActiveRunIds.delete(run.id)
		}
	}
	const dispatch = async() => {
		const maximum = context.options.maxConcurrentRuns ?? 4
		// Timed-out handlers now remain inside their execution until physical
		// settlement, so active executions are the complete local ownership count.
		const locallyOwned = context.activeExecutions.size
		const availableSlots = Math.max(0, maximum - locallyOwned)
		if (availableSlots === 0) return
		const limits = Object.fromEntries([...context.tasks].flatMap(([name, task]) => {
			if (!task.definition.concurrency) return []
			return [[name, task.definition.concurrency]]
		}))
		const claimed = await context.options.backend.claimDueRuns({
			now: context.now(),
			workerId: context.workerId,
			limit: availableSlots,
			maxConcurrentRuns: maximum,
			leaseMs,
			allowedTasks: [...context.tasks.keys()],
			concurrencyByTask: limits
		})
		const releaseClaims = async(runs: readonly InternalRun[]): Promise<void> => {
			const unique = new Map(runs.map((run) => [run.id, run]))
			const releases = await Promise.allSettled([...unique.values()].map(async(run) => {
				const token = run.leaseToken
				if (!token || run.status !== 'running' || run.leaseOwner !== context.workerId) return
				if (!requireBackendBoolean(
					await context.options.backend.releaseClaim(run.id, token, context.now()), 'claim release'
				)) {
					throw new Error('Jobs lease lost while releasing an invalid claim batch')
				}
			}))
			for (const result of releases) if (result.status === 'rejected') {
				context.report(result.reason, 'release-invalid-claim')
			}
		}
		let runs: InternalRun[]
		try {
			if (!Array.isArray(claimed) || claimed.length > availableSlots) {
				throw new Error('Jobs backend returned an invalid claim batch')
			}
			validateJobsCollectionSize(claimed, 'claim batch')
			const claimValidationNow = context.now()
			for (const run of claimed) {
				try { validateStoredJobRun(run) } catch { throw new Error('Jobs backend returned an invalid claim batch') }
				if (run.status !== 'running' || run.leaseOwner !== context.workerId || run.attempt <= 0
					|| run.leaseExpiresAt === undefined
					|| run.leaseExpiresAt - claimValidationNow <= renewalIntervalMs
					|| !context.tasks.has(run.task)) {
					throw new Error('Jobs backend returned an invalid claim batch')
				}
			}
			if (new Set(claimed.map((run) => run.id)).size !== claimed.length) {
				throw new Error('Jobs backend returned duplicate claimed runs')
			}
			const claimedByTask = new Map<string, number>()
			for (const run of claimed) claimedByTask.set(run.task, (claimedByTask.get(run.task) ?? 0) + 1)
			if ([...claimedByTask].some(([task, count]) => limits[task] !== undefined && count > limits[task])) {
				throw new Error('Jobs backend returned a claim batch that exceeds task concurrency')
			}
			// A custom provider may retain the objects it returned. Never let task
			// execution mutate provider-owned state outside guarded transition methods.
			runs = claimed.map((run) => clone(run))
		} catch(error) {
			if (Array.isArray(claimed)) {
				const releasable = claimed.filter((run): run is InternalRun => {
					if (!run || typeof run !== 'object' || Array.isArray(run)) return false
					const candidate = run as Partial<InternalRun>
					try {
						validateResourceId(candidate.id, 'run id')
						validateResourceId(candidate.leaseToken, 'lease token')
					} catch { return false }
					return candidate.status === 'running' && candidate.leaseOwner === context.workerId
				})
				await releaseClaims(releasable)
			}
			throw error
		}
		const timedOutRuns = runs.filter((run) => context.state.timedOutRunIds.has(run.id))
		if (timedOutRuns.length > 0) {
			const timedOutRunIds = new Set(timedOutRuns.map((run) => run.id))
			await releaseClaims(timedOutRuns)
			runs = runs.filter((run) => !timedOutRunIds.has(run.id))
		}
		if (context.state.cancellationFenceOverflow) {
			let verifiedRuns: InternalRun[] | undefined
			for (let attempt = 0; attempt < 3 && !verifiedRuns; attempt += 1) {
				const generation = context.state.cancellationFenceGeneration
				let currentRuns: Array<InternalRun | undefined>
				try {
					currentRuns = await Promise.all(runs.map((run) => context.options.backend.getRun(run.id)))
				} catch(error) {
					await releaseClaims(runs)
					throw error
				}
				let candidates: InternalRun[]
				try {
					candidates = runs.filter((run, index) => {
						const current = currentRuns[index]
						if (!current) return false
						validateStoredJobRun(current)
						if (current.status !== 'running' || current.leaseToken !== run.leaseToken) return false
						if (!isDeepStrictEqual(current, run)) {
							throw new Error('Jobs backend returned an inconsistent claimed run point-read')
						}
						return true
					})
				} catch(error) {
					await releaseClaims(runs)
					throw error
				}
				if (generation === context.state.cancellationFenceGeneration) verifiedRuns = candidates
			}
			if (!verifiedRuns) {
				// Cancellation traffic changed throughout every verification window.
				// Release ownership and retry on a later tick instead of executing from
				// a point-read that may already be stale.
				await releaseClaims(runs)
				return
			}
			runs = verifiedRuns
			context.state.cancellationFenceOverflow = false
		}
		if (!context.control.started || context.control.destroyed || context.control.draining) {
			await releaseClaims(runs)
			return
		}
		for (const run of runs) {
			if (context.state.recentlyCancelledRunIds.delete(run.id)) continue
			const promise = execute(run).catch((error) => {
				context.report(error, 'execution', {runId: run.id})
				if (context.state.executionFailures.length >= 1_024) context.state.executionFailures.shift()
				context.state.executionFailures.push(context.diagnosticError('execution'))
			}).finally(() => {
				context.activeExecutions.delete(promise)
				context.telemetry.emit({kind: 'active', count: context.activeExecutions.size})
			})
			context.activeExecutions.add(promise)
			context.telemetry.emit({kind: 'active', count: context.activeExecutions.size})
		}
		context.state.recentlyCancelledRunIds.clear()
	}
	return {dispatch}
}
