
import {createHash, randomUUID} from 'node:crypto'

import type {QueueStats} from '@ooopsstudio/core/contracts/jobs'

import {addJobsCollectionRecordSize, validateJobsCollectionSize} from '../../core/handler-collection-limits'
import {validateDeadLetterRequeue} from '../../core/handler-dead-letter-validation'
import {validateJobsNamespace, validateResourceId} from '../../core/handler-helpers'
import {readJobsErrorMessage} from '../../core/handler-projections'
import type {
	FlatJobsBackendRuntime,
	JobsBackend,
	StoredJobRun,
	TriggerSchedulesRequest,
	TriggeredScheduleResult
} from '../../types/backend'
import type {JobsRedisBackendOptions} from '../../types/jobs'
import {getNextScheduleTime, getNextScheduleTimeAfterTrigger} from '../../utils/cron'
import {snapshotJobsOptions} from '../../utils/options'

import {composeJobsBackend} from './backend-input-guard'
import {
	decodeAppendResult,
	decodeDeadLetter,
	decodeDeadLetters,
	decodeProviderBoolean,
	decodeRun,
	decodeRunValue,
	decodeRuns,
	decodeSchedule,
	decodeSchedules,
	parseProviderJson,
	shouldTriggerSkippedMisfire,
	validateAppendInput,
	validateBoundedCount,
	validateClaimRelease,
	validateClaimRequest,
	validateGeneratedRun,
	validateLeaseMutation,
	validateRecoveryRequest,
	validateScheduleInput,
	validateTriggeredSchedulePolicy,
	validateStats,
	validateTriggerRequest,
	validateTransitionInput
} from './backend-validation'
import {REDIS_NATIVE_SCRIPT} from './redis-native-script'

const MAX_REDIS_OPERATION_BYTES = 16 * 1024 * 1024
const decodeExists = (value: unknown, label: string): boolean => {
	if (value === 0 || value === '0') return false
	if (value === 1 || value === '1') return true
	throw new Error(`Jobs Redis returned an invalid ${label}`)
}
const requireAcknowledgement = (value: unknown, label: string): void => {
	if (!decodeProviderBoolean(value, label)) throw new Error(`Jobs Redis rejected ${label}`)
}

function readRedisMethod(source: object, key: 'eval' | 'ping', required: boolean): Function | undefined {
	let current: object | null = source
	try {
		for (let depth = 0; current && depth < 32; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('invalid')
				return descriptor.value as Function
			}
			current = Object.getPrototypeOf(current)
		}
	} catch { throw new Error('Redis jobs backend requires stable client capabilities') }
	if (required) throw new Error(`Redis jobs backend requires ${key}() support`)
	return undefined
}

export function validateRedisOptions<T extends JobsRedisBackendOptions>(
	options: T,
	requirePing = false,
	additionalKeys: ReadonlySet<string> = new Set()
): T {
	const configured = snapshotJobsOptions<T>(
		options,
		new Set(['redis', 'namespace', ...additionalKeys]),
		'Redis jobs backend options'
	)
	if (!configured.redis || (typeof configured.redis !== 'object' && typeof configured.redis !== 'function')) {
		throw new Error(`Redis jobs backend requires ${requirePing ? 'ping() and ' : ''}eval() support`)
	}
	const source = configured.redis as object
	const evaluate = readRedisMethod(source, 'eval', false)
	const ping = readRedisMethod(source, 'ping', false)
	if (!evaluate || (requirePing && !ping)) {
		throw new Error(`Redis jobs backend requires ${requirePing ? 'ping() and ' : ''}eval() support`)
	}
	const redis = {
		eval: async<TValue = unknown>(...arguments_: Parameters<NonNullable<JobsRedisBackendOptions['redis']['eval']>>) =>
			await Reflect.apply(evaluate, configured.redis, arguments_) as TValue,
		...(ping ? {ping: async() => await Reflect.apply(ping, configured.redis, []) as boolean} : {})
	} as JobsRedisBackendOptions['redis']
	if (configured.namespace !== undefined) validateJobsNamespace(configured.namespace, 'Redis jobs backend namespace')
	return {...configured, redis}
}

export function redisJobsPrefix(namespace: string): string {
	return `jobs:{${createHash('sha256').update(namespace).digest('hex').slice(0, 32)}}`
}

