
import {addJobsCollectionRecordSize, validateJobsCollectionSize} from '../../core/handler-collection-limits'
import type {
	FlatJobsBackendRuntime,
	TriggerSchedulesRequest,
	TriggeredScheduleResult
} from '../../types/backend'
import {getNextScheduleTime, getNextScheduleTimeAfterTrigger} from '../../utils/cron'

import {
	decodeScheduleValue,
	shouldTriggerSkippedMisfire,
	validateGeneratedRun,
	validateScheduleInput,
	validateTriggeredSchedulePolicy,
	validateTriggerRequest
} from './backend-validation'
import {assertSqlQueueCapacity, type JsonRow, MAX_SQL_PAYLOAD_ROWS, RUN_INSERT, runParams, saveScheduleQuery, SCHEDULE_STORAGE_CONSISTENCY} from './sql-helpers'
import {validateSqlRows} from './sql-result-validation'
import type {SqlBackendContext} from './sql-run-operations'

// A trigger result contains each schedule as well as its generated runs. Four
// schedules with twelve near-1 MiB runs each stay below the 64 MiB boundary.
const MAX_SQL_SCHEDULE_RUNS_PER_SCHEDULE = 12
const MAX_SQL_SCHEDULE_RUNS_PER_BATCH = 48

type ScheduleOperations = Pick<FlatJobsBackendRuntime,
	| 'saveSchedule' | 'setScheduleEnabled' | 'getSchedule' | 'listSchedules' | 'deleteSchedule'
	| 'triggerDueSchedules' | 'triggerScheduleNow'>

