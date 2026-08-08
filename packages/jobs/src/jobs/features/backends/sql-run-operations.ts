import {randomUUID} from 'node:crypto'

import {tryAddJobsCollectionRecordSize, validateJobsCollectionSize} from '../../core/handler-collection-limits'
import {validateDeadLetterForRun} from '../../core/handler-dead-letter-validation'
import {addJobsDuration, isTerminal, MAX_JOBS_TIMESTAMP, validateStoredJobRun} from '../../core/handler-helpers'
import {validateRunTransitionIdentity} from '../../core/handler-run-transition'
import type {
	FlatJobsBackendRuntime,
	JobsSqlAdapterPort,
	JobsSqlQueryPort,
	StoredDeadLetter,
	StoredJobRun
} from '../../types/backend'

import {
	decodeRunValue,
	validateAppendInput,
	validateBoundedCount,
	validateClaimRelease,
	validateClaimRequest,
	validateLeaseMutation,
	validateRecoveryRequest,
	validateTransitionInput
} from './backend-validation'
import {
	assertSqlQueueCapacity,
	insertDeadLetter,
	type JsonRow,
	MAX_SQL_PAYLOAD_ROWS,
	RUN_CANCEL_UPDATE,
	RUN_INSERT,
	RUN_LEASED_UPDATE,
	RUN_STORAGE_CONSISTENCY,
	RUN_UPSERT,
	runParams
} from './sql-helpers'
import {validateSqlRows, validateUniqueSqlRows} from './sql-result-validation'

export interface SqlBackendContext {
	sql: JobsSqlAdapterPort
	namespace: string
	ready(): Promise<void>
}

const MAX_CLAIM_TRANSACTION_ATTEMPTS = 3

function retryableTransactionFailure(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
		return Boolean(descriptor && 'value' in descriptor
			&& (descriptor.value === '40001' || descriptor.value === '40P01'))
	} catch { return false }
}

async function runClaimTransaction<T>(operation: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try { return await operation() } catch(error) {
			if (attempt >= MAX_CLAIM_TRANSACTION_ATTEMPTS || !retryableTransactionFailure(error)) throw error
		}
	}
}

export async function readSqlRun(
	context: SqlBackendContext,
	id: string,
	query: JobsSqlQueryPort = context.sql
): Promise<StoredJobRun | undefined> {
	const result = await query.query<JsonRow>(
		`SELECT data FROM ooops_jobs_runs WHERE namespace=$1 AND id=$2 AND ${RUN_STORAGE_CONSISTENCY}`,
		[context.namespace, id]
	)
	const rows = validateSqlRows<JsonRow>(result, 1, 'run lookup')
	if (!rows[0]) return undefined
	const run = decodeRunValue(rows[0].data)
	if (run.id !== id) throw new Error('Jobs SQL returned an inconsistent run lookup')
	return run
}

type RunOperations = Pick<FlatJobsBackendRuntime,
	| 'appendRun' | 'getRun' | 'listRuns' | 'claimDueRuns' | 'releaseClaim' | 'renewLease'
	| 'completeRun' | 'markRunRetryable' | 'deadLetterRun' | 'cancelRun'
	| 'recoverStaleLeases'>

