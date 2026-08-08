/* eslint-disable @stylistic/max-len */
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

import type {
	JobStatus,
	QueueStats
} from '@ooopsstudio/core/contracts/jobs'

import {tryAddJobsCollectionRecordSize} from '../../core/handler-collection-limits'
import {validateDeadLetterForRun, validateDeadLetterRequeue} from '../../core/handler-dead-letter-validation'
import {addJobsDuration, clone, isTerminal, validateJobsNamespace, validateRunTransition, validateScheduledRun, validateStoredJobRun} from '../../core/handler-helpers'
import {matchesRunQuery, matchesScheduleQuery, paginate} from '../../core/handler-query-helpers'
import {validateRunTransitionIdentity} from '../../core/handler-run-transition'
import {validateStoredSchedule} from '../../core/handler-schedule-validation'
import type {
	AppendRunIdempotency,
	FlatJobsBackendRuntime,
	JobsBackend,
	StoredDeadLetter,
	StoredJobRun,
	StoredSchedule,
	TriggeredScheduleResult
} from '../../types/backend'
import type {JobsMemoryBackendOptions} from '../../types/jobs'
import {getNextScheduleTime, getNextScheduleTimeAfterTrigger} from '../../utils/cron'
import {snapshotJobsOptions} from '../../utils/options'

import {composeJobsBackend} from './backend-input-guard'
import {shouldTriggerSkippedMisfire, validateAppendInput, validateClaimRelease, validateClaimRequest, validateLeaseMutation, validateRecoveryRequest, validateTriggeredSchedulePolicy, validateTriggerRequest} from './backend-validation'
import {
	cloneMemoryStorageBudget,
	commitMemoryStorageBudget,
	createMemoryStorageBudget,
	type MemoryStorageBudget,
	type MemoryStorageChange,
	tryCommitMemoryStorageBudget
} from './memory-storage-budget'

interface MemoryState {
	runs: Map<string, StoredJobRun>
	schedules: Map<string, StoredSchedule>
	deadLetters: Map<string, StoredDeadLetter>
	idempotency: Map<string, AppendRunIdempotency & {runId: string}>
	pausedQueues: Set<string>
	budget: MemoryStorageBudget
}

const MAX_MEMORY_RUNS = 10_000
const MAX_MEMORY_SCHEDULES = 1_000
const MAX_MEMORY_DEAD_LETTERS = 10_000
const MAX_MEMORY_IDEMPOTENCY_KEYS = 10_000
const MAX_MEMORY_PAUSED_QUEUES = 1_000
const MAX_MEMORY_QUEUES = 1_000
const MAX_MEMORY_SCHEDULE_RUNS_PER_BATCH = 48

