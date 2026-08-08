import {randomUUID} from 'node:crypto'

import {Pool, type PoolClient, type QueryResultRow} from 'pg'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {createSqlJobsBackend} from '../../../src/jobs/features/backends/sql'
import {migrateSqlJobsSnapshot} from '../../../src/jobs/features/backends/sql-migration'
import type {JobsSqlAdapterPort, JobsSqlQueryPort, StoredDeadLetter, StoredJobRun} from '../../../src/jobs/types/backend'

const connectionString = process.env.JOBS_POSTGRES_URL
const live = connectionString ? describe : describe.skip

function queryPort(client: Pool | PoolClient): JobsSqlQueryPort {
	return {
		async query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>) {
			const result = await client.query<T & QueryResultRow>(sql, params as unknown[] | undefined)
			return {rows: result.rows}
		}
	}
}

function createAdapter(pool: Pool): JobsSqlAdapterPort {
	return {
		...queryPort(pool),
		async transaction<T>(callback: (transaction: JobsSqlQueryPort) => Promise<T>): Promise<T> {
			const client = await pool.connect()
			try {
				await client.query('BEGIN')
				const result = await callback(queryPort(client))
				await client.query('COMMIT')
				return result
			} catch(error) {
				await client.query('ROLLBACK')
				throw error
			} finally {
				client.release()
			}
		}
	}
}

function createClientAdapter(client: PoolClient): JobsSqlAdapterPort {
	return {
		...queryPort(client),
		async transaction<T>(callback: (transaction: JobsSqlQueryPort) => Promise<T>): Promise<T> {
			await client.query('BEGIN')
			try {
				const result = await callback(queryPort(client))
				await client.query('COMMIT')
				return result
			} catch(error) {
				await client.query('ROLLBACK')
				throw error
			}
		}
	}
}

const queuedRun = (id: string): StoredJobRun => ({
	id, task: 'task', queue: 'default', payload: {id}, status: 'queued',
	createdAt: 1, updatedAt: 1, runAt: 1, priority: 0, attempt: 0, maxAttempts: 2,
	retryPolicy: {attempts: 2, baseDelayMs: 10}
})

