import type {JobStatus, QueueStats} from '@ooopsstudio/core/contracts/jobs'

import {validateJobsCollectionSize} from '../../core/handler-collection-limits'
import {validateDeadLetterForRun, validateDeadLetterRecord, validateDeadLetterRequeue} from '../../core/handler-dead-letter-validation'
import {isTerminal, MAX_JOBS_TIMESTAMP, validateQueueName, validateQueueStats} from '../../core/handler-helpers'
import type {FlatJobsBackendRuntime} from '../../types/backend'

import {
	decodeDeadLetterValue,
	decodeRunValue,
	validateAppendInput,
	validateBoundedCount
} from './backend-validation'
import {assertSqlQueueCapacity, DEAD_STORAGE_CONSISTENCY, type JsonRow, MAX_SQL_PAYLOAD_ROWS, RUN_INSERT, RUN_STORAGE_CONSISTENCY, runParams} from './sql-helpers'
import {validateSqlRows, validateUniqueSqlRows} from './sql-result-validation'
import {readSqlRun, type SqlBackendContext} from './sql-run-operations'

type AdminOperations = Pick<FlatJobsBackendRuntime,
	| 'setQueuePaused' | 'listDeadLetters' | 'getDeadLetter'
	| 'requeueDeadLetter' | 'getQueueStats' | 'cleanupTerminalRuns'>