export function createMemoryJobsBackend(_options: JobsMemoryBackendOptions = {}): JobsBackend {
	const options = snapshotJobsOptions<JobsMemoryBackendOptions>(
		_options, new Set(['namespace']), 'Memory jobs backend options'
	)
	if (options.namespace !== undefined) validateJobsNamespace(options.namespace, 'Memory jobs backend namespace')
	const state: MemoryState = {
		runs: new Map(), schedules: new Map(), deadLetters: new Map(), idempotency: new Map(),
		pausedQueues: new Set(), budget: createMemoryStorageBudget()
	}
	const knownQueues = (): Set<string> => new Set([
		...state.pausedQueues,
		...[...state.runs.values()].map((run) => run.queue)
	])
	const assertQueueCapacity = (queues: Iterable<string>): void => {
		const known = knownQueues()
		for (const queue of queues) known.add(queue)
		if (known.size > MAX_MEMORY_QUEUES) throw new Error('Memory jobs queue capacity exceeded')
	}
	const setRun = (run: StoredJobRun): StoredJobRun => {
		const current = state.runs.get(run.id)
		if (!current || current.queue !== run.queue) assertQueueCapacity([run.queue])
		const stored = clone(run)
		commitMemoryStorageBudget(state.budget, [{bucket: 'runs', key: run.id, value: stored}])
		state.runs.set(run.id, stored)
		return stored
	}
	const append = (
		run: StoredJobRun,
		idempotency?: AppendRunIdempotency,
		capacityCredit = 0,
		budgetRemovals: readonly MemoryStorageChange[] = []
	) => {
		validateAppendInput(run, idempotency)
		if (idempotency) {
			const existing = state.idempotency.get(idempotency.key)
			if (existing && existing.expiresAt > run.createdAt) {
				if (existing.checksum !== idempotency.checksum) throw new Error(`Idempotency key reused with different payload: ${idempotency.key}`)
				const existingRun = state.runs.get(existing.runId)
				if (existingRun) return {run: clone(existingRun), existing: true}
				throw new Error('Jobs idempotency record references a missing run')
			}
		}
		if (state.runs.has(run.id)) throw new Error(`Jobs run id already exists: ${run.id}`)
		assertQueueCapacity([run.queue])
		if (state.runs.size >= MAX_MEMORY_RUNS + capacityCredit) throw new Error('Memory jobs run capacity exceeded')
		const removedIdempotency = new Set(budgetRemovals
			.filter((change) => change.bucket === 'idempotency' && change.remove)
			.map((change) => change.key))
		if (idempotency && !state.idempotency.has(idempotency.key)
			&& state.idempotency.size - removedIdempotency.size >= MAX_MEMORY_IDEMPOTENCY_KEYS) {
			throw new Error('Memory jobs idempotency capacity exceeded')
		}
		const storedRun = clone(run)
		const idempotencyRecord = idempotency ? {...idempotency, runId: run.id} : undefined
		const effectiveRemovals = budgetRemovals.filter((change) => !(idempotencyRecord
			&& change.bucket === 'idempotency' && change.key === idempotencyRecord.key))
		commitMemoryStorageBudget(state.budget, [
			...effectiveRemovals,
			{bucket: 'runs', key: run.id, value: storedRun},
			...(idempotencyRecord ? [{
				bucket: 'idempotency' as const, key: idempotency!.key, value: idempotencyRecord
			}] : [])
		])
		if (idempotencyRecord) state.idempotency.set(idempotency!.key, idempotencyRecord)
		state.runs.set(run.id, storedRun)
		return {run: clone(storedRun), existing: false}
	}
	const transition = (run: StoredJobRun, token: string): boolean => {
		const current = state.runs.get(run.id)
		if (!current || current.status !== 'running' || current.leaseToken !== token
			|| current.leaseExpiresAt === undefined || current.leaseExpiresAt <= run.updatedAt) return false
		validateRunTransitionIdentity(current, run)
		setRun(run); return true
	}
	const queueStats = (queue: string | undefined, now = Date.now()): QueueStats[] => {
		const result = new Map<string, QueueStats>()
		const ensure = (name: string) => {
			const existing = result.get(name); if (existing) return existing
			const created: QueueStats = {queue: name, queued: 0, running: 0, retryable: 0, deadLettered: 0, completed: 0, failed: 0, cancelled: 0, paused: state.pausedQueues.has(name), lagMs: 0}
			result.set(name, created); return created
		}
		for (const name of state.pausedQueues) if (!queue || queue === name) ensure(name)
		for (const run of state.runs.values()) {
			if (queue && run.queue !== queue) continue
			const stats = ensure(run.queue)
			stats[run.status === 'dead-lettered' ? 'deadLettered' : run.status as Exclude<JobStatus, 'dead-lettered'>] += 1
			if ((run.status === 'queued' || run.status === 'retryable') && run.runAt <= now) stats.lagMs = Math.max(stats.lagMs, now - run.runAt)
		}
		return [...result.values()]
	}
	const backend: FlatJobsBackendRuntime = {
		durability: 'ephemeral',
		async appendRun(run, idempotency) { return append(run, idempotency) },
		async getRun(id) { const run = state.runs.get(id); return run ? clone(run) : undefined },
		async listRuns(query) { return paginate([...state.runs.values()].filter((run) => matchesRunQuery(run, query)).sort((left, right) => left.runAt - right.runAt || left.id.localeCompare(right.id)), query?.offset, query?.limit).map(clone) },
		async claimDueRuns(request) {
			validateClaimRequest(request)
			const claimed: StoredJobRun[] = []
			let claimedBytes = 0
			const allowedTasks = request.allowedTasks && new Set(request.allowedTasks)
			const taskActive = new Map<string, number>()
			for (const run of state.runs.values()) if (run.status === 'running') {
				if (request.concurrencyByTask?.[run.task] !== undefined) {
					taskActive.set(run.task, (taskActive.get(run.task) ?? 0) + 1)
				}
			}
			const globalActive = [...state.runs.values()].filter((run) => run.status === 'running').length
			const capacity = Math.min(request.limit, Math.max(0, request.maxConcurrentRuns - globalActive))
			const candidates = [...state.runs.values()].filter((run) => (run.status === 'queued' || run.status === 'retryable')
				&& run.runAt <= request.now && !state.pausedQueues.has(run.queue)
				&& !(run.status === 'retryable' && run.attempt >= run.maxAttempts)
				&& (!allowedTasks || allowedTasks.has(run.task))).sort((a, b) => b.priority - a.priority || a.runAt - b.runAt || a.id.localeCompare(b.id))
			for (const current of candidates) {
				if (claimed.length >= capacity) break
				const limit = request.concurrencyByTask?.[current.task]
				if (limit !== undefined && (taskActive.get(current.task) ?? 0) >= limit) continue
				const run = clone(current)
				const transitionAt = Math.max(request.now, run.createdAt, run.updatedAt)
				run.status = 'running'; run.attempt += 1; run.startedAt ??= transitionAt; run.updatedAt = transitionAt
				run.leaseOwner = request.workerId; run.leaseToken = randomUUID()
				run.leaseExpiresAt = addJobsDuration(transitionAt, request.leaseMs, 'Jobs lease'); run.lastHeartbeatAt = transitionAt
				validateStoredJobRun(run)
				const nextBytes = tryAddJobsCollectionRecordSize(claimedBytes, run, 'memory claim batch')
				if (nextBytes === undefined) break
				claimedBytes = nextBytes
				claimed.push(run)
				taskActive.set(run.task, (taskActive.get(run.task) ?? 0) + 1)
			}
			commitMemoryStorageBudget(state.budget, claimed.map((run) => ({
				bucket: 'runs', key: run.id, value: run
			})))
			for (const run of claimed) state.runs.set(run.id, clone(run))
			return claimed.map(clone)
		},
		async releaseClaim(id, token, now) {
			validateClaimRelease(id, token, now)
			const current = state.runs.get(id)
			if (!current || current.status !== 'running' || current.leaseToken !== token) return false
			const run = clone(current)
			run.attempt -= 1
			run.status = run.attempt === 0 ? 'queued' : 'retryable'
			run.updatedAt = Math.max(now, run.createdAt, run.updatedAt)
			if (run.attempt === 0) run.startedAt = undefined
			run.leaseOwner = undefined; run.leaseToken = undefined
			run.leaseExpiresAt = undefined; run.lastHeartbeatAt = undefined
			validateStoredJobRun(run)
			setRun(run)
			return true
		},
		async renewLease(id, token, expiresAt, now) { validateLeaseMutation(id, token, expiresAt, now); const current = state.runs.get(id); if (!current || current.status !== 'running' || current.leaseToken !== token || !current.leaseExpiresAt || current.leaseExpiresAt <= now) return false; const run = clone(current); run.leaseExpiresAt = Math.max(current.leaseExpiresAt, expiresAt); run.lastHeartbeatAt = Math.max(current.lastHeartbeatAt ?? 0, now); run.updatedAt = Math.max(current.updatedAt, now); setRun(run); return true },
		async completeRun(run, token) { validateRunTransition(run, 'completed'); return transition(run, token) },
		async markRunRetryable(run, token) { validateRunTransition(run, 'retryable'); return transition(run, token) },
		async deadLetterRun(run, token, dead) { validateRunTransition(run, 'dead-lettered'); validateDeadLetterForRun(run, dead); const current = state.runs.get(run.id); if (!current || current.status !== 'running' || current.leaseToken !== token || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= run.updatedAt) return false; validateRunTransitionIdentity(current, run); if (state.deadLetters.has(dead.id)) throw new Error(`Jobs dead-letter id already exists: ${dead.id}`); if (state.deadLetters.size >= MAX_MEMORY_DEAD_LETTERS) throw new Error('Memory jobs dead-letter capacity exceeded'); const storedRun = clone(run); const storedDead = clone(dead); commitMemoryStorageBudget(state.budget, [{bucket: 'runs', key: run.id, value: storedRun}, {bucket: 'deadLetters', key: dead.id, value: storedDead}]); state.runs.set(run.id, storedRun); state.deadLetters.set(dead.id, storedDead); return true },
		async cancelRun(id, reason, token, now, terminalExpiresAt) { const current = state.runs.get(id); if (!current || isTerminal(current) || (token && current.leaseToken !== token)) return false; const run = clone(current); const transitionAt = Math.max(current.createdAt, current.updatedAt, now); run.status = 'cancelled'; run.cancelReason = reason; run.updatedAt = transitionAt; run.terminalAt = transitionAt; run.terminalExpiresAt = terminalExpiresAt === undefined ? undefined : Math.max(terminalExpiresAt, transitionAt); run.leaseOwner = undefined; run.leaseToken = undefined; run.leaseExpiresAt = undefined; run.lastHeartbeatAt = undefined; setRun(run); return true },
		async recoverStaleLeases(now, recoveryAfterMs, terminalExpiresAt) {
			validateRecoveryRequest(now, recoveryAfterMs, terminalExpiresAt)
			const recoveredRuns: StoredJobRun[] = []
			const recoveredDeadLetters: StoredDeadLetter[] = []
			const recoveryBudget = cloneMemoryStorageBudget(state.budget)
			for (const current of state.runs.values()) {
				if (recoveredRuns.length >= 1_000) break
				if (current.status !== 'running' || current.leaseExpiresAt === undefined
					|| now < recoveryAfterMs || current.leaseExpiresAt > now - recoveryAfterMs) continue
				const run = clone(current)
				const transitionAt = Math.max(now, run.createdAt, run.updatedAt)
				const exhausted = run.attempt >= run.maxAttempts
				if (exhausted && state.deadLetters.size + recoveredDeadLetters.length >= MAX_MEMORY_DEAD_LETTERS) {
					// Keep the fenced running record intact and retry after retention frees
					// a dead-letter slot. One saturated bucket must not block recovery of
					// unrelated retryable runs or the scheduler's claim stage.
					continue
				}
				run.status = exhausted ? 'dead-lettered' : 'retryable'
				run.runAt = transitionAt; run.updatedAt = transitionAt
				run.leaseOwner = undefined; run.leaseToken = undefined; run.leaseExpiresAt = undefined; run.lastHeartbeatAt = undefined
				let dead: StoredDeadLetter | undefined
				if (exhausted) {
					run.failureCode = 'lease-expired'; run.error = 'lease-expired'; run.terminalAt = transitionAt
					run.terminalExpiresAt = terminalExpiresAt === undefined
						? undefined : Math.max(terminalExpiresAt, transitionAt)
					const candidateDead: StoredDeadLetter = {
						id: randomUUID(), runId: run.id, queue: run.queue, task: run.task,
						failureCode: 'lease-expired', reason: 'lease-expired', attempts: run.attempt,
						failedAt: transitionAt, payload: clone(run.payload)
					}
					if (state.deadLetters.has(candidateDead.id)
						|| recoveredDeadLetters.some((candidate) => candidate.id === candidateDead.id)) {
						throw new Error(`Jobs dead-letter id already exists: ${candidateDead.id}`)
					}
					validateStoredJobRun(run); validateDeadLetterForRun(run, candidateDead)
					dead = candidateDead
				} else validateStoredJobRun(run)
				try {
					commitMemoryStorageBudget(recoveryBudget, [
						{bucket: 'runs', key: run.id, value: run},
						...(dead ? [{bucket: 'deadLetters' as const, key: dead.id, value: dead}] : [])
					])
				} catch(error) {
					if (error instanceof Error
						&& error.message === 'Memory jobs serialized storage capacity exceeded') continue
					throw error
				}
				if (dead) recoveredDeadLetters.push(dead)
				recoveredRuns.push(run)
			}
			commitMemoryStorageBudget(state.budget, [
				...recoveredRuns.map((run) => ({bucket: 'runs' as const, key: run.id, value: run})),
				...recoveredDeadLetters.map((dead) => ({
					bucket: 'deadLetters' as const, key: dead.id, value: dead
				}))
			])
			for (const run of recoveredRuns) state.runs.set(run.id, clone(run))
			for (const dead of recoveredDeadLetters) state.deadLetters.set(dead.id, clone(dead))
			return recoveredRuns.length
		},
		async saveSchedule(schedule, expected) { validateStoredSchedule(schedule); const current = state.schedules.get(schedule.id); if ((expected === null && current) || (expected && (!current || !isDeepStrictEqual(current, expected)))) return false; if (!current && state.schedules.size >= MAX_MEMORY_SCHEDULES) throw new Error('Memory jobs schedule capacity exceeded'); const stored = clone(schedule); commitMemoryStorageBudget(state.budget, [{bucket: 'schedules', key: schedule.id, value: stored}]); state.schedules.set(schedule.id, stored); return true },
		async setScheduleEnabled(id, enabled, nextRunAt, expected) { const current = state.schedules.get(id); if (!current) return false; if (expected && !isDeepStrictEqual(current, expected)) return false; const schedule = clone(current); schedule.enabled = enabled; if (enabled) schedule.nextRunAt = nextRunAt; commitMemoryStorageBudget(state.budget, [{bucket: 'schedules', key: id, value: schedule}]); state.schedules.set(id, schedule); return true },
		async getSchedule(id) { const value = state.schedules.get(id); return value ? clone(value) : undefined },
		async listSchedules(query) { return clone(paginate([...state.schedules.values()].filter((item) => matchesScheduleQuery(item, query)).sort((left, right) => left.id.localeCompare(right.id)), query?.offset, query?.limit)) },
		async deleteSchedule(id) { commitMemoryStorageBudget(state.budget, [{bucket: 'schedules', key: id, remove: true}]); state.schedules.delete(id) },
		async triggerDueSchedules(request) {
			validateTriggerRequest(request)
			const allowedTasks = request.allowedTasks && new Set(request.allowedTasks)
			const allowedMisfire = request.allowedMisfire && new Set(request.allowedMisfire)
			const allowedOverlap = request.allowedOverlap && new Set(request.allowedOverlap)
			const results: TriggeredScheduleResult[] = []
			const scheduleUpdates = new Map<string, StoredSchedule>()
			const runUpdates = new Map<string, StoredJobRun>()
			const newRunIds = new Set<string>()
			let resultBytes = 0
			let generatedRunBudget = Math.min(
				MAX_MEMORY_SCHEDULE_RUNS_PER_BATCH,
				MAX_MEMORY_RUNS - state.runs.size
			)
			const activeBySchedule = new Map<string, StoredJobRun[]>()
			for (const run of state.runs.values()) if (run.scheduleId && !isTerminal(run)) {
				const active = activeBySchedule.get(run.scheduleId) ?? []
				active.push(run); activeBySchedule.set(run.scheduleId, active)
			}
			const dueSchedules: Array<{schedule: StoredSchedule; dueAt: number}> = []
			for (const currentSchedule of state.schedules.values()) {
				if (allowedTasks && !allowedTasks.has(currentSchedule.task)) continue
				if (allowedMisfire
					&& !allowedMisfire.has(currentSchedule.policy?.misfire ?? 'fire-once')) continue
				if (allowedOverlap
					&& !allowedOverlap.has(currentSchedule.policy?.overlap ?? 'queue')) continue
				const schedule = clone(currentSchedule)
				if (schedule.enabled === false) continue
				const dueAt = schedule.nextRunAt ?? getNextScheduleTime(schedule, request.now, true)
				if (dueAt === undefined || dueAt > request.now) {
					schedule.nextRunAt = dueAt
					scheduleUpdates.set(schedule.id, schedule)
					continue
				}
				if ((schedule.policy?.overlap ?? 'queue') === 'queue'
					&& (activeBySchedule.get(schedule.id)?.length ?? 0) > 0) continue
				dueSchedules.push({schedule, dueAt})
			}
			dueSchedules.sort((left, right) => left.dueAt - right.dueAt
				|| left.schedule.id.localeCompare(right.schedule.id))
			const plannedBudget = cloneMemoryStorageBudget(state.budget)
			const reservedQueues = knownQueues()
			commitMemoryStorageBudget(plannedBudget, [...scheduleUpdates].map(([key, value]) => ({
				bucket: 'schedules' as const, key, value
			})))
			for (const {schedule, dueAt} of dueSchedules) {
				if (generatedRunBudget === 0) break
				validateTriggeredSchedulePolicy(schedule, request)
				const active = activeBySchedule.get(schedule.id) ?? []
				const overlap = schedule.policy?.overlap ?? 'queue'; const misfire = schedule.policy?.misfire ?? 'fire-once'; const times: number[] = []
				if (overlap === 'queue' && active.length > 0) {
					const result = {schedule: clone(schedule), triggerTimes: [], runs: []}
					const nextBytes = tryAddJobsCollectionRecordSize(
						resultBytes, result, 'memory schedule trigger results'
					)
					if (nextBytes === undefined) continue
					resultBytes = nextBytes; results.push(result)
					continue
				}
				if (!(overlap === 'skip' && active.length)) {
					if (misfire === 'catch-up') { const maximum = overlap === 'queue' ? 1 : Math.min(request.maxCatchUp, generatedRunBudget); let cursor: number | undefined = dueAt; while (cursor !== undefined && cursor <= request.now && times.length < maximum) { times.push(cursor); cursor = getNextScheduleTime(schedule, cursor) } }
					if (misfire === 'fire-once' && generatedRunBudget > 0) times.push(dueAt)
					if (misfire === 'skip' && generatedRunBudget > 0 && shouldTriggerSkippedMisfire(dueAt, request)) times.push(dueAt)
				}
				generatedRunBudget -= times.length
				const runs = times.map((time) => request.createRun(clone(schedule), time))
				for (let index = 0; index < runs.length; index++) validateScheduledRun(runs[index], schedule, times[index]!)
				if (new Set(runs.map((run) => run.id)).size !== runs.length
					|| runs.some((run) => state.runs.has(run.id) || newRunIds.has(run.id))) {
					throw new Error('Jobs schedule produced duplicate run ids')
				}
				if (state.runs.size + newRunIds.size + runs.length > MAX_MEMORY_RUNS) {
					throw new Error('Memory jobs run capacity exceeded')
				}
				if (times.length > 0) schedule.lastTriggeredAt = Math.max(schedule.lastTriggeredAt ?? 0, request.now)
				schedule.nextRunAt = misfire === 'catch-up' && times.length > 0 ? getNextScheduleTime(schedule, times.at(-1)!) : getNextScheduleTimeAfterTrigger(schedule, dueAt, request.now)
				const storedRuns = runs.map(clone)
				const result = {schedule: clone(schedule), triggerTimes: times, runs: clone(runs)}
				const nextBytes = tryAddJobsCollectionRecordSize(
					resultBytes, result, 'memory schedule trigger results'
				)
				const candidateQueues = new Set(reservedQueues)
				for (const run of storedRuns) candidateQueues.add(run.queue)
				if (candidateQueues.size > MAX_MEMORY_QUEUES || nextBytes === undefined
					|| !tryCommitMemoryStorageBudget(plannedBudget, [
						{bucket: 'schedules', key: schedule.id, value: schedule},
						...storedRuns.map((run) => ({bucket: 'runs' as const, key: run.id, value: run}))
					])) { generatedRunBudget += times.length; continue }
				for (const queue of candidateQueues) reservedQueues.add(queue)
				resultBytes = nextBytes; results.push(result)
				scheduleUpdates.set(schedule.id, schedule)
				for (const run of storedRuns) { newRunIds.add(run.id); runUpdates.set(run.id, run) }
			}
			assertQueueCapacity([...runUpdates.values()].map((run) => run.queue))
			commitMemoryStorageBudget(state.budget, [
				...[...scheduleUpdates].map(([key, value]) => ({bucket: 'schedules' as const, key, value})),
				...[...runUpdates].map(([key, value]) => ({bucket: 'runs' as const, key, value}))
			])
			for (const [id, schedule] of scheduleUpdates) state.schedules.set(id, clone(schedule))
			for (const [id, run] of runUpdates) state.runs.set(id, clone(run))
			return results
		},
		async setQueuePaused(queue, paused) { if (paused) { if (!state.pausedQueues.has(queue) && state.pausedQueues.size >= MAX_MEMORY_PAUSED_QUEUES) throw new Error('Memory jobs paused-queue capacity exceeded'); assertQueueCapacity([queue]); state.pausedQueues.add(queue) } else state.pausedQueues.delete(queue) },
		async listDeadLetters(limit = 10_000) {
			return [...state.deadLetters.values()]
				.map((record): StoredDeadLetter => ({
					id: record.id, runId: record.runId, queue: record.queue, task: record.task,
					failureCode: record.failureCode ?? record.reason ?? record.error ?? 'job_failed',
					attempts: record.attempts, failedAt: record.failedAt
				}))
				.sort((left, right) => left.failedAt - right.failedAt || left.id.localeCompare(right.id))
				.slice(0, Math.min(10_000, Math.max(0, Math.floor(limit))))
		},
		async getDeadLetter(id) { const item = state.deadLetters.get(id); return item ? clone(item) : undefined },
		async requeueDeadLetter(id, run, idempotency) { const dead = state.deadLetters.get(id); if (!dead) return undefined; validateDeadLetterRequeue(run, dead); const existingIdempotency = idempotency && state.idempotency.get(idempotency.key); if (existingIdempotency && existingIdempotency.expiresAt > run.createdAt) throw new Error('Jobs dead-letter requeue idempotency key already exists'); const claims = [...state.idempotency].filter(([, record]) => record.runId === dead.runId).map(([key]) => key); const appended = append(run, idempotency, 1, [{bucket: 'deadLetters', key: id, remove: true}, {bucket: 'runs', key: dead.runId, remove: true}, ...claims.map((key) => ({bucket: 'idempotency' as const, key, remove: true}))]); state.deadLetters.delete(id); state.runs.delete(dead.runId); for (const key of claims) if (key !== idempotency?.key) state.idempotency.delete(key); return appended.run },
		async triggerScheduleNow(id, createRun) { const schedule = state.schedules.get(id); if (!schedule) return []; const run = createRun(clone(schedule)); validateScheduledRun(run, schedule, run.runAt); if (state.runs.has(run.id)) throw new Error(`Jobs run id already exists: ${run.id}`); if (state.runs.size >= MAX_MEMORY_RUNS) throw new Error('Memory jobs run capacity exceeded'); const stored = setRun(run); return [clone(stored)] },
		async getQueueStats(queue, now) { return queueStats(queue, now) },
		async cleanupTerminalRuns(now, limit) {
			let count = 0
			const protectedRuns = new Set([...state.idempotency.values()]
				.filter((record) => record.expiresAt > now).map((record) => record.runId))
			for (const [id, run] of state.runs) {
				if (count >= limit) break
				if (run.terminalExpiresAt === undefined || run.terminalExpiresAt > now
					|| protectedRuns.has(id)) continue
				const changes: MemoryStorageChange[] = [{bucket: 'runs', key: id, remove: true}]
				let deadId: string | undefined
				if (run.status === 'dead-lettered') {
					const matches = [...state.deadLetters].filter(([, dead]) => dead.runId === id)
					if (matches.length !== 1) throw new Error('Jobs dead-letter cleanup relationship is invalid')
					const [entryId, dead] = matches[0]!
					validateDeadLetterForRun(run, dead)
					if (entryId !== dead.id) throw new Error('Jobs dead-letter cleanup relationship is invalid')
					deadId = entryId
					changes.push({bucket: 'deadLetters', key: deadId, remove: true})
				}
				commitMemoryStorageBudget(state.budget, changes)
				state.runs.delete(id)
				if (deadId) state.deadLetters.delete(deadId)
				count += 1
			}
			for (const [key, record] of state.idempotency) {
				if (count >= limit) break
				if (record.expiresAt <= now) {
					commitMemoryStorageBudget(state.budget, [{bucket: 'idempotency', key, remove: true}])
					state.idempotency.delete(key); count += 1
				}
			}
			return count
		}
	}
	return composeJobsBackend(backend)
}