export function createSqlRunOperations(context: SqlBackendContext): RunOperations {
	const {sql, namespace} = context
	const transition = async(run: StoredJobRun, token: string, dead?: StoredDeadLetter): Promise<boolean> =>
		sql.transaction(async(transaction) => {
			const selected = validateSqlRows<JsonRow>(await transaction.query<JsonRow>(
				`SELECT data FROM ooops_jobs_runs WHERE namespace=$1 AND id=$2
				AND ${RUN_STORAGE_CONSISTENCY} FOR UPDATE`,
				[namespace, run.id]
			), 1, 'run transition lookup')[0]
			if (!selected) return false
			const current = decodeRunValue(selected.data)
			if (current.status !== 'running' || current.leaseToken !== token
				|| current.leaseExpiresAt === undefined || current.leaseExpiresAt <= run.updatedAt) return false
			validateRunTransitionIdentity(current, run)
			const updated = await transaction.query(RUN_LEASED_UPDATE, [...runParams(namespace, run), token])
			const updatedRows = validateSqlRows(updated, 1, 'run transition result')
			if (!updatedRows.length) return false
			if (dead) await insertDeadLetter(transaction, namespace, dead)
			return true
		})

	return {
		async appendRun(run, idempotency) {
			validateAppendInput(run, idempotency)
			await context.ready()
			return sql.transaction(async(transaction) => {
				if (idempotency) {
					const inserted = await transaction.query<{run_id: string}>(
						`INSERT INTO ooops_jobs_idempotency(namespace,key,run_id,checksum,expires_at)
						VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,key) DO NOTHING RETURNING run_id`,
						[namespace, idempotency.key, run.id, idempotency.checksum, idempotency.expiresAt]
					)
					const insertedRows = validateSqlRows<{run_id: string}>(inserted, 1, 'idempotency insert result')
					if (!insertedRows.length) {
						const locked = await transaction.query<{run_id: string; checksum: string; expires_at: unknown}>(
							`SELECT run_id,checksum,expires_at FROM ooops_jobs_idempotency
							WHERE namespace=$1 AND key=$2 FOR UPDATE`,
							[namespace, idempotency.key]
						)
						const record = validateSqlRows<{run_id: string; checksum: string; expires_at: unknown}>(
							locked, 1, 'idempotency lookup'
						)[0]
						if (!record) throw new Error('Jobs idempotency conflict record disappeared')
						const expiresAt = validateBoundedCount(
							record.expires_at, MAX_JOBS_TIMESTAMP, 'idempotency expiry'
						)
						if (expiresAt > run.createdAt) {
							if (record.checksum !== idempotency.checksum) {
								throw new Error(`Idempotency key reused with different payload: ${idempotency.key}`)
							}
							const prior = await readSqlRun(context, record.run_id, transaction)
							if (prior) {
								return {run: prior, existing: true}
							}
							throw new Error('Jobs idempotency record references a missing run')
						}
						await transaction.query(
							`UPDATE ooops_jobs_idempotency SET run_id=$3,checksum=$4,expires_at=$5
							WHERE namespace=$1 AND key=$2`,
							[namespace, idempotency.key, run.id, idempotency.checksum, idempotency.expiresAt]
						)
					}
				}
				await assertSqlQueueCapacity(transaction, namespace, run.queue)
				await transaction.query(RUN_INSERT, runParams(namespace, run))
				return {run, existing: false}
			})
		},
		async getRun(id) { await context.ready(); return readSqlRun(context, id) },
		async listRuns(query) {
			await context.ready()
			const values: unknown[] = [namespace]
			const where = ['namespace=$1']
			if (query?.queue) { values.push(query.queue); where.push(`queue=$${values.length}`) }
			if (query?.task) { values.push(query.task); where.push(`task=$${values.length}`) }
			if (query?.scheduleId) { values.push(query.scheduleId); where.push(`schedule_id=$${values.length}`) }
			if (query?.status) {
				values.push(Array.isArray(query.status) ? query.status : [query.status])
				where.push(`status=ANY($${values.length})`)
			}
			const pageLimit = Math.min(MAX_SQL_PAYLOAD_ROWS, Math.max(0, query?.limit ?? 100))
			values.push(pageLimit, Math.max(0, query?.offset ?? 0))
			const result = await sql.query<JsonRow>(
				`SELECT data FROM ooops_jobs_runs WHERE ${where.join(' AND ')}
				AND ${RUN_STORAGE_CONSISTENCY}
				ORDER BY run_at,id LIMIT $${values.length - 1} OFFSET $${values.length}`,
				values
			)
			const runs = validateSqlRows<JsonRow>(result, pageLimit, 'run listing')
				.map((row) => decodeRunValue(row.data))
			if (new Set(runs.map((run) => run.id)).size !== runs.length) {
				throw new Error('Jobs SQL returned duplicate runs')
			}
			validateJobsCollectionSize(runs, 'SQL run listing')
			return runs
		},
		async claimDueRuns(request) {
			validateClaimRequest(request)
			await context.ready()
			return runClaimTransaction(async() => sql.transaction(async(transaction) => {
				// The running-count predicate and the SKIP LOCKED candidate claims must
				// share one serializable snapshot. PostgreSQL SSI then aborts a racing
				// transaction instead of allowing two workers to exceed the global or
				// per-task ceiling. The caller treats that abort as a fail-closed backend
				// failure and retries on a later scheduler tick.
				await transaction.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
				const activeRows = validateSqlRows<{count: string}>(await transaction.query(
					`SELECT COUNT(*)::text AS count FROM ooops_jobs_runs
					WHERE namespace=$1 AND status='running'`,
					[namespace]
				), 1, 'global running count')
				const globalActive = validateBoundedCount(
					activeRows[0]?.count ?? '0', Number.MAX_SAFE_INTEGER, 'global running count'
				)
				const capacity = Math.min(
					request.limit,
					MAX_SQL_PAYLOAD_ROWS,
					Math.max(0, request.maxConcurrentRuns - globalActive)
				)
				const limitedTasks = Object.keys(request.concurrencyByTask ?? {})
				const taskRows = limitedTasks.length === 0 ? {rows: []} : await transaction.query<{
					task: string; count: string
				}>(
					`SELECT task,COUNT(*)::text AS count FROM ooops_jobs_runs
					WHERE namespace=$1 AND status='running' AND task=ANY($2::text[])
					GROUP BY task LIMIT 1001`,
					[namespace, limitedTasks]
				)
				const taskCountRows = validateUniqueSqlRows<{task: string; count: string}>(
					taskRows, 1_000, (row) => row.task, 'task running counts'
				)
				const limitedTaskSet = new Set(limitedTasks)
				if (taskCountRows.some((row) => !limitedTaskSet.has(row.task))) {
					throw new Error('Jobs SQL returned unexpected task running counts')
				}
				const taskActive = new Map(taskCountRows.map((row) => [
					row.task,
					validateBoundedCount(row.count, Number.MAX_SAFE_INTEGER, 'task running count')
				]))
				const saturated = new Set(Object.entries(request.concurrencyByTask ?? {})
					.filter(([task, limit]) => (taskActive.get(task) ?? 0) >= limit)
					.map(([task]) => task))
				const claimed: StoredJobRun[] = []
				let claimedBytes = 0
				let inspected = 0
				while (claimed.length < capacity && inspected < 10_000) {
					const rows = await transaction.query<{id: string; data: unknown}>(
						`SELECT id,data FROM ooops_jobs_runs WHERE namespace=$1
						AND status IN ('queued','retryable') AND run_at<=$2
						AND NOT(status='retryable' AND data->'attempt'=data->'maxAttempts')
						AND ${RUN_STORAGE_CONSISTENCY}
						AND queue NOT IN (SELECT queue FROM ooops_jobs_paused_queues WHERE namespace=$1)
						AND NOT(task=ANY($3::text[]))
						AND ($4::text[] IS NULL OR task=ANY($4::text[])) ORDER BY priority DESC,run_at,id
						FOR UPDATE SKIP LOCKED LIMIT 1`,
						[namespace, request.now, [...saturated], request.allowedTasks ?? null]
					)
					const candidateRows = validateSqlRows<{id: string; data: unknown}>(rows, 1, 'claim candidate')
					if (!candidateRows[0]) break
					inspected += 1
					let run: StoredJobRun
					try { run = decodeRunValue(candidateRows[0].data) } catch {
						const quarantined = validateSqlRows<{id: string}>(await transaction.query(
							`UPDATE ooops_jobs_runs SET run_at=$3,
							data=jsonb_set(data,'{runAt}',to_jsonb($3::bigint),true)
							WHERE namespace=$1 AND id=$2 AND data=$4::jsonb RETURNING id`,
							[namespace, candidateRows[0].id, MAX_JOBS_TIMESTAMP,
								JSON.stringify(candidateRows[0].data)]
						), 1, 'claim candidate quarantine result')
						if (quarantined[0]?.id !== candidateRows[0].id) {
							throw new Error('Jobs SQL claim candidate changed during quarantine')
						}
						continue
					}
					if ((run.status !== 'queued' && run.status !== 'retryable') || run.runAt > request.now) {
						throw new Error('Jobs SQL returned a non-claimable run')
					}
					const transitionAt = Math.max(request.now, run.createdAt, run.updatedAt)
					run.status = 'running'; run.attempt += 1; run.startedAt ??= transitionAt
					run.updatedAt = transitionAt; run.leaseOwner = request.workerId
					run.leaseToken = randomUUID(); run.leaseExpiresAt = addJobsDuration(transitionAt, request.leaseMs, 'Jobs lease')
					run.lastHeartbeatAt = transitionAt
					validateStoredJobRun(run)
					const nextBytes = tryAddJobsCollectionRecordSize(claimedBytes, run, 'SQL claim batch')
					if (nextBytes === undefined) break
					claimedBytes = nextBytes
					await transaction.query(RUN_UPSERT, runParams(namespace, run))
					claimed.push(run)
					const active = (taskActive.get(run.task) ?? 0) + 1
					taskActive.set(run.task, active)
					const limit = request.concurrencyByTask?.[run.task]
					if (limit !== undefined && active >= limit) saturated.add(run.task)
				}
				return claimed
			}))
		},
		async releaseClaim(id, token, now) {
			validateClaimRelease(id, token, now)
			await context.ready()
			return sql.transaction(async(transaction) => {
				const result = await transaction.query<JsonRow>(
					`SELECT data FROM ooops_jobs_runs WHERE namespace=$1 AND id=$2
					AND ${RUN_STORAGE_CONSISTENCY} FOR UPDATE`,
					[namespace, id]
				)
				const row = validateSqlRows<JsonRow>(result, 1, 'claim release lookup')[0]
				if (!row) return false
				const run = decodeRunValue(row.data)
				if (run.status !== 'running' || run.leaseToken !== token) return false
				run.attempt -= 1
				run.status = run.attempt === 0 ? 'queued' : 'retryable'
				run.updatedAt = Math.max(now, run.createdAt, run.updatedAt)
				if (run.attempt === 0) run.startedAt = undefined
				run.leaseOwner = undefined; run.leaseToken = undefined
				run.leaseExpiresAt = undefined; run.lastHeartbeatAt = undefined
				validateStoredJobRun(run)
				await transaction.query(RUN_UPSERT, runParams(namespace, run))
				return true
			})
		},
		async renewLease(id, token, expiresAt, now) {
			validateLeaseMutation(id, token, expiresAt, now)
			await context.ready()
			const result = await sql.query(
				`UPDATE ooops_jobs_runs SET lease_expires_at=GREATEST(lease_expires_at,$1),
				updated_at=GREATEST(updated_at,$2),
				data=jsonb_set(jsonb_set(jsonb_set(data,'{leaseExpiresAt}',
				to_jsonb(GREATEST(lease_expires_at,$1)::bigint),true),'{lastHeartbeatAt}',
				to_jsonb(GREATEST(COALESCE((data->>'lastHeartbeatAt')::bigint,0),$2)::bigint),true),
				'{updatedAt}',to_jsonb(GREATEST((data->>'updatedAt')::bigint,$2)::bigint),true)
				WHERE namespace=$3 AND id=$4 AND ${RUN_STORAGE_CONSISTENCY}
				AND lease_token=$5 AND status='running' AND lease_expires_at>$2 RETURNING id`,
				[expiresAt, now, namespace, id, token]
			)
			return validateSqlRows(result, 1, 'lease renewal result').length === 1
		},
		async completeRun(run, token) {
			validateTransitionInput(run, 'completed'); await context.ready(); return transition(run, token)
		},
		async markRunRetryable(run, token) {
			validateTransitionInput(run, 'retryable'); await context.ready(); return transition(run, token)
		},
		async deadLetterRun(run, token, dead) {
			validateTransitionInput(run, 'dead-lettered', dead); await context.ready()
			return transition(run, token, dead)
		},
		async cancelRun(id, reason, token, now, terminalExpiresAt) {
			await context.ready()
			return sql.transaction(async(transaction) => {
				const selected = await transaction.query<JsonRow>(
					`SELECT data FROM ooops_jobs_runs WHERE namespace=$1 AND id=$2
					AND ${RUN_STORAGE_CONSISTENCY} FOR UPDATE`,
					[namespace, id]
				)
				const row = validateSqlRows<JsonRow>(selected, 1, 'cancellation lookup')[0]
				if (!row) return false
				const run = decodeRunValue(row.data)
				if (isTerminal(run) || (token && run.leaseToken !== token)) return false
				const transitionAt = Math.max(run.createdAt, run.updatedAt, now)
				run.status = 'cancelled'; run.cancelReason = reason; run.updatedAt = transitionAt
				run.terminalAt = transitionAt
				run.terminalExpiresAt = terminalExpiresAt === undefined
					? undefined : Math.max(terminalExpiresAt, transitionAt)
				run.leaseOwner = undefined; run.leaseToken = undefined
				run.leaseExpiresAt = undefined; run.lastHeartbeatAt = undefined
				validateStoredJobRun(run)
				const result = await transaction.query(
					RUN_CANCEL_UPDATE, [...runParams(namespace, run), token ?? null]
				)
				return validateSqlRows(result, 1, 'cancellation result').length === 1
			})
		},
		async recoverStaleLeases(now, recoveryAfterMs, terminalExpiresAt) {
			validateRecoveryRequest(now, recoveryAfterMs, terminalExpiresAt)
			await context.ready()
			return sql.transaction(async(transaction) => {
				let recovered = 0
				let inspected = 0
				while (recovered < MAX_SQL_PAYLOAD_ROWS && inspected < 10_000) {
					const rows = await transaction.query<JsonRow & {id: string}>(
						`SELECT id,data FROM ooops_jobs_runs WHERE namespace=$1 AND status='running'
						AND ${RUN_STORAGE_CONSISTENCY}
						AND lease_expires_at+$2<=$3 ORDER BY lease_expires_at,id
						LIMIT 1 FOR UPDATE SKIP LOCKED`,
						[namespace, recoveryAfterMs, now]
					)
					const row = validateSqlRows<JsonRow & {id: string}>(rows, 1, 'stale recovery candidate')[0]
					if (!row) break
					inspected += 1
					let run: StoredJobRun
					try { run = decodeRunValue(row.data) } catch {
						const quarantined = validateSqlRows<{id: string}>(await transaction.query(
							`UPDATE ooops_jobs_runs SET lease_expires_at=$3,
							data=jsonb_set(data,'{leaseExpiresAt}',to_jsonb($3::bigint),true)
							WHERE namespace=$1 AND id=$2 AND data=$4::jsonb RETURNING id`,
							[namespace, row.id, MAX_JOBS_TIMESTAMP, JSON.stringify(row.data)]
						), 1, 'stale recovery quarantine result')
						if (quarantined[0]?.id !== row.id) {
							throw new Error('Jobs SQL stale recovery candidate changed during quarantine')
						}
						continue
					}
					if (run.status !== 'running' || run.leaseExpiresAt === undefined
						|| now < recoveryAfterMs || run.leaseExpiresAt > now - recoveryAfterMs) {
						throw new Error('Jobs SQL stale recovery returned an ineligible run')
					}
					const transitionAt = Math.max(now, run.createdAt, run.updatedAt)
					const exhausted = run.attempt >= run.maxAttempts
					run.status = exhausted ? 'dead-lettered' : 'retryable'
					run.runAt = transitionAt; run.updatedAt = transitionAt
					run.leaseOwner = undefined; run.leaseToken = undefined
					run.leaseExpiresAt = undefined; run.lastHeartbeatAt = undefined
					if (exhausted) {
						run.failureCode = 'lease-expired'; run.error = 'lease-expired'; run.terminalAt = transitionAt
						run.terminalExpiresAt = terminalExpiresAt === undefined
							? undefined : Math.max(terminalExpiresAt, transitionAt)
						const dead: StoredDeadLetter = {
							id: randomUUID(), runId: run.id, queue: run.queue, task: run.task,
							failureCode: 'lease-expired', reason: 'lease-expired', attempts: run.attempt,
							failedAt: transitionAt, payload: run.payload
						}
						validateTransitionInput(run, 'dead-lettered', dead)
						validateDeadLetterForRun(run, dead)
						await transaction.query(RUN_UPSERT, runParams(namespace, run))
						await insertDeadLetter(transaction, namespace, dead)
						recovered += 1
						continue
					}
					validateTransitionInput(run, 'retryable')
					await transaction.query(RUN_UPSERT, runParams(namespace, run))
					recovered += 1
				}
				return recovered
			})
		}
	}
}