live('native PostgreSQL Jobs backend', () => {
	const namespace = `jobs-live-${randomUUID()}`
	const pool = new Pool({connectionString, max: 6})
	const backend = createSqlJobsBackend({sql: createAdapter(pool), namespace})

	beforeAll(async() => {
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace})
		await expect(backend.runs.getRun('compatibility-probe')).resolves.toBeUndefined()
	})
	afterAll(async() => {
		for (const table of [
			'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
			'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
		]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [namespace])
		await pool.end()
	})

	it('claims one due run once across concurrent workers', async() => {
		await backend.runs.appendRun(queuedRun('concurrent'))
		const request = {now: 2, limit: 1, maxConcurrentRuns: 4, leaseMs: 1_000}
		const [left, right] = await Promise.all([
			backend.runs.claimDueRuns({...request, workerId: 'worker-a'}),
			backend.runs.claimDueRuns({...request, workerId: 'worker-b'})
		])
		const claims = [...left, ...right]
		expect(claims).toHaveLength(1)
		expect(claims[0]?.id).toBe('concurrent')
	})

	it('isolates poisoned runnable records so healthy runs remain claimable', async() => {
		const isolatedNamespace = `${namespace}-exhausted-retryable`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun({...queuedRun('poisoned-retryable'), priority: 10})
			await isolated.runs.appendRun({...queuedRun('invalid-queued'), priority: 9})
			for (let index = 0; index < 61; index += 1) {
				await isolated.runs.appendRun({
					...queuedRun(`bulk-poison-${String(index).padStart(2, '0')}`), priority: 8
				})
			}
			await isolated.runs.appendRun(queuedRun('healthy-after-poison'))
			await pool.query(
				`UPDATE ooops_jobs_runs SET status='retryable',
				data=jsonb_set(jsonb_set(data,'{status}','"retryable"'::jsonb),'{attempt}','2'::jsonb)
				WHERE namespace=$1 AND id='poisoned-retryable'`,
				[isolatedNamespace]
			)
			await pool.query(
				`UPDATE ooops_jobs_runs SET data=jsonb_set(data,'{attempt}','1'::jsonb)
				WHERE namespace=$1 AND id='invalid-queued'`,
				[isolatedNamespace]
			)
			await pool.query(
				`UPDATE ooops_jobs_runs SET data=jsonb_set(data,'{attempt}','1'::jsonb)
				WHERE namespace=$1 AND id LIKE 'bulk-poison-%'`,
				[isolatedNamespace]
			)

			const claimed = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'healthy-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})

			expect(claimed.map((run) => run.id)).toEqual(['healthy-after-poison'])
			const poisoned = await pool.query<{id: string; run_at: string; status: string}>(
				`SELECT id,run_at::text,status FROM ooops_jobs_runs
				WHERE namespace=$1 AND id=ANY($2::text[]) ORDER BY id`,
				[isolatedNamespace, ['poisoned-retryable', 'invalid-queued']]
			)
			expect(poisoned.rows).toEqual([
				{id: 'invalid-queued', run_at: '99999999999999', status: 'queued'},
				{id: 'poisoned-retryable', run_at: '1', status: 'retryable'}
			])
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('quarantines poisoned stale leases without blocking healthy recovery', async() => {
		const isolatedNamespace = `${namespace}-poisoned-stale-leases`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun(queuedRun('a-poisoned-stale'))
			await isolated.runs.appendRun(queuedRun('z-healthy-stale'))
			expect((await isolated.runs.claimDueRuns({
				now: 2, workerId: 'stale-worker', limit: 2,
				maxConcurrentRuns: 2, leaseMs: 1_000
			})).map((run) => run.id)).toEqual(['a-poisoned-stale', 'z-healthy-stale'])
			await pool.query(
				`UPDATE ooops_jobs_runs SET data=jsonb_set(data,'{retryPolicy,maxDelayMs}','-1'::jsonb,true)
				WHERE namespace=$1 AND id='a-poisoned-stale'`, [isolatedNamespace]
			)

			await expect(isolated.runs.recoverStaleLeases(2_000, 0)).resolves.toBe(1)

			const healthy = await isolated.runs.getRun('z-healthy-stale')
			expect(healthy).toMatchObject({status: 'retryable'})
			expect(healthy).not.toHaveProperty('leaseToken')
			const poisoned = await pool.query<{lease_expires_at: string}>(
				`SELECT lease_expires_at::text FROM ooops_jobs_runs
				WHERE namespace=$1 AND id='a-poisoned-stale'`, [isolatedNamespace]
			)
			expect(poisoned.rows).toEqual([{lease_expires_at: '99999999999999'}])
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('claims only tasks allowed by a specialized worker', async() => {
		const isolatedNamespace = `${namespace}-allowed-tasks`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun({...queuedRun('foreign-task'), task: 'foreign'})
			await isolated.runs.appendRun({...queuedRun('local-task'), task: 'local'})

			const claimed = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'specialized-worker', limit: 2,
				maxConcurrentRuns: 2, leaseMs: 1_000, allowedTasks: ['local']
			})

			expect(claimed.map((run) => run.id)).toEqual(['local-task'])
			await expect(isolated.runs.getRun('foreign-task')).resolves.toMatchObject({status: 'queued', attempt: 0})
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('triggers only schedules allowed by a specialized worker', async() => {
		const isolatedNamespace = `${namespace}-allowed-schedule-tasks`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'a-foreign-schedule', task: 'foreign', kind: 'interval',
				intervalMs: 1_000, nextRunAt: 1
			})
			await isolated.schedules.saveSchedule({
				id: 'z-local-schedule', task: 'local', kind: 'interval',
				intervalMs: 1_000, nextRunAt: 1
			})

			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1, allowedTasks: ['local'],
				createRun: (schedule, runAt) => ({
					...queuedRun(`generated-${schedule.id}`), task: schedule.task,
					queue: schedule.queue ?? 'default', scheduleId: schedule.id, runAt
				})
			})

			expect(triggered.map((result) => result.schedule.id)).toEqual(['z-local-schedule'])
			await expect(isolated.schedules.getSchedule('a-foreign-schedule')).resolves.toMatchObject({nextRunAt: 1})
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('quarantines poisoned due schedules without starving a healthy schedule', async() => {
		const isolatedNamespace = `${namespace}-poisoned-due-schedules`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			for (let index = 0; index < 5; index += 1) {
				await isolated.schedules.saveSchedule({
					id: `a-poison-${index}`, task: 'task', kind: 'interval',
					intervalMs: 1_000, nextRunAt: 1
				})
			}
			await isolated.schedules.saveSchedule({
				id: 'z-healthy', task: 'task', kind: 'interval', intervalMs: 1_000, nextRunAt: 1
			})
			await pool.query(
				`UPDATE ooops_jobs_schedules SET data=jsonb_set(data,'{intervalMs}','0'::jsonb)
				WHERE namespace=$1 AND id LIKE 'a-poison-%'`, [isolatedNamespace]
			)

			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`generated-${schedule.id}`), scheduleId: schedule.id, runAt
				})
			})

			expect(triggered.map((result) => result.schedule.id)).toEqual(['z-healthy'])
			const quarantined = await pool.query<{enabled: boolean}>(
				`SELECT enabled FROM ooops_jobs_schedules
				WHERE namespace=$1 AND id LIKE 'a-poison-%'`, [isolatedNamespace]
			)
			expect(quarantined.rows).toHaveLength(5)
			expect(quarantined.rows.every((row) => row.enabled === false)).toBe(true)
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('enforces global and per-task concurrency across different row locks', async() => {
		for (const mode of ['global', 'task'] as const) {
			const isolatedNamespace = `${namespace}-${mode}-concurrency`
			const leftBackend = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
			const rightBackend = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
			await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
			try {
				await leftBackend.runs.appendRun(queuedRun(`${mode}-left`))
				await leftBackend.runs.appendRun(queuedRun(`${mode}-right`))
				const request = {
					now: 2, limit: 1, leaseMs: 1_000,
					maxConcurrentRuns: mode === 'global' ? 1 : 10,
					...(mode === 'task' ? {concurrencyByTask: {task: 1}} : {})
				}
				const [left, right] = await Promise.all([
					leftBackend.runs.claimDueRuns({...request, workerId: `${mode}-worker-left`}),
					rightBackend.runs.claimDueRuns({...request, workerId: `${mode}-worker-right`})
				])
				expect([...left, ...right]).toHaveLength(1)
				const count = await pool.query<{count: string}>(
					`SELECT COUNT(*)::text AS count FROM ooops_jobs_runs
					WHERE namespace=$1 AND status='running'`, [isolatedNamespace]
				)
				expect(count.rows[0]?.count).toBe('1')
			} finally {
				for (const table of [
					'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
					'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
				]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
			}
		}
	})

	it('counts inconsistent running rows conservatively for concurrency admission', async() => {
		const isolatedNamespace = `${namespace}-corrupt-running-capacity`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun(queuedRun('already-running'))
			expect(await isolated.runs.claimDueRuns({
				now: 2, workerId: 'worker-a', limit: 1, maxConcurrentRuns: 1, leaseMs: 1_000
			})).toHaveLength(1)
			await pool.query(
				`UPDATE ooops_jobs_runs SET data=jsonb_set(data,'{task}','"corrupted"'::jsonb)
				WHERE namespace=$1 AND id='already-running'`,
				[isolatedNamespace]
			)
			await isolated.runs.appendRun(queuedRun('must-wait'))

			expect(await isolated.runs.claimDueRuns({
				now: 3, workerId: 'worker-b', limit: 1, maxConcurrentRuns: 1, leaseMs: 1_000
			})).toEqual([])
			expect(await isolated.runs.claimDueRuns({
				now: 3, workerId: 'worker-c', limit: 1, maxConcurrentRuns: 10, leaseMs: 1_000,
				concurrencyByTask: {task: 1}
			})).toEqual([])
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('treats an inconsistent scalar-active run as overlap for skip scheduling', async() => {
		const isolatedNamespace = `${namespace}-corrupt-schedule-overlap`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'skip-corrupt-active', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'skip'}
			})
			await isolated.runs.appendRun({
				...queuedRun('corrupt-active'), scheduleId: 'skip-corrupt-active'
			})
			await pool.query(
				`UPDATE ooops_jobs_runs SET data=jsonb_set(data,'{task}','"corrupted"'::jsonb)
				WHERE namespace=$1 AND id='corrupt-active'`,
				[isolatedNamespace]
			)

			const results = await isolated.schedules.triggerDueSchedules({
				now: 3, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun('must-not-overlap'), task: schedule.task,
					queue: schedule.queue ?? 'default', scheduleId: schedule.id, runAt
				})
			})

			expect(results).toHaveLength(1)
			expect(results[0]?.runs).toEqual([])
			expect((await isolated.schedules.getSchedule('skip-corrupt-active'))?.nextRunAt).toBe(1_001)
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('isolates non-numeric JSON corruption from healthy SQL claims and schedules', async() => {
		const isolatedNamespace = `${namespace}-non-numeric-corruption`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun(queuedRun('corrupt-run'))
			await isolated.runs.appendRun(queuedRun('healthy-run'))
			await isolated.schedules.saveSchedule({
				id: 'corrupt-schedule', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'allow'}
			})
			await isolated.schedules.saveSchedule({
				id: 'healthy-schedule', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'allow'}
			})
			await pool.query(
				`UPDATE ooops_jobs_runs SET data=jsonb_set(data,'{runAt}','"not-a-number"'::jsonb)
				WHERE namespace=$1 AND id='corrupt-run'`, [isolatedNamespace]
			)
			await pool.query(
				`UPDATE ooops_jobs_schedules SET data=jsonb_set(data,'{nextRunAt}','"not-a-number"'::jsonb)
				WHERE namespace=$1 AND id='corrupt-schedule'`, [isolatedNamespace]
			)

			await expect(isolated.runs.claimDueRuns({
				now: 2, workerId: 'healthy-worker', limit: 1, maxConcurrentRuns: 1, leaseMs: 1_000
			})).resolves.toEqual([expect.objectContaining({id: 'healthy-run'})])
			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`generated-${schedule.id}`), scheduleId: schedule.id,
					runAt, createdAt: 2, updatedAt: 2
				})
			})
			expect(triggered.flatMap((result) => result.runs).map((run) => run.id))
				.toEqual(['generated-healthy-schedule'])
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('does not let queue-overlap schedules with live runs starve a later due schedule', async() => {
		const isolatedNamespace = `${namespace}-schedule-fairness`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			for (let index = 0; index < 4; index += 1) {
				const scheduleId = `blocked-${index}`
				await isolated.schedules.saveSchedule({
					id: scheduleId, task: 'task', kind: 'interval', intervalMs: 1_000,
					nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'queue'}
				})
				await isolated.runs.appendRun({...queuedRun(`active-${index}`), scheduleId})
			}
			await isolated.schedules.saveSchedule({
				id: 'target', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'queue'}
			})
			expect(await isolated.runs.claimDueRuns({
				now: 2, workerId: 'worker', limit: 4, maxConcurrentRuns: 4, leaseMs: 1_000
			})).toHaveLength(4)
			const results = await isolated.schedules.triggerDueSchedules({
				now: 3, maxCatchUp: 10,
				createRun: (schedule, runAt) => ({
					...queuedRun(`generated-${schedule.id}`), runAt, createdAt: 3, updatedAt: 3,
					scheduleId: schedule.id
				})
			})
			expect(results.flatMap((result) => result.runs).map((run) => run.id))
				.toEqual(['generated-target'])
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('uses the final SQL queue slot for a schedule prefix', async() => {
		const isolatedNamespace = `${namespace}-schedule-queue-prefix`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await pool.query(
				`INSERT INTO ooops_jobs_paused_queues(namespace,queue)
				SELECT $1,'existing-'||value FROM generate_series(1,999) value`,
				[isolatedNamespace]
			)
			for (const [id, queue] of [['queue-prefix-a', 'new-a'], ['queue-prefix-b', 'new-b']]) {
				await isolated.schedules.saveSchedule({
					id: id!, task: 'task', queue: queue!, kind: 'interval', intervalMs: 1_000,
					nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'allow'}
				})
			}
			let sequence = 0
			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`queue-prefix-run-${sequence++}`), queue: schedule.queue!,
					scheduleId: schedule.id, runAt, createdAt: 2, updatedAt: 2
				})
			})

			expect(triggered.flatMap((result) => result.runs)).toHaveLength(1)
			const queues = await pool.query<{count: string}>(
				`SELECT COUNT(*)::text AS count FROM (
				SELECT queue FROM ooops_jobs_runs WHERE namespace=$1
				UNION SELECT queue FROM ooops_jobs_paused_queues WHERE namespace=$1) known`,
				[isolatedNamespace]
			)
			expect(queues.rows[0]?.count).toBe('1000')
			await isolated.schedules.saveSchedule({
				id: 'queue-prefix-c-existing', task: 'task', queue: 'existing-1', kind: 'interval',
				intervalMs: 1_000, nextRunAt: 1,
				policy: {misfire: 'fire-once', overlap: 'allow'}
			})
			for (let index = 0; index < 4; index += 1) await isolated.schedules.saveSchedule({
				id: `queue-prefix-b-blocked-${index}`, task: 'task', queue: `blocked-${index}`,
				kind: 'interval', intervalMs: 1_000, nextRunAt: 1,
				policy: {misfire: 'fire-once', overlap: 'allow'}
			})
			await expect(isolated.schedules.triggerDueSchedules({
				now: 3, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`queue-prefix-blocked-${schedule.id}`), queue: schedule.queue!,
					scheduleId: schedule.id, runAt, createdAt: 3, updatedAt: 3
				})
			})).resolves.toEqual([])
			const afterSaturation = await isolated.schedules.triggerDueSchedules({
				now: 4, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`queue-prefix-run-${sequence++}`), queue: schedule.queue!,
					scheduleId: schedule.id, runAt, createdAt: 4, updatedAt: 4
				})
			})
			expect(afterSaturation.map((result) => result.schedule.id))
				.toEqual(['queue-prefix-c-existing'])
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('fires a skip-misfire schedule within the polling grace window', async() => {
		const isolatedNamespace = `${namespace}-skip-grace`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'skip-grace', task: 'task', kind: 'interval', intervalMs: 1_000, nextRunAt: 1_000,
				policy: {misfire: 'skip', overlap: 'allow'}
			})
			const results = await isolated.schedules.triggerDueSchedules({
				now: 1_100, maxCatchUp: 10, misfireGraceMs: 250,
				createRun: (schedule, runAt) => ({
					...queuedRun('skip-grace-run'), runAt, createdAt: 1_100, updatedAt: 1_100,
					scheduleId: schedule.id
				})
			})
			expect(results.flatMap((result) => result.triggerTimes)).toEqual([1_000])
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('rejects a stale schedule save after its due occurrence advances', async() => {
		const isolatedNamespace = `${namespace}-schedule-cas`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		try {
			const initial = {
				id: 'schedule-cas', task: 'task', kind: 'interval' as const, intervalMs: 1_000,
				nextRunAt: 1_000, policy: {misfire: 'fire-once' as const, overlap: 'allow' as const}
			}
			expect(await isolated.schedules.saveSchedule(initial, null)).toBe(true)
			const expected = await isolated.schedules.getSchedule(initial.id)
			await isolated.schedules.triggerDueSchedules({
				now: 1_000, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun('schedule-cas-run'), scheduleId: schedule.id, runAt,
					createdAt: 1_000, updatedAt: 1_000
				})
			})

			expect(await isolated.schedules.saveSchedule({
				...initial, payload: {stale: true}
			}, expected!)).toBe(false)
			await expect(isolated.schedules.getSchedule(initial.id)).resolves.toMatchObject({nextRunAt: 2_000})
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('rolls back the run transition when dead-letter persistence fails', async() => {
		await backend.runs.appendRun(queuedRun('rollback'))
		const [claimed] = await backend.runs.claimDueRuns({
			now: 2, workerId: 'worker', limit: 1, maxConcurrentRuns: 4, leaseMs: 1_000
		})
		expect(claimed?.id).toBe('rollback')
		const conflict: StoredDeadLetter = {
			id: 'dead-conflict', runId: 'another-run', queue: 'default', task: 'task',
			failureCode: 'failed', attempts: 1, failedAt: 2
		}
		await pool.query(
			`INSERT INTO ooops_jobs_dead_letters(namespace,id,run_id,queue,task,failed_at,data)
			VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
			[namespace, conflict.id, conflict.runId, conflict.queue, conflict.task,
				conflict.failedAt, JSON.stringify(conflict)]
		)
		const {
			leaseOwner: _leaseOwner, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt,
			lastHeartbeatAt: _lastHeartbeatAt, ...claimData
		} = claimed!
		const terminal = {...claimData, status: 'dead-lettered' as const, updatedAt: 3, terminalAt: 3}
		const dead = {...conflict, runId: claimed!.id}
		await expect(backend.runs.deadLetterRun(terminal, claimed!.leaseToken!, dead)).rejects.toThrow()
		expect((await backend.runs.getRun(claimed!.id))?.status).toBe('running')
	})

	it('expires a dead-letter run and its sidecar atomically', async() => {
		await backend.runs.appendRun(queuedRun('expired-dead'))
		const [claimed] = await backend.runs.claimDueRuns({
			now: 2, workerId: 'retention-worker', limit: 1, maxConcurrentRuns: 4, leaseMs: 100
		})
		expect(claimed?.id).toBe('expired-dead')
		const {
			leaseOwner: _leaseOwner, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt,
			lastHeartbeatAt: _lastHeartbeatAt, ...claimData
		} = claimed!
		const terminal: StoredJobRun = {
			...claimData, status: 'dead-lettered', updatedAt: 3, terminalAt: 3,
			terminalExpiresAt: 4, failureCode: 'failed'
		}
		const dead: StoredDeadLetter = {
			id: 'dead-expired', runId: terminal.id, queue: terminal.queue, task: terminal.task,
			failureCode: 'failed', attempts: terminal.attempt, failedAt: 3
		}
		expect(await backend.runs.deadLetterRun(terminal, claimed!.leaseToken!, dead)).toBe(true)
		expect(await backend.maintenance.cleanupTerminalRuns(4, 10)).toBe(1)
		await expect(backend.runs.getRun(terminal.id)).resolves.toBeUndefined()
		await expect(backend.admin.getDeadLetter(dead.id)).resolves.toBeUndefined()
	})

	it('quarantines a corrupt dead-letter relationship without blocking SQL retention', async() => {
		const isolatedNamespace = `${namespace}-retention-relationship-corruption`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		const ids = ['a-sql-corrupt-terminal', 'z-sql-healthy-terminal']
		try {
			for (const id of ids) await isolated.runs.appendRun(queuedRun(id))
			const claimed = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'sql-retention-corruption-worker', limit: 2,
				maxConcurrentRuns: 4, leaseMs: 100
			})
			for (const run of claimed) {
				const {
					leaseOwner: _leaseOwner, leaseToken: _leaseToken,
					leaseExpiresAt: _leaseExpiresAt, lastHeartbeatAt: _lastHeartbeatAt,
					...claimData
				} = run
				const terminal: StoredJobRun = {
					...claimData, status: 'dead-lettered', updatedAt: 3, terminalAt: 3,
					terminalExpiresAt: 4, failureCode: 'failed'
				}
				const dead: StoredDeadLetter = {
					id: `dead-${run.id}`, runId: run.id, queue: run.queue, task: run.task,
					failureCode: 'failed', attempts: run.attempt, failedAt: 3
				}
				expect(await isolated.runs.deadLetterRun(terminal, run.leaseToken!, dead)).toBe(true)
			}
			await pool.query(
				'DELETE FROM ooops_jobs_dead_letters WHERE namespace=$1 AND run_id=$2',
				[isolatedNamespace, ids[0]]
			)

			expect(await isolated.maintenance.cleanupTerminalRuns(4, 10)).toBe(1)
			const rows = await pool.query<{id: string; terminal_expires_at: string | null}>(
				`SELECT id,terminal_expires_at::text FROM ooops_jobs_runs
				WHERE namespace=$1 AND id=ANY($2::text[]) ORDER BY id`,
				[isolatedNamespace, ids]
			)
			expect(rows.rows).toEqual([{id: ids[0], terminal_expires_at: null}])
		} finally {
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('does not delete an idempotency claim renewed while cleanup waits on its row lock', async() => {
		const isolatedNamespace = `${namespace}-cleanup-idempotency-race`
		const isolated = createSqlJobsBackend({sql: createAdapter(pool), namespace: isolatedNamespace})
		await migrateSqlJobsSnapshot({sql: createAdapter(pool), namespace: isolatedNamespace})
		const source: StoredJobRun = {
			...queuedRun('cleanup-source'), status: 'completed', updatedAt: 2,
			attempt: 1, startedAt: 1, completedAt: 2, terminalAt: 2, terminalExpiresAt: 3
		}
		const replacement = queuedRun('cleanup-replacement')
		const insertRun = async(client: PoolClient, run: StoredJobRun) => client.query(
			`INSERT INTO ooops_jobs_runs(namespace,id,task,queue,status,run_at,priority,
			schedule_id,lease_token,lease_expires_at,terminal_expires_at,created_at,updated_at,
			started_at,completed_at,terminal_at,data)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
			[isolatedNamespace, run.id, run.task, run.queue, run.status, run.runAt, run.priority,
				run.scheduleId ?? null, run.leaseToken ?? null, run.leaseExpiresAt ?? null,
				run.terminalExpiresAt ?? null, run.createdAt, run.updatedAt, run.startedAt ?? null,
				run.completedAt ?? null, run.terminalAt ?? null, JSON.stringify(run)]
		)
		const blocker = await pool.connect()
		try {
			await blocker.query('BEGIN')
			await insertRun(blocker, source)
			await blocker.query(
				`INSERT INTO ooops_jobs_idempotency(namespace,key,run_id,checksum,expires_at)
				VALUES($1,'renewed-key',$2,'old',3)`, [isolatedNamespace, source.id]
			)
			await blocker.query('COMMIT')
			await blocker.query('BEGIN')
			await blocker.query(
				`SELECT key FROM ooops_jobs_idempotency WHERE namespace=$1 AND key='renewed-key'
				FOR UPDATE`, [isolatedNamespace]
			)
			const cleanup = isolated.maintenance.cleanupTerminalRuns(3, 10)
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const waiting = await pool.query<{waiting: string}>(
					`SELECT COUNT(*)::text AS waiting FROM pg_stat_activity
					WHERE wait_event_type='Lock' AND query LIKE 'DELETE FROM %ooops_jobs_idempotency%'`
				)
				if (waiting.rows[0]?.waiting !== '0') break
				if (attempt === 99) throw new Error('cleanup did not reach the idempotency lock')
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
			await insertRun(blocker, replacement)
			await blocker.query(
				`UPDATE ooops_jobs_idempotency SET run_id=$3,checksum='new',expires_at=100
				WHERE namespace=$1 AND key=$2`,
				[isolatedNamespace, 'renewed-key', replacement.id]
			)
			await blocker.query('COMMIT')
			expect(await cleanup).toBe(1)
			const claim = await pool.query<{run_id: string; checksum: string; expires_at: string}>(
				`SELECT run_id,checksum,expires_at::text FROM ooops_jobs_idempotency
				WHERE namespace=$1 AND key='renewed-key'`, [isolatedNamespace]
			)
			expect(claim.rows).toEqual([{
				run_id: replacement.id, checksum: 'new', expires_at: '100'
			}])
		} finally {
			await blocker.query('ROLLBACK').catch(() => undefined)
			blocker.release()
			for (const table of [
				'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues',
				'ooops_jobs_runs', 'ooops_jobs_schedules', 'ooops_jobs_schema_migrations'
			]) await pool.query(`DELETE FROM "public".${table} WHERE namespace=$1`, [isolatedNamespace])
		}
	})

	it('bounds payload-bearing result pages before provider materialization', async() => {
		await pool.query(
			`INSERT INTO ooops_jobs_runs(namespace,id,task,queue,status,run_at,priority,
			schedule_id,lease_token,lease_expires_at,terminal_expires_at,created_at,updated_at,
			started_at,completed_at,terminal_at,data)
			SELECT $1,id,'task','page','queued',1,0,NULL,NULL,NULL,NULL,1,1,NULL,NULL,NULL,
			jsonb_build_object('id',id,'task','task','queue','page','payload',jsonb_build_object(),
			'status','queued','createdAt',1,'updatedAt',1,'runAt',1,'priority',0,'attempt',0,
			'maxAttempts',1,'retryPolicy',jsonb_build_object('attempts',1,'baseDelayMs',0))
			FROM (SELECT 'page-'||lpad(value::text,3,'0') AS id FROM generate_series(1,70) value) rows`,
			[namespace]
		)
		const page = await backend.admin.listRuns({queue: 'page', limit: 100})
		expect(page).toHaveLength(60)
		expect(page[0]?.id).toBe('page-001')
		expect(page.at(-1)?.id).toBe('page-060')
	})

	it('lists the complete payload-free dead-letter summary window', async() => {
		await pool.query(
			`INSERT INTO ooops_jobs_dead_letters(namespace,id,run_id,queue,task,failed_at,data)
			SELECT $1,id,run_id,'dead-page','task',failed_at,
			jsonb_build_object('id',id,'runId',run_id,'queue','dead-page','task','task',
			'failureCode','failed','attempts',1,'failedAt',failed_at,'payload',jsonb_build_object('value',id))
			FROM (SELECT 'listed-dead-'||lpad(value::text,4,'0') AS id,
			'listed-run-'||value AS run_id,10+value AS failed_at FROM generate_series(1,1005) value) rows`,
			[namespace]
		)
		const records = await backend.admin.listDeadLetters(10_000)
		const listed = records.filter((record) => record.queue === 'dead-page')
		expect(listed).toHaveLength(1_005)
		expect(listed[0]?.id).toBe('listed-dead-0001')
		expect(listed.at(-1)?.id).toBe('listed-dead-1005')
		expect(listed.every((record) => record.payload === undefined)).toBe(true)
	})

	it('advances large schedule catch-up backlogs in bounded batches', async() => {
		await backend.schedules.saveSchedule({
			id: 'bounded-catch-up', task: 'task', kind: 'interval', intervalMs: 1,
			policy: {misfire: 'catch-up', overlap: 'allow'}, enabled: true, nextRunAt: 1
		})
		let sequence = 0
		const trigger = () => backend.schedules.triggerDueSchedules({
			now: 100, maxCatchUp: 100, allowedMisfire: ['catch-up'], allowedOverlap: ['allow'],
			createRun: (schedule, runAt): StoredJobRun => ({
				id: `catch-up-${sequence++}`, task: schedule.task, queue: schedule.queue ?? 'default',
				payload: schedule.payload ?? {}, status: 'queued', createdAt: 100, updatedAt: 100,
				runAt, priority: 0, attempt: 0, maxAttempts: 1,
				retryPolicy: {attempts: 1, baseDelayMs: 0}, scheduleId: schedule.id
			})
		})

		const first = await trigger()
		expect(first[0]?.runs).toHaveLength(12)
		expect(first[0]?.triggerTimes).toEqual(Array.from({length: 12}, (_, index) => index + 1))
		const second = await trigger()
		expect(second[0]?.runs).toHaveLength(12)
		expect(second[0]?.triggerTimes[0]).toBe(13)
	})

	it('installs the native marker and required indexes idempotently', async() => {
		await expect(backend.runs.getRun('compatibility-probe')).resolves.toBeUndefined()
		const marker = await pool.query<{version: string}>(
			'SELECT version FROM ooops_jobs_schema_migrations WHERE namespace=$1 AND version=$2',
			[namespace, 'native-v2']
		)
		expect(marker.rows).toEqual([{version: 'native-v2'}])
		const indexes = await pool.query<{indexname: string}>(
			`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()
			AND indexname=ANY($1::text[]) ORDER BY indexname`,
			[[
				'ooops_jobs_runs_due_idx', 'ooops_jobs_runs_queue_idx',
				'ooops_jobs_runs_task_idx', 'ooops_jobs_runs_schedule_idx',
				'ooops_jobs_runs_lease_idx', 'ooops_jobs_runs_terminal_idx',
				'ooops_jobs_schedules_due_idx', 'ooops_jobs_idempotency_expiry_idx'
			]]
		)
		expect(indexes.rows).toHaveLength(8)
	})

	it('preserves a legacy snapshot when post-migration schema verification fails', async() => {
		const schema = `jobs_migration_${randomUUID().replaceAll('-', '')}`
		const client = await pool.connect()
		try {
			await client.query(`CREATE SCHEMA "${schema}"`)
			await client.query(`SET search_path = "${schema}"`)
			await client.query(`CREATE TABLE ooops_jobs_snapshots (
				namespace text PRIMARY KEY, version integer NOT NULL, data text NOT NULL
			)`)
			await client.query('CREATE TABLE conflicting_index_owner (value integer)')
			await client.query(
				'CREATE INDEX ooops_jobs_runs_due_idx ON conflicting_index_owner(value)'
			)
			await client.query(
				'INSERT INTO ooops_jobs_snapshots(namespace,version,data) VALUES($1,$2,$3)',
				['drifted-migration', 1, JSON.stringify({
					runs: {}, schedules: {}, deadLetters: {}, idempotency: {}, queuePaused: []
				})]
			)
			const adapter = createClientAdapter(client)

			await expect(migrateSqlJobsSnapshot({
				sql: adapter, namespace: 'drifted-migration', deleteLegacySnapshot: true
			})).rejects.toThrow('JOBS_SCHEMA_INCOMPATIBLE')
			const legacy = await client.query(
				'SELECT 1 FROM ooops_jobs_snapshots WHERE namespace=$1', ['drifted-migration']
			)
			expect(legacy.rowCount).toBe(1)
		} finally {
			try {
				await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
				await client.query('SET search_path = public')
			} finally { client.release() }
		}
	})

	it('keeps runtime statements bound to the verified schema after search_path changes', async() => {
		const schema = `jobs_${randomUUID().replaceAll('-', '')}`
		const client = await pool.connect()
		try {
			await client.query(`CREATE SCHEMA "${schema}"`)
			await client.query(`SET search_path = "${schema}"`)
			const adapter = createClientAdapter(client)
			const isolated = createSqlJobsBackend({sql: adapter, namespace: 'schema-bound'})
			await migrateSqlJobsSnapshot({sql: adapter, namespace: 'schema-bound'})
			await expect(isolated.runs.getRun('probe')).resolves.toBeUndefined()

			await client.query('SET search_path = pg_catalog')
			await isolated.runs.appendRun(queuedRun('schema-bound-run'))
			await expect(isolated.runs.getRun('schema-bound-run')).resolves.toMatchObject({
				id: 'schema-bound-run', status: 'queued'
			})
		} finally {
			try {
				await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
				await client.query('SET search_path = public')
			} finally { client.release() }
		}
	})
})