export function createSqlAdminOperations(context: SqlBackendContext): AdminOperations {
	const {sql, namespace} = context
	return {
		async setQueuePaused(queue, value) {
			validateQueueName(queue)
			await context.ready()
			if (value) {
				await sql.transaction(async(transaction) => {
					await assertSqlQueueCapacity(transaction, namespace, queue)
					await transaction.query(
						`INSERT INTO ooops_jobs_paused_queues(namespace,queue) VALUES($1,$2)
						ON CONFLICT(namespace,queue) DO NOTHING`,
						[namespace, queue]
					)
				})
			} else {
				await sql.query('DELETE FROM ooops_jobs_paused_queues WHERE namespace=$1 AND queue=$2', [namespace, queue])
			}
		},
		async listDeadLetters(limit = 10_000) {
			await context.ready()
			const bounded = Math.min(10_000, Math.max(0, Math.floor(limit)))
			const rows = await sql.query<{
				id: string; run_id: string; queue: string; task: string; failed_at: unknown
				failure_code: unknown; reason: unknown; error: unknown; attempts: unknown
			}>(
				`SELECT id,run_id,queue,task,failed_at,data->>'failureCode' AS failure_code,
				data->>'reason' AS reason,data->>'error' AS error,data->>'attempts' AS attempts
				FROM ooops_jobs_dead_letters WHERE namespace=$1
				AND ${DEAD_STORAGE_CONSISTENCY} ORDER BY failed_at,id LIMIT $2`,
				[namespace, bounded]
			)
			const records = validateSqlRows<{
				id: string; run_id: string; queue: string; task: string; failed_at: unknown
				failure_code: unknown; reason: unknown; error: unknown; attempts: unknown
			}>(rows, bounded, 'dead-letter listing').map((row) => {
				const record = {
					id: row.id, runId: row.run_id, queue: row.queue, task: row.task,
					...(typeof row.failure_code === 'string' ? {failureCode: row.failure_code} : {}),
					...(typeof row.reason === 'string' ? {reason: row.reason} : {}),
					...(typeof row.error === 'string' ? {error: row.error} : {}),
					attempts: validateBoundedCount(row.attempts, 100, 'dead-letter attempts'),
					failedAt: validateBoundedCount(row.failed_at, MAX_JOBS_TIMESTAMP, 'dead-letter timestamp')
				}
				validateDeadLetterRecord(record)
				return record
			})
			if (new Set(records.map((record) => record.id)).size !== records.length) {
				throw new Error('Jobs SQL returned duplicate dead letters')
			}
			validateJobsCollectionSize(records, 'SQL dead-letter listing')
			return records
		},
		async getDeadLetter(id) {
			await context.ready()
			const row = await sql.query<JsonRow>(
				`SELECT data FROM ooops_jobs_dead_letters WHERE namespace=$1 AND id=$2
				AND ${DEAD_STORAGE_CONSISTENCY}`,
				[namespace, id]
			)
			const rows = validateSqlRows<JsonRow>(row, 1, 'dead-letter lookup')
			return rows[0] ? decodeDeadLetterValue(rows[0].data) : undefined
		},
		async requeueDeadLetter(id, run, idempotency) {
			validateAppendInput(run, idempotency)
			await context.ready()
			return sql.transaction(async(transaction) => {
				const found = await transaction.query<{run_id: string; data: unknown}>(
					`SELECT run_id,data FROM ooops_jobs_dead_letters WHERE namespace=$1 AND id=$2
					AND ${DEAD_STORAGE_CONSISTENCY} FOR UPDATE`,
					[namespace, id]
				)
				const foundRows = validateSqlRows<{run_id: string; data: unknown}>(found, 1, 'dead-letter requeue lookup')
				if (!foundRows[0]) return undefined
				const dead = decodeDeadLetterValue(foundRows[0].data)
				if (dead.id !== id || dead.runId !== foundRows[0].run_id) {
					throw new Error('Jobs SQL returned an inconsistent dead-letter relationship')
				}
				const source = await readSqlRun(context, dead.runId, transaction)
				if (!source || source.status !== 'dead-lettered' || source.queue !== dead.queue
					|| source.task !== dead.task || source.attempt !== dead.attempts) {
					throw new Error('Jobs SQL returned an inconsistent dead-letter relationship')
				}
				validateDeadLetterRequeue(run, dead)
				if (idempotency) {
					const inserted = await transaction.query(
						`INSERT INTO ooops_jobs_idempotency(namespace,key,run_id,checksum,expires_at)
						VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,key) DO NOTHING RETURNING key`,
						[namespace, idempotency.key, run.id, idempotency.checksum, idempotency.expiresAt]
					)
					if (!validateSqlRows(inserted, 1, 'dead-letter idempotency insert result').length) {
						const existing = validateSqlRows<{expires_at: unknown}>(await transaction.query(
							`SELECT expires_at FROM ooops_jobs_idempotency
							WHERE namespace=$1 AND key=$2 FOR UPDATE`,
							[namespace, idempotency.key]
						), 1, 'dead-letter idempotency lookup')[0]
						if (!existing) throw new Error('Jobs dead-letter idempotency conflict record disappeared')
						const expiresAt = validateBoundedCount(
							existing.expires_at, MAX_JOBS_TIMESTAMP, 'dead-letter idempotency expiry'
						)
						if (expiresAt > run.createdAt) {
							throw new Error('Jobs dead-letter requeue idempotency key already exists')
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
				await transaction.query(
					'DELETE FROM ooops_jobs_runs WHERE namespace=$1 AND id=$2',
					[namespace, foundRows[0].run_id]
				)
				await transaction.query(
					`DELETE FROM ooops_jobs_idempotency WHERE namespace=$1 AND run_id=$2
					AND ($3::text IS NULL OR key<>$3)`,
					[namespace, foundRows[0].run_id, idempotency?.key ?? null]
				)
				await transaction.query(
					'DELETE FROM ooops_jobs_dead_letters WHERE namespace=$1 AND id=$2',
					[namespace, id]
				)
				return run
			})
		},
		async getQueueStats(queue, requestedNow) {
			if (queue !== undefined) validateQueueName(queue)
			await context.ready()
			const now = requestedNow ?? Date.now()
			const filter = queue ? ' AND queue=$3' : ''
			const rows = await sql.query<{queue: string; status: JobStatus; count: string; oldest_due: unknown}>(
				`SELECT queue,status,COUNT(*)::text AS count,
				MIN(run_at) FILTER (WHERE status IN ('queued','retryable') AND run_at<=$2) AS oldest_due
				FROM ooops_jobs_runs WHERE namespace=$1${filter}
				AND ${RUN_STORAGE_CONSISTENCY} GROUP BY queue,status LIMIT 7001`,
				[namespace, now, ...(queue ? [queue] : [])]
			)
			const pausedRows = await sql.query<{queue: string}>(
				'SELECT queue FROM ooops_jobs_paused_queues WHERE namespace=$1 LIMIT 1001', [namespace]
			)
			const queueRows = validateUniqueSqlRows<{
				queue: string; status: JobStatus; count: string; oldest_due: unknown
			}>(rows, 7_000, (row) => `${row.queue}\0${row.status}`, 'queue status counts')
			const paused = new Set(validateUniqueSqlRows<{queue: string}>(
				pausedRows, 1_000, (row) => row.queue, 'paused queues'
			).map((row) => row.queue))
			const map = new Map<string, QueueStats>()
			const ensure = (name: string): QueueStats => {
				validateQueueName(name)
				const existing = map.get(name)
				if (existing) return existing
				const value: QueueStats = {
					queue: name, queued: 0, running: 0, retryable: 0, deadLettered: 0,
					completed: 0, failed: 0, cancelled: 0, paused: paused.has(name), lagMs: 0
				}
				map.set(name, value)
				return value
			}
			for (const name of paused) if (!queue || queue === name) ensure(name)
			for (const row of queueRows) {
				if (!['queued', 'running', 'retryable', 'dead-lettered', 'completed', 'failed', 'cancelled'].includes(row.status)) {
					throw new Error('Jobs SQL returned invalid queue status')
				}
				const stats = ensure(row.queue)
				const field = row.status === 'dead-lettered'
					? 'deadLettered'
					: row.status as Exclude<JobStatus, 'dead-lettered'>
				stats[field] += validateBoundedCount(row.count, Number.MAX_SAFE_INTEGER, 'queue count')
				if (row.oldest_due !== null) {
					const oldestDue = validateBoundedCount(row.oldest_due, MAX_JOBS_TIMESTAMP, 'queue lag timestamp')
					if (oldestDue > now) {
						throw new Error('Jobs SQL returned invalid queue lag')
					}
					stats.lagMs = Math.max(stats.lagMs, now - oldestDue)
				}
			}
			const result = [...map.values()]
			for (const item of result) validateQueueStats(item)
			return result
		},
		async cleanupTerminalRuns(now, limit) {
			await context.ready()
			return sql.transaction(async(transaction) => {
				const candidatesResult = await transaction.query<{id: string; data: unknown}>(
					`SELECT candidate.id,candidate.data FROM ooops_jobs_runs candidate
						WHERE candidate.namespace=$1 AND candidate.terminal_expires_at<=$2
						AND candidate.id=candidate.data->>'id'
						AND candidate.task=candidate.data->>'task' AND candidate.queue=candidate.data->>'queue'
						AND candidate.status=candidate.data->>'status'
						AND candidate.data->'runAt'=to_jsonb(candidate.run_at)
						AND candidate.data->'priority'=to_jsonb(candidate.priority)
						AND candidate.data->'scheduleId' IS NOT DISTINCT FROM to_jsonb(candidate.schedule_id)
						AND candidate.data->'leaseToken' IS NOT DISTINCT FROM to_jsonb(candidate.lease_token)
						AND candidate.data->'leaseExpiresAt' IS NOT DISTINCT FROM to_jsonb(candidate.lease_expires_at)
						AND candidate.data->'terminalExpiresAt' IS NOT DISTINCT FROM to_jsonb(candidate.terminal_expires_at)
						AND candidate.data->'createdAt'=to_jsonb(candidate.created_at)
						AND candidate.data->'updatedAt'=to_jsonb(candidate.updated_at)
						AND candidate.data->'startedAt' IS NOT DISTINCT FROM to_jsonb(candidate.started_at)
						AND candidate.data->'completedAt' IS NOT DISTINCT FROM to_jsonb(candidate.completed_at)
						AND candidate.data->'terminalAt' IS NOT DISTINCT FROM to_jsonb(candidate.terminal_at)
					AND NOT EXISTS (
						SELECT 1 FROM ooops_jobs_idempotency claim
						WHERE claim.namespace=candidate.namespace AND claim.run_id=candidate.id
						AND claim.expires_at>$2
					) ORDER BY candidate.terminal_expires_at,candidate.id LIMIT $3
					FOR UPDATE SKIP LOCKED`,
					[namespace, now, Math.min(limit, MAX_SQL_PAYLOAD_ROWS)]
				)
				const candidates = validateUniqueSqlRows<{id: string; data: unknown}>(
					candidatesResult, limit, (row) => row.id, 'terminal cleanup candidates'
				)
				const quarantine = async(id: string, data: unknown): Promise<void> => {
					const quarantined = validateSqlRows<{id: string}>(await transaction.query(
						`UPDATE ooops_jobs_runs SET terminal_expires_at=NULL
						WHERE namespace=$1 AND id=$2 AND data=$3::jsonb RETURNING id`,
						[namespace, id, JSON.stringify(data)]
					), 1, 'terminal cleanup quarantine result')
					if (quarantined[0]?.id !== id) {
						throw new Error('Jobs SQL terminal cleanup candidate changed during quarantine')
					}
				}
				let deletedCount = 0
				for (const candidate of candidates) {
					let run
					try {
						run = decodeRunValue(candidate.data)
						if (run.id !== candidate.id || !isTerminal(run)) throw new Error('invalid terminal run')
					} catch {
						await quarantine(candidate.id, candidate.data)
						continue
					}
					if (run.status === 'dead-lettered') {
						const deadRows = validateSqlRows<JsonRow>(await transaction.query<JsonRow>(
							`SELECT data FROM ooops_jobs_dead_letters WHERE namespace=$1 AND run_id=$2
							AND ${DEAD_STORAGE_CONSISTENCY} FOR UPDATE`,
							[namespace, run.id]
						), 1, 'dead-letter cleanup lookup')
						if (!deadRows[0]) {
							await quarantine(candidate.id, candidate.data)
							continue
						}
						let dead
						try {
							dead = decodeDeadLetterValue(deadRows[0].data)
							validateDeadLetterForRun(run, dead)
						} catch {
							await quarantine(candidate.id, candidate.data)
							continue
						}
						const deletedDead = validateSqlRows<{id: string}>(await transaction.query(
							`DELETE FROM ooops_jobs_dead_letters WHERE namespace=$1 AND id=$2
							RETURNING id`, [namespace, dead.id]
						), 1, 'dead-letter cleanup result')
						if (deletedDead[0]?.id !== dead.id) {
							throw new Error('Jobs SQL dead-letter cleanup relationship changed')
						}
					}
					const deletedRun = validateSqlRows<{id: string}>(await transaction.query(
						'DELETE FROM ooops_jobs_runs WHERE namespace=$1 AND id=$2 RETURNING id',
						[namespace, run.id]
					), 1, 'terminal cleanup result')
					if (deletedRun[0]?.id !== run.id) throw new Error('Jobs SQL terminal cleanup candidate changed')
					deletedCount += 1
				}
				const remaining = limit - deletedCount
				if (remaining <= 0) return deletedCount
				const keys = await transaction.query(
					`DELETE FROM ooops_jobs_idempotency WHERE namespace=$1 AND expires_at<=$2
					AND (namespace,key) IN
					(SELECT namespace,key FROM ooops_jobs_idempotency WHERE namespace=$1
					AND expires_at<=$2 ORDER BY expires_at LIMIT $3) RETURNING key`,
					[namespace, now, remaining]
				)
				const keyRows = validateSqlRows(keys, remaining, 'idempotency cleanup result')
				return deletedCount + keyRows.length
			})
		}
	}
}
