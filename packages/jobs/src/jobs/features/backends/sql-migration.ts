import type {JobsSqlBackendOptions} from '../../types/jobs'
import {getNextScheduleTime} from '../../utils/cron'

import {parseLegacyJobsState} from './legacy-migration'
import {
	assertNativeJobsSchemaCompatible, insertDeadLetter,
	JOBS_LEGACY_MIGRATION_VERSION, JOBS_SCHEMA_VERSION, RUN_UPSERT,
	readJobsSqlTransactionIdentity, runParams, saveScheduleQuery, validateSqlOptions
} from './sql-helpers'
import {validateSqlRows} from './sql-result-validation'
import {SQL_SCHEMA} from './sql-schema'

export interface SqlJobsMigrationOptions extends JobsSqlBackendOptions {deleteLegacySnapshot?: boolean}
export interface SqlJobsMigrationResult {migrated: boolean; already: boolean; runs?: number}

export async function migrateSqlJobsSnapshot(options: SqlJobsMigrationOptions): Promise<SqlJobsMigrationResult> {
	const configured = validateSqlOptions(options, new Set(['deleteLegacySnapshot']))
	const {sql, namespace = 'jobs:scheduler'} = configured
	return sql.transaction(async(tx) => {
		const firstTransactionIdentity = await readJobsSqlTransactionIdentity(tx)
		const secondTransactionIdentity = await readJobsSqlTransactionIdentity(tx)
		if (firstTransactionIdentity !== secondTransactionIdentity) {
			throw new Error('Jobs SQL migration requires a real PostgreSQL transaction')
		}
		await tx.query(SQL_SCHEMA)
		// Serialize migration decisions for this namespace. Without this lock, two
		// workers can both observe an absent marker/empty native schema and race the
		// inserts, making one valid migration fail with a uniqueness violation.
		await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [namespace])
		const legacyTable = validateSqlRows<{table_name: string | null}>(await tx.query(
			"SELECT to_regclass('ooops_jobs_snapshots') AS table_name"
		), 1, 'legacy table lookup')
		const hasLegacyTable = Boolean(legacyTable[0]?.table_name)
		const marked = await tx.query(
			'SELECT 1 FROM ooops_jobs_schema_migrations WHERE namespace=$1 AND version=$2',
			[namespace, JOBS_LEGACY_MIGRATION_VERSION]
		)
		if (validateSqlRows(marked, 1, 'migration marker lookup').length) {
			// A marker only proves that a migration committed in the past. Verify the
			// schema still satisfies the runtime contract before deleting the rollback
			// source or reporting success; indexes and constraints may have drifted.
			await assertNativeJobsSchemaCompatible(tx, namespace)
			if (configured.deleteLegacySnapshot && hasLegacyTable) {
				await tx.query('DELETE FROM ooops_jobs_snapshots WHERE namespace=$1', [namespace])
			}
			return {migrated: false, already: true}
		}
		const native = await tx.query(`SELECT 1 FROM ooops_jobs_runs WHERE namespace=$1
			UNION ALL SELECT 1 FROM ooops_jobs_schedules WHERE namespace=$1
			UNION ALL SELECT 1 FROM ooops_jobs_dead_letters WHERE namespace=$1
			UNION ALL SELECT 1 FROM ooops_jobs_idempotency WHERE namespace=$1
			UNION ALL SELECT 1 FROM ooops_jobs_paused_queues WHERE namespace=$1 LIMIT 1`, [namespace])
		if (validateSqlRows(native, 1, 'native migration conflict lookup').length) {
			throw new Error('Jobs native SQL migration conflict')
		}
		const legacy = hasLegacyTable
			? await tx.query<{version: number; data: string}>('SELECT version,data FROM ooops_jobs_snapshots WHERE namespace=$1 FOR UPDATE', [namespace])
			: {rows: []}
		const legacyRows = validateSqlRows<{version: number; data: string}>(legacy, 1, 'legacy snapshot lookup')
		if (!legacyRows[0]) {
			const appliedAt = Date.now()
			await tx.query(`INSERT INTO ooops_jobs_schema_migrations(namespace,version,applied_at)
				VALUES($1,$2,$3),($1,$4,$3) ON CONFLICT(namespace,version) DO NOTHING`,
			[namespace, JOBS_SCHEMA_VERSION, appliedAt, JOBS_LEGACY_MIGRATION_VERSION])
			await assertNativeJobsSchemaCompatible(tx, namespace)
			return {migrated: false, already: false, runs: 0}
		}
		const state = parseLegacyJobsState(legacyRows[0].version, legacyRows[0].data)
		for (const run of Object.values(state.runs)) {
			await tx.query(RUN_UPSERT, runParams(namespace, run))
		}
		const migrationNow = Date.now()
		for (const schedule of Object.values(state.schedules)) {
			if (schedule.enabled !== false && schedule.nextRunAt === undefined) {
				schedule.nextRunAt = getNextScheduleTime(schedule, migrationNow, true)
			}
			await saveScheduleQuery(tx, namespace, schedule)
		}
		for (const item of Object.values(state.deadLetters)) await insertDeadLetter(tx, namespace, item)
		for (const [key, item] of Object.entries(state.idempotency)) {
			await tx.query(
				'INSERT INTO ooops_jobs_idempotency(namespace,key,run_id,checksum,expires_at) VALUES($1,$2,$3,$4,$5)',
				[namespace, key, item.runId, item.checksum, item.expiresAt]
			)
		}
		for (const queue of state.queuePaused) {
			await tx.query('INSERT INTO ooops_jobs_paused_queues(namespace,queue) VALUES($1,$2)', [namespace, queue])
		}
		const appliedAt = Date.now()
		await tx.query(`INSERT INTO ooops_jobs_schema_migrations(namespace,version,applied_at)
			VALUES($1,$2,$3),($1,$4,$3) ON CONFLICT(namespace,version) DO NOTHING`,
		[namespace, JOBS_SCHEMA_VERSION, appliedAt, JOBS_LEGACY_MIGRATION_VERSION])
		await assertNativeJobsSchemaCompatible(tx, namespace)
		if (configured.deleteLegacySnapshot && hasLegacyTable) await tx.query('DELETE FROM ooops_jobs_snapshots WHERE namespace=$1', [namespace])
		return {migrated: true, already: false, runs: Object.keys(state.runs).length}
	})
}