export function createRedisJobsBackend(options: JobsRedisBackendOptions): JobsBackend {
	const {redis, namespace = 'jobs:scheduler'} = validateRedisOptions(options)
	const evalScript = redis.eval?.bind(redis)
	if (!evalScript) throw new Error('Redis jobs backend requires RedisPort.eval() support')
	const key = redisJobsPrefix(namespace)
	let migrationChecked: Promise<void> | undefined
	const ensureMigrated = async(): Promise<void> => {
		if (!migrationChecked) {
			const pending = (async() => {
				const legacyExists = decodeExists(await evalScript<number>('return redis.call("EXISTS", KEYS[1])', [`${namespace}:snapshot`]), 'legacy marker')
				if (legacyExists) {
					const marker = await evalScript<string | null>(
						'return redis.call("GET", KEYS[1])', [`${key}:native-v2`]
					)
					if (marker !== 'migrated') throw new Error('Legacy Jobs Redis snapshot requires migrateRedisJobsSnapshot()')
				}
				requireAcknowledgement(
					await evalScript<string>(REDIS_NATIVE_SCRIPT, [key], ['initialize', '{}']),
					'initialization result'
				)
			})()
			migrationChecked = pending
			void pending.catch(() => { if (migrationChecked === pending) migrationChecked = undefined })
		}
		return migrationChecked
	}
	const call = async<T = string>(operation: string, args: Record<string, unknown> = {}): Promise<T> => {
		const encoded = JSON.stringify(args)
		if (Buffer.byteLength(encoded) > MAX_REDIS_OPERATION_BYTES) {
			throw new Error('Jobs Redis operation exceeds the request size limit')
		}
		await ensureMigrated()
		return evalScript<T>(REDIS_NATIVE_SCRIPT, [key], [operation, encoded])
	}
	const backfillIndexes = async(operation: string, label: string, details?: Record<string, unknown>): Promise<void> => {
		for (let batch = 0; batch <= 10_000; batch += 1) {
			if (decodeProviderBoolean(
				await call<string>(operation, details), `${label} backfill result`
			)) return
		}
		throw new Error(`Jobs Redis ${label} backfill exceeded the batch limit`)
	}
	const createIndexEnsurer = (operation: string, label: string): (() => Promise<void>) => {
		let checked: Promise<void> | undefined
		return async() => {
			if (checked) return checked
			const pending = backfillIndexes(operation, label)
			checked = pending
			void pending.catch(() => { if (checked === pending) checked = undefined })
			return pending
		}
	}
	const ensureScheduleIndexes = () => backfillIndexes('bso', 'schedule index', {due: true})
	const ensureScheduleOrderIndexes = createIndexEnsurer('bso', 'schedule index')
	const ensureDeadIndexes = () => backfillIndexes('bdi', 'dead-letter index')
	const ensureTerminalIndexes = () => backfillIndexes('bti', 'terminal index')
	const ensureReadyIndexes = () => backfillIndexes('bri', 'ready index')
	const ensureRunOrderIndexes = createIndexEnsurer('bro', 'run-order index')
	const ensureRunningIndexes = () => backfillIndexes('brc', 'running-count index')
	const ensureQueueStatsIndexes = createIndexEnsurer('bqs', 'queue-stats index')
	const ensureMutableRunIndexes = async(): Promise<void> => {
		await Promise.all([ensureRunningIndexes(), ensureQueueStatsIndexes()])
	}
	const listRuns = async(query?: Parameters<FlatJobsBackendRuntime['listRuns']>[0]) => {
		const limit = Math.min(1_000, Math.max(0, query?.limit ?? 100))
		const offset = Math.max(0, query?.offset ?? 0)
		if (limit === 0 || offset >= 10_000) { await ensureMigrated(); return [] }
		await ensureRunOrderIndexes()
		if (!Array.isArray(query?.status)) return decodeRuns(await call<string>('listRuns', {query}), limit)
		const target = Math.min(10_000, offset + limit)
		const groups: StoredJobRun[][] = []
		for (const status of query.status) {
			const values: StoredJobRun[] = []
			while (values.length < target) {
				const pageLimit = Math.min(1_000, target - values.length)
				const page = decodeRuns(await call<string>('listRuns', {
					query: {...query, status, offset: values.length, limit: pageLimit}
				}), pageLimit)
				values.push(...page)
				if (page.length < pageLimit) break
			}
			groups.push(values)
			validateJobsCollectionSize(groups.flat(), 'Redis multi-status run listing')
		}
		const merged = groups.flat().sort((left, right) => left.runAt - right.runAt || left.id.localeCompare(right.id))
		if (new Set(merged.map((run) => run.id)).size !== merged.length) {
			throw new Error('Jobs provider returned duplicate runs across status indexes')
		}
		return merged.slice(offset, offset + limit)
	}
	const listSchedules = async(query?: Parameters<FlatJobsBackendRuntime['listSchedules']>[0]) => {
		const limit = Math.min(1_000, Math.max(0, query?.limit ?? 100))
		const offset = Math.max(0, query?.offset ?? 0)
		if (limit === 0 || offset >= 10_000) { await ensureMigrated(); return [] }
		await ensureScheduleOrderIndexes()
		return decodeSchedules(await call<string>('listSchedules', {query}), limit)
	}
	const queueStats = async(queue?: string, now = Date.now()): Promise<QueueStats[]> => {
		await ensureQueueStatsIndexes()
		return validateStats(parseProviderJson(await call<string>('queueStats', {queue, now}), 'queue stats'))
	}
	const claimRuns = async(request: Parameters<FlatJobsBackendRuntime['claimDueRuns']>[0]): Promise<StoredJobRun[]> => {
		validateClaimRequest(request)
		await Promise.all([ensureReadyIndexes(), ensureMutableRunIndexes()])
		const claimed: StoredJobRun[] = []
		let inspected = 0
		while (claimed.length < request.limit && inspected < 10_000) {
			const limit = request.limit - claimed.length
			const candidate = parseProviderJson(await call<string>('claim', {
				...request, limit, leaseSeed: randomUUID()
			}), 'run claims')
			if (!Array.isArray(candidate) || candidate.length > limit) throw new Error('Jobs Redis invalid claim')
			if (candidate.length === 0) break
			inspected += candidate.length
			for (const value of candidate) {
				try { claimed.push(decodeRunValue(value)) } catch {
					if (!value || typeof value !== 'object' || Array.isArray(value)) {
						throw new Error('Jobs Redis invalid claim')
					}
					const {id, leaseToken: token} = value as {id?: unknown; leaseToken?: unknown}
					validateResourceId(id, 'run id'); validateResourceId(token, 'lease token')
					const discard = {id, token}
					let acknowledgement: unknown
					try { acknowledgement = await call('discardClaim', discard) } catch {
						acknowledgement = await call('discardClaim', discard)
					}
					requireAcknowledgement(acknowledgement, 'claim discard')
				}
			}
		}
		return claimed
	}
	const triggerSchedules = async(request: TriggerSchedulesRequest): Promise<TriggeredScheduleResult[]> => {
		validateTriggerRequest(request)
		await Promise.all([ensureMutableRunIndexes(), ensureScheduleIndexes()])
		const availableRunSlots = validateBoundedCount(
			await call<string>('runSlots'), 10_000, 'available run slots'
		)
		const raw = await call<string>('claimSchedules', {
			now: request.now, seed: randomUUID(), allowedTasks: request.allowedTasks,
			allowedMisfire: request.allowedMisfire, allowedOverlap: request.allowedOverlap
		})
		const candidate = parseProviderJson(raw, 'schedule claims')
		if (!Array.isArray(candidate) || candidate.length > 100) throw new Error('Jobs provider returned invalid schedule claims')
		const results: TriggeredScheduleResult[] = []
		let resultBytes = 0
		const appendResult = (result: TriggeredScheduleResult): void => {
			resultBytes = addJobsCollectionRecordSize(resultBytes, result, 'Redis schedule trigger results')
			results.push(result)
		}
		const pendingClaims: Array<{id: string; token: string}> = []
		const completedClaims = new Set<string>()
		const deferredClaims = new Map<string, number>()
		const commits: Array<{
			schedule: TriggeredScheduleResult['schedule']
			runs: StoredJobRun[]
			token: string
			now: number
			deferUntil?: number
			terminalExpiresAt?: number
		}> = []
		let generatedRunBudget = Math.min(8, availableRunSlots)
		const releaseOutstandingClaims = async(): Promise<void> => {
			const claims = pendingClaims.filter((claim) => !completedClaims.has(claim.id)).map(({id, token}) => ({
				id, token, ...(deferredClaims.has(id) ? {deferUntil: deferredClaims.get(id)} : {})
			}))
			if (claims.length) requireAcknowledgement(
				await call('releaseSchedule', {claims}), 'schedule release result'
			)
		}
		const discardInvalidClaim = async(id: string, token: string): Promise<void> => {
			requireAcknowledgement(
				await call('releaseSchedule', {id, token, discard: true}),
				'invalid schedule release result'
			)
			completedClaims.add(id)
		}
		try {
			// Register every claim that exposes a usable release identity before
			// decoding any schedule. A malformed early payload must not strand later,
			// otherwise healthy claims remain invisible until their 30-second expiry.
			for (const claim of candidate) {
				if (!claim || typeof claim !== 'object' || Array.isArray(claim)) continue
				const advertisedId = (claim as {id?: unknown}).id
				const token = (claim as {token?: unknown}).token
				if (typeof advertisedId === 'string' && advertisedId.length >= 1
					&& advertisedId.length <= 256 && typeof token === 'string'
					&& token.length >= 1 && token.length <= 256) {
					pendingClaims.push({id: advertisedId, token})
				}
			}
			const claimed: Array<{schedule: TriggeredScheduleResult['schedule']; token: string}> = []
			for (const claim of candidate) {
				if (!claim || typeof claim !== 'object' || Array.isArray(claim)
					|| typeof (claim as {schedule?: unknown}).schedule !== 'string'
					|| typeof (claim as {token?: unknown}).token !== 'string'
					|| (claim as {token: string}).token.length < 1 || (claim as {token: string}).token.length > 256) {
					throw new Error('Jobs provider returned invalid schedule claims')
				}
				const encodedSchedule = (claim as {schedule: string}).schedule
				const advertisedId = (claim as {id?: unknown}).id
				const token = (claim as {token: string}).token
				const advertisedIdValid = typeof advertisedId === 'string'
					&& advertisedId.length >= 1 && advertisedId.length <= 256
				if (!advertisedIdValid) throw new Error('Jobs provider returned invalid schedule claims')
				const id = advertisedId
				try {
					const schedule = decodeSchedule(encodedSchedule)!
					if (schedule.id !== id) throw new Error('Jobs provider returned inconsistent schedule claims')
					validateTriggeredSchedulePolicy(schedule, request)
					claimed.push({schedule, token})
				} catch {
					// Persisted schedule corruption must not poison every healthy due
					// schedule in the same atomic claim batch. Keep the record visible to
					// admin reads, but quarantine it from the due index until it is upserted.
					await discardInvalidClaim(id, token)
				}
			}
			if (new Set(pendingClaims.map((claim) => claim.id)).size !== pendingClaims.length) {
				throw new Error('Jobs provider returned duplicate schedule claims')
			}
			for (const claim of claimed) {
				if (generatedRunBudget === 0) break
				const schedule = claim.schedule
				const dueAt = schedule.nextRunAt ?? getNextScheduleTime(schedule, request.now, true)
				const overlap = schedule.policy?.overlap ?? 'queue'
				const liveCandidate = overlap === 'allow' ? [] : parseProviderJson(
					await call<string>('listScheduleLive', {scheduleId: schedule.id}), 'schedule live-run ids'
				)
				if (!Array.isArray(liveCandidate) || liveCandidate.length > 10_000) {
					throw new Error('Jobs provider returned invalid schedule live-run ids')
				}
				const live = liveCandidate.map((id) => { validateResourceId(id, 'run id'); return id })
				if (new Set(live).size !== live.length) {
					throw new Error('Jobs provider returned duplicate schedule live-run ids')
				}
				const misfire = schedule.policy?.misfire ?? 'fire-once'; const times: number[] = []
				if (overlap === 'queue' && live.length > 0) {
					appendResult({schedule, triggerTimes: [], runs: []})
					commits.push({
						schedule, runs: [], token: claim.token, now: request.now,
						deferUntil: request.now + 1_000,
						...(request.terminalExpiresAt === undefined ? {} : {terminalExpiresAt: request.terminalExpiresAt})
					})
					continue
				}
				if (dueAt !== undefined && !(overlap === 'skip' && live.length)) {
					// Each generated run may contain up to 1 MiB of payload. Keep a Lua
					// commit comfortably below the 16 MiB provider request ceiling and
					// advance larger catch-up windows over subsequent scheduler ticks.
					if (misfire === 'catch-up') { const maximum = overlap === 'queue' ? Math.min(1, generatedRunBudget) : Math.min(request.maxCatchUp, generatedRunBudget); let cursor: number | undefined = dueAt; while (cursor !== undefined && cursor <= request.now && times.length < maximum) { times.push(cursor); cursor = getNextScheduleTime(schedule, cursor) } }
					if (misfire === 'fire-once') times.push(dueAt)
					if (misfire === 'skip' && shouldTriggerSkippedMisfire(dueAt, request)) times.push(dueAt)
				}
				generatedRunBudget -= times.length
				const runs = times.map((time) => request.createRun(schedule, time)); for (let index = 0; index < runs.length; index++) validateGeneratedRun(runs[index]!, schedule, times[index]!); if (times.length > 0) schedule.lastTriggeredAt = Math.max(schedule.lastTriggeredAt ?? 0, request.now); schedule.nextRunAt = dueAt === undefined ? undefined : misfire === 'catch-up' && times.length > 0 ? getNextScheduleTime(schedule, times.at(-1)!) : getNextScheduleTimeAfterTrigger(schedule, dueAt, request.now); validateScheduleInput(schedule)
				appendResult({schedule, triggerTimes: times, runs})
				commits.push({
					schedule, runs, token: claim.token, now: request.now,
					...(request.terminalExpiresAt === undefined ? {} : {terminalExpiresAt: request.terminalExpiresAt})
				})
			}
			if (generatedRunBudget === 0) {
				const processed = new Set(commits.map((commit) => commit.schedule.id))
				for (const claim of pendingClaims) if (!processed.has(claim.id)) {
					deferredClaims.set(claim.id, request.now + 1)
				}
			}
			if (commits.length > 0) {
				const fittingCommits = await call<string>('fitScheduleCommits', {
					commits: commits.map((commit) => ({
						runCount: commit.runs.length,
						queues: [...new Set(commit.runs.map((run) => run.queue))]
					}))
				})
				if (fittingCommits.length !== commits.length || /[^01]/u.test(fittingCommits)) {
					throw new Error('Jobs provider returned invalid schedule capacity results')
				}
				for (let index = fittingCommits.length - 1; index >= 0; index--) if (fittingCommits[index] === '0') {
					deferredClaims.set(commits[index]!.schedule.id, request.now + 1_000)
					commits.splice(index, 1); results.splice(index, 1)
				}
			}
			if (commits.length > 0) {
				const commitRequest = {batchId: randomUUID(), commits}
				let acknowledgement: unknown
				try { acknowledgement = await call('commitSchedules', commitRequest) } catch {
					// The first request may have committed while its response was lost.
					// Repeating the same batch id is side-effect free in the Lua primitive.
					acknowledgement = await call('commitSchedules', commitRequest)
				}
				requireAcknowledgement(acknowledgement, 'schedule commit result')
				for (const commit of commits) completedClaims.add(commit.schedule.id)
			}
			await releaseOutstandingClaims()
		} catch(error) {
			try {
				await releaseOutstandingClaims()
			} catch(releaseError) {
				throw new AggregateError(
					[error, ...(releaseError as AggregateError).errors],
					readJobsErrorMessage(error) || 'Jobs schedule processing and claim release failed'
				)
			}
			throw error
		}
		return results
	}
	const backend: FlatJobsBackendRuntime = {
		durability: 'durable',
		async appendRun(run, idempotency) { validateAppendInput(run, idempotency); await ensureMutableRunIndexes(); const result = decodeAppendResult(await call<string>('append', {run, idempotency})); if (!result.existing && result.run.id !== run.id) throw new Error('Jobs provider returned an inconsistent append result'); return result },
		async getRun(id) { return decodeRun(await call<string | null>('getRun', {id})) },
		listRuns,
		claimDueRuns: claimRuns,
		async releaseClaim(id, token, now) { validateClaimRelease(id, token, now); await ensureMutableRunIndexes(); return decodeProviderBoolean(await call<string>('releaseClaim', {id, token, now}), 'claim release result') },
		async renewLease(id, token, expiresAt, now) { validateLeaseMutation(id, token, expiresAt, now); await ensureMutableRunIndexes(); return decodeProviderBoolean(await call<string>('renew', {id, token, expiresAt, now}), 'lease renewal result') },
		async completeRun(run, token) { validateTransitionInput(run, 'completed'); await ensureMutableRunIndexes(); return decodeProviderBoolean(await call<string>('transition', {run, token}), 'completion result') },
		async markRunRetryable(run, token) { validateTransitionInput(run, 'retryable'); await ensureMutableRunIndexes(); return decodeProviderBoolean(await call<string>('transition', {run, token}), 'retry result') },
		async deadLetterRun(run, token, dead) { validateTransitionInput(run, 'dead-lettered', dead); await ensureMutableRunIndexes(); return decodeProviderBoolean(await call<string>('transition', {run, token, dead}), 'dead-letter result') },
		async cancelRun(id, reason, token, now, terminalExpiresAt) { await ensureMutableRunIndexes(); return decodeProviderBoolean(await call<string>('cancel', {id, reason, token, now, terminalExpiresAt}), 'cancellation result') },
		async recoverStaleLeases(now, recoveryAfterMs, terminalExpiresAt) {
			validateRecoveryRequest(now, recoveryAfterMs, terminalExpiresAt)
			const request = {now, recoveryAfterMs, terminalExpiresAt, recoverySeed: randomUUID()}
			if (!decodeProviderBoolean(
				await call<string>('rro', request), 'stale recovery preflight result'
			)) await ensureMutableRunIndexes()
			return validateBoundedCount(
				await call<string>('recover', request), 1_000, 'stale recovery count'
			)
		},
		async saveSchedule(schedule, expected) { validateScheduleInput(schedule); if (expected) validateScheduleInput(expected); return decodeProviderBoolean(await call<string>('saveSchedule', {schedule, ...(expected === null ? {expectedMode: 'absent'} : expected ? {expectedMode: 'exact', expected} : {})}), 'schedule save result') },
		async setScheduleEnabled(id, enabled, nextRunAt, expected) { if (expected) validateScheduleInput(expected); return decodeProviderBoolean(await call<string>('setScheduleEnabled', {id, enabled, nextRunAt, expected}), 'schedule state result') },
		async getSchedule(id) { return decodeSchedule(await call<string | null>('getSchedule', {id})) },
		listSchedules,
		async deleteSchedule(id) { requireAcknowledgement(await call('deleteSchedule', {id}), 'schedule delete result') },
		triggerDueSchedules: triggerSchedules,
		async setQueuePaused(queue, value) { requireAcknowledgement(await call('pause', {queue, value}), 'queue pause result') },
		async listDeadLetters(limit = 10_000) { const bounded = Math.min(10_000, Math.max(0, Math.floor(limit))); await ensureDeadIndexes(); return decodeDeadLetters(await call<string>('listDead', {limit: bounded}), bounded) },
		async getDeadLetter(id) { return decodeDeadLetter(await call<string | null>('getDead', {id})) },
		async requeueDeadLetter(id, run, idempotency) { validateAppendInput(run, idempotency); await ensureMutableRunIndexes(); const rawDead = await call<string | null>('getDead', {id}); const dead = decodeDeadLetter(rawDead); if (!dead || rawDead === null) return undefined; validateDeadLetterRequeue(run, dead); const deadToken = createHash('sha1').update(rawDead).digest('hex'); const stored = decodeRun(await call<string | null>('requeueDead', {id, run, idempotency, deadToken})); if (stored && stored.id !== run.id) throw new Error('Jobs provider returned an inconsistent dead-letter requeue result'); return stored },
		async triggerScheduleNow(id, createRun) { await ensureMutableRunIndexes(); const raw = await call<string | null>('getSchedule', {id}); const schedule = decodeSchedule(raw); if (!schedule || raw === null) return []; const run = createRun(schedule); validateGeneratedRun(run, schedule, run.runAt); const scheduleToken = createHash('sha1').update(raw).digest('hex'); const stored = decodeRuns(await call<string>('triggerNow', {id, run, scheduleToken}), 1); if (stored.length === 0) return []; if (stored[0]?.id !== run.id || stored[0].scheduleId !== id) throw new Error('Jobs provider returned an inconsistent manual schedule trigger result'); return stored },
		getQueueStats: queueStats,
		async cleanupTerminalRuns(now, limit) { await Promise.all([ensureDeadIndexes(), ensureTerminalIndexes(), ensureMutableRunIndexes()]); return validateBoundedCount(await call<string>('cleanup', {now, limit}), limit, 'cleanup count') }
	}
	return composeJobsBackend(backend)
}