export function createSqlScheduleOperations(context: SqlBackendContext): ScheduleOperations {
	const {sql, namespace} = context
	return {
		async saveSchedule(schedule, expected) {
			validateScheduleInput(schedule)
			if (expected) validateScheduleInput(expected)
			await context.ready()
			return saveScheduleQuery(sql, namespace, schedule, expected)
		},
		async setScheduleEnabled(id, enabled, nextRunAt, expected) {
			if (expected) validateScheduleInput(expected)
			await context.ready()
			const result = await sql.query(
				`UPDATE ooops_jobs_schedules SET enabled=$3,
				next_run_at=CASE WHEN $3 THEN $4 ELSE next_run_at END,
				data=CASE WHEN $3 AND $4::bigint IS NULL THEN jsonb_set(data,'{enabled}','true'::jsonb,true)-'nextRunAt'
				WHEN $3 THEN jsonb_set(jsonb_set(data,'{enabled}','true'::jsonb,true),
				'{nextRunAt}',to_jsonb($4::bigint),true)
				ELSE jsonb_set(data,'{enabled}','false'::jsonb,true) END
				WHERE namespace=$1 AND id=$2 AND ${SCHEDULE_STORAGE_CONSISTENCY}
				AND ($5::jsonb IS NULL OR data=$5::jsonb)
				RETURNING id`,
				[namespace, id, enabled, nextRunAt ?? null, expected ? JSON.stringify(expected) : null]
			)
			return validateSqlRows(result, 1, 'schedule state result').length === 1
		},
		async getSchedule(id) {
			await context.ready()
			const row = await sql.query<JsonRow>(
				`SELECT data FROM ooops_jobs_schedules WHERE namespace=$1 AND id=$2
				AND ${SCHEDULE_STORAGE_CONSISTENCY}`,
				[namespace, id]
			)
			const rows = validateSqlRows<JsonRow>(row, 1, 'schedule lookup')
			return rows[0] ? decodeScheduleValue(rows[0].data) : undefined
		},
		async listSchedules(query) {
			await context.ready()
			const values: unknown[] = [namespace]
			const where = ['namespace=$1']
			if (query?.queue) { values.push(query.queue); where.push(`queue=$${values.length}`) }
			if (query?.task) { values.push(query.task); where.push(`task=$${values.length}`) }
			if (query?.enabled !== undefined) { values.push(query.enabled); where.push(`enabled=$${values.length}`) }
			const pageLimit = Math.min(MAX_SQL_PAYLOAD_ROWS, Math.max(0, query?.limit ?? 100))
			values.push(pageLimit, Math.max(0, query?.offset ?? 0))
			const rows = await sql.query<JsonRow>(
				`SELECT data FROM ooops_jobs_schedules WHERE ${where.join(' AND ')}
					AND ${SCHEDULE_STORAGE_CONSISTENCY}
				ORDER BY id LIMIT $${values.length - 1} OFFSET $${values.length}`,
				values
			)
			const schedules = validateSqlRows<JsonRow>(
				rows, pageLimit, 'schedule listing'
			).map((row) => decodeScheduleValue(row.data))
			if (new Set(schedules.map((schedule) => schedule.id)).size !== schedules.length) {
				throw new Error('Jobs SQL returned duplicate schedules')
			}
			validateJobsCollectionSize(schedules, 'SQL schedule listing')
			return schedules
		},
		async deleteSchedule(id) {
			await context.ready()
			await sql.query('DELETE FROM ooops_jobs_schedules WHERE namespace=$1 AND id=$2', [namespace, id])
		},
		async triggerDueSchedules(request: TriggerSchedulesRequest) {
			validateTriggerRequest(request)
			await context.ready()
			return sql.transaction(async(transaction) => {
				const checkedQueues = new Set<string>()
				let generatedRunBudget = MAX_SQL_SCHEDULE_RUNS_PER_BATCH
				const schedules: TriggeredScheduleResult['schedule'][] = []
				const selectedIds: string[] = []
				let inspected = 0
				while (schedules.length < 4 && inspected < 10_000) {
					const rows = await transaction.query<JsonRow & {id: string}>(
						`SELECT id,data FROM ooops_jobs_schedules WHERE namespace=$1 AND enabled=true
					AND ${SCHEDULE_STORAGE_CONSISTENCY}
					AND ($3::text[] IS NULL OR task=ANY($3::text[]))
					AND ($4::text[] IS NULL OR COALESCE(data->'policy'->>'misfire','fire-once')=ANY($4::text[]))
					AND ($5::text[] IS NULL OR COALESCE(data->'policy'->>'overlap','queue')=ANY($5::text[]))
					AND NOT(id=ANY($6::text[]))
					AND (COALESCE(data->'policy'->>'overlap','queue')<>'queue' OR NOT EXISTS (
						SELECT 1 FROM ooops_jobs_runs active_run
						WHERE active_run.namespace=ooops_jobs_schedules.namespace
						AND active_run.schedule_id=ooops_jobs_schedules.id
						AND active_run.status NOT IN ('completed','failed','cancelled','dead-lettered')
					))
					AND next_run_at<=$2 ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
						[namespace, request.now, request.allowedTasks ?? null,
							request.allowedMisfire ?? null, request.allowedOverlap ?? null, selectedIds]
					)
					const candidate = validateSqlRows<JsonRow & {id: string}>(rows, 1, 'due schedule candidate')[0]
					if (!candidate) break
					inspected += 1
					try {
						const schedule = decodeScheduleValue(candidate.data)
						validateTriggeredSchedulePolicy(schedule, request)
						schedules.push(schedule); selectedIds.push(schedule.id)
					} catch {
						const quarantined = validateSqlRows<{id: string}>(await transaction.query(
							`UPDATE ooops_jobs_schedules SET enabled=false,
							data=jsonb_set(data,'{enabled}','false'::jsonb,true)
							WHERE namespace=$1 AND id=$2 AND data=$3::jsonb RETURNING id`,
							[namespace, candidate.id, JSON.stringify(candidate.data)]
						), 1, 'due schedule quarantine result')
						if (quarantined[0]?.id !== candidate.id) {
							throw new Error('Jobs SQL due schedule changed during quarantine')
						}
					}
				}
				const results: TriggeredScheduleResult[] = []
				let resultBytes = 0
				const appendResult = (result: TriggeredScheduleResult): void => {
					resultBytes = addJobsCollectionRecordSize(resultBytes, result, 'SQL schedule trigger results')
					results.push(result)
				}
				scheduleLoop: for (const schedule of schedules) {
					if (generatedRunBudget === 0) break
					const dueAt = schedule.nextRunAt ?? getNextScheduleTime(schedule, request.now, true)
					const overlap = schedule.policy?.overlap ?? 'queue'
					const misfire = schedule.policy?.misfire ?? 'fire-once'
					let active = false
					if (overlap === 'queue' || overlap === 'skip') {
						const activeRows = await transaction.query<{id: string}>(
							`SELECT id FROM ooops_jobs_runs WHERE namespace=$1 AND schedule_id=$2
							AND status NOT IN ('completed','failed','cancelled','dead-lettered')
							LIMIT 1 FOR UPDATE`,
							[namespace, schedule.id]
						)
						active = validateSqlRows<{id: string}>(
							activeRows, 1, 'schedule live-run probe'
						).length > 0
					}
					const times: number[] = []
					if (overlap === 'queue' && active) {
						appendResult({schedule, triggerTimes: [], runs: []})
						continue
					}
					if (dueAt !== undefined && !(overlap === 'skip' && active)) {
						if (misfire === 'catch-up') {
							const maximum = Math.min(
								overlap === 'queue' ? 1 : request.maxCatchUp,
								MAX_SQL_SCHEDULE_RUNS_PER_SCHEDULE,
								generatedRunBudget
							)
							let cursor: number | undefined = dueAt
							while (cursor !== undefined && cursor <= request.now && times.length < maximum) {
								times.push(cursor)
								cursor = getNextScheduleTime(schedule, cursor)
							}
						}
						if (misfire === 'fire-once') times.push(dueAt)
						if (misfire === 'skip' && shouldTriggerSkippedMisfire(dueAt, request)) times.push(dueAt)
					}
					generatedRunBudget -= times.length
					const runs = times.map((time) => request.createRun(schedule, time))
					for (let index = 0; index < runs.length; index++) {
						validateGeneratedRun(runs[index]!, schedule, times[index]!)
					}
					if (new Set(runs.map((run) => run.queue)).size > 1) {
						throw new Error('Jobs schedule produced inconsistent run queues')
					}
					for (const queue of new Set(runs.map((run) => run.queue))) {
						if (checkedQueues.has(queue)) continue
						try { await assertSqlQueueCapacity(transaction, namespace, queue) } catch(error) {
							if (error instanceof Error && error.message === 'Jobs SQL queue capacity exceeded') {
								generatedRunBudget += times.length
								schedule.nextRunAt = request.now + 1_000
								await saveScheduleQuery(transaction, namespace, schedule)
								continue scheduleLoop
							}
							throw error
						}
						checkedQueues.add(queue)
					}
					for (const run of runs) await transaction.query(RUN_INSERT, runParams(namespace, run))
					if (times.length > 0) schedule.lastTriggeredAt = Math.max(schedule.lastTriggeredAt ?? 0, request.now)
					schedule.nextRunAt = dueAt === undefined
						? undefined
						: misfire === 'catch-up' && times.length > 0
							? getNextScheduleTime(schedule, times.at(-1)!)
							: getNextScheduleTimeAfterTrigger(schedule, dueAt, request.now)
					validateScheduleInput(schedule)
					await saveScheduleQuery(transaction, namespace, schedule)
					appendResult({schedule, triggerTimes: times, runs})
				}
				return results
			})
		},
		async triggerScheduleNow(id, createRun) {
			await context.ready()
			return sql.transaction(async(transaction) => {
				const row = await transaction.query<JsonRow>(
					`SELECT data FROM ooops_jobs_schedules WHERE namespace=$1 AND id=$2
					AND ${SCHEDULE_STORAGE_CONSISTENCY} FOR UPDATE`,
					[namespace, id]
				)
				const rows = validateSqlRows<JsonRow>(row, 1, 'manual schedule lookup')
				if (!rows[0]) return []
				const schedule = decodeScheduleValue(rows[0].data)
				const run = createRun(schedule)
				validateGeneratedRun(run, schedule, run.runAt)
				await assertSqlQueueCapacity(transaction, namespace, run.queue)
				await transaction.query(RUN_INSERT, runParams(namespace, run))
				return [run]
			})
		}
	}
}
