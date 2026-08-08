import {describe, expect, it, vi} from 'vitest'

import {createSqlJobsBackend} from '../../src/jobs/features/backends/sql'
import {migrateSqlJobsSnapshot} from '../../src/jobs/features/backends/sql-migration'
import {JOBS_SCHEMA_VERSION} from '../../src/jobs/features/backends/sql-version'

const tables = [
	'ooops_jobs_schema_migrations', 'ooops_jobs_runs', 'ooops_jobs_schedules',
	'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues'
]
const columns: Record<string, string[]> = {
	ooops_jobs_schema_migrations: ['namespace', 'version', 'applied_at'],
	ooops_jobs_runs: [
		'namespace', 'id', 'task', 'queue', 'status', 'run_at', 'priority', 'schedule_id',
		'lease_token', 'lease_expires_at', 'terminal_expires_at', 'created_at', 'updated_at',
		'started_at', 'completed_at', 'terminal_at', 'data'
	],
	ooops_jobs_schedules: ['namespace', 'id', 'task', 'queue', 'enabled', 'next_run_at', 'data'],
	ooops_jobs_dead_letters: ['namespace', 'id', 'run_id', 'queue', 'task', 'failed_at', 'data'],
	ooops_jobs_idempotency: ['namespace', 'key', 'run_id', 'checksum', 'expires_at'],
	ooops_jobs_paused_queues: ['namespace', 'queue']
}
const nullableColumns = new Set([
	'ooops_jobs_runs.schedule_id', 'ooops_jobs_runs.lease_token',
	'ooops_jobs_runs.lease_expires_at', 'ooops_jobs_runs.terminal_expires_at',
	'ooops_jobs_runs.started_at', 'ooops_jobs_runs.completed_at', 'ooops_jobs_runs.terminal_at',
	'ooops_jobs_schedules.queue', 'ooops_jobs_schedules.next_run_at'
])
const bigintColumns = new Set([
	'ooops_jobs_schema_migrations.applied_at', 'ooops_jobs_runs.run_at',
	'ooops_jobs_runs.lease_expires_at', 'ooops_jobs_runs.terminal_expires_at',
	'ooops_jobs_runs.created_at', 'ooops_jobs_runs.updated_at', 'ooops_jobs_runs.started_at',
	'ooops_jobs_runs.completed_at', 'ooops_jobs_runs.terminal_at',
	'ooops_jobs_schedules.next_run_at', 'ooops_jobs_dead_letters.failed_at',
	'ooops_jobs_idempotency.expires_at'
])
const indexes = [
	'ooops_jobs_runs_due_idx', 'ooops_jobs_runs_queue_idx', 'ooops_jobs_runs_task_idx',
	'ooops_jobs_runs_schedule_idx', 'ooops_jobs_runs_lease_idx', 'ooops_jobs_runs_terminal_idx',
	'ooops_jobs_schedules_due_idx', 'ooops_jobs_idempotency_expiry_idx', 'ooops_jobs_dead_letters_run_idx'
]
const indexShapes: Record<string, {tablename: string; columns: string; unique?: boolean}> = {
	ooops_jobs_runs_due_idx: {tablename: 'ooops_jobs_runs', columns: 'namespace,status,run_at,priority DESC'},
	ooops_jobs_runs_queue_idx: {tablename: 'ooops_jobs_runs', columns: 'namespace,queue,status,run_at'},
	ooops_jobs_runs_task_idx: {tablename: 'ooops_jobs_runs', columns: 'namespace,task,status'},
	ooops_jobs_runs_schedule_idx: {tablename: 'ooops_jobs_runs', columns: 'namespace,schedule_id,status'},
	ooops_jobs_runs_lease_idx: {tablename: 'ooops_jobs_runs', columns: 'namespace,lease_expires_at'},
	ooops_jobs_runs_terminal_idx: {tablename: 'ooops_jobs_runs', columns: 'namespace,terminal_expires_at'},
	ooops_jobs_schedules_due_idx: {tablename: 'ooops_jobs_schedules', columns: 'namespace,enabled,next_run_at'},
	ooops_jobs_idempotency_expiry_idx: {tablename: 'ooops_jobs_idempotency', columns: 'namespace,expires_at'},
	ooops_jobs_dead_letters_run_idx: {
		tablename: 'ooops_jobs_dead_letters', columns: 'namespace,run_id', unique: true
	}
}
const primaryKeys: Record<string, string> = {
	ooops_jobs_schema_migrations: 'PRIMARY KEY (namespace, version)',
	ooops_jobs_runs: 'PRIMARY KEY (namespace, id)',
	ooops_jobs_schedules: 'PRIMARY KEY (namespace, id)',
	ooops_jobs_dead_letters: 'PRIMARY KEY (namespace, id)',
	ooops_jobs_idempotency: 'PRIMARY KEY (namespace, key)',
	ooops_jobs_paused_queues: 'PRIMARY KEY (namespace, queue)'
}

function compatibleQuery(statements: string[], schemaName = 'public') {
	return vi.fn(async(sql: string) => {
		statements.push(sql)
		if (sql.includes('txid_current')) return {rows: [{transaction_id: '42'}]}
		if (sql.includes('current_schema()')) return {rows: [{schema_name: schemaName}]}
		if (sql.includes('unnest(')) return {rows: tables.map((name) => ({name, relation: name}))}
		if (sql.includes('information_schema.columns')) return {rows: Object.entries(columns).flatMap(
			([table_name, names]) => names.map((column_name) => {
				const qualified = `${table_name}.${column_name}`
				const data_type = column_name === 'data' ? 'jsonb'
					: qualified === 'ooops_jobs_runs.priority' ? 'integer'
						: qualified === 'ooops_jobs_schedules.enabled' ? 'boolean'
							: bigintColumns.has(qualified) ? 'bigint' : 'text'
				return {
					table_name, column_name, data_type,
					is_nullable: nullableColumns.has(qualified) ? 'YES' : 'NO'
				}
			})
		)}
		if (sql.includes('pg_indexes')) return {rows: indexes.map((indexname) => {
			const shape = indexShapes[indexname]!
			return {
				indexname,
				tablename: shape.tablename,
				indexdef: `CREATE ${shape.unique ? 'UNIQUE ' : ''}INDEX ${indexname} ON ${shape.tablename} (${shape.columns})`
			}
		})}
		if (sql.includes('pg_constraint')) return {rows: tables.map((table_name) => ({
			table_name,
			definition: primaryKeys[table_name]
		}))}
		if (sql.includes('version=ANY')) return {rows: [{version: JOBS_SCHEMA_VERSION}]}
		if (sql.includes("quote_ident('ooops_jobs_snapshots')")) return {rows: [{table_name: null}]}
		return {rows: []}
	})
}

describe('Jobs SQL schema ownership', () => {
	it('performs read-only compatibility validation during normal backend use', async() => {
		const statements: string[] = []
		const query = compatibleQuery(statements)
		const backend = createSqlJobsBackend({sql: {query, transaction: async(fn) => await fn({query})}})
		await expect(backend.runs.getRun('missing')).resolves.toBeUndefined()
		expect(statements.some((sql) => /\b(?:CREATE|ALTER|INSERT INTO ooops_jobs_schema_migrations)\b/iu.test(sql))).toBe(false)
	})

	it('binds every runtime statement to the exact schema that passed verification', async() => {
		const statements: string[] = []
		const query = compatibleQuery(statements, 'jobs tenant')
		const backend = createSqlJobsBackend({sql: {query, transaction: async(fn) => await fn({query})}})

		await expect(backend.runs.getRun('missing')).resolves.toBeUndefined()

		const lookup = statements.find((sql) => sql.includes('run lookup') || sql.includes('SELECT data FROM'))
		expect(lookup).toContain('"jobs tenant"."ooops_jobs_runs"')
		expect(statements.some((sql) => sql.includes('table_schema=$1'))).toBe(true)
	})

	it('fails closed for an incompatible schema', async() => {
		const query = vi.fn(async(sql: string) => sql.includes('txid_current')
			? {rows: [{transaction_id: '42'}]}
			: {rows: []})
		const backend = createSqlJobsBackend({sql: {query, transaction: async(fn) => await fn({query})}})
		await expect(backend.runs.getRun('missing')).rejects.toThrow('JOBS_SCHEMA_INCOMPATIBLE')
	})

	it('rejects transaction adapters that execute callback statements in auto-commit mode', async() => {
		const statements: string[] = []
		let transactionId = 0
		const compatible = compatibleQuery(statements)
		const query = vi.fn(async(sql: string) => sql.includes('txid_current')
			? {rows: [{transaction_id: String(++transactionId)}]}
			: await compatible(sql))
		const backend = createSqlJobsBackend({sql: {query, transaction: async(fn) => await fn({query})}})

		await expect(backend.runs.getRun('missing')).rejects.toThrow('real PostgreSQL transaction')
	})

	it('rejects same-name indexes that are attached to the wrong relation', async() => {
		const statements: string[] = []
		const compatible = compatibleQuery(statements)
		const query = vi.fn(async(sql: string) => {
			const result = await compatible(sql)
			if (!sql.includes('pg_indexes')) return result
			return {rows: result.rows.map((row, index) => index === 0
				? {...row, tablename: 'ooops_jobs_schedules'}
				: row)}
		})
		const backend = createSqlJobsBackend({sql: {query, transaction: async(fn) => await fn({query})}})

		await expect(backend.runs.getRun('missing')).rejects.toThrow('JOBS_SCHEMA_INCOMPATIBLE')
	})

	it('keeps DDL in the explicit migration path', async() => {
		const statements: string[] = []
		const compatible = compatibleQuery(statements)
		const query = vi.fn(async(sql: string) => {
			if (sql.includes('txid_current')) return {rows: [{transaction_id: '42'}]}
			if (sql.includes("to_regclass('ooops_jobs_snapshots')")) return {rows: [{table_name: null}]}
			return compatible(sql)
		})
		await migrateSqlJobsSnapshot({sql: {query, transaction: async(fn) => await fn({query})}})
		expect(statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS ooops_jobs_runs'))).toBe(true)
	})

	it('preserves the legacy rollback source when a marked schema has drifted', async() => {
		const statements: string[] = []
		const query = vi.fn(async(sql: string) => {
			statements.push(sql)
			if (sql.includes('txid_current')) return {rows: [{transaction_id: '42'}]}
			if (sql.includes("to_regclass('ooops_jobs_snapshots')")) {
				return {rows: [{table_name: 'ooops_jobs_snapshots'}]}
			}
			if (sql.includes('SELECT 1 FROM ooops_jobs_schema_migrations')) return {rows: [{value: 1}]}
			// Simulate schema drift discovered by the compatibility verifier.
			if (sql.includes('current_schema()')) return {rows: []}
			return {rows: []}
		})

		await expect(migrateSqlJobsSnapshot({
			sql: {query, transaction: async(fn) => await fn({query})},
			deleteLegacySnapshot: true
		})).rejects.toThrow('JOBS_SCHEMA_INCOMPATIBLE')
		expect(statements.some((sql) => sql.startsWith('DELETE FROM ooops_jobs_snapshots'))).toBe(false)
	})

	it('rejects auto-commit migration adapters before executing any DDL', async() => {
		const statements: string[] = []
		let transactionId = 0
		const query = vi.fn(async(sql: string) => {
			statements.push(sql)
			return sql.includes('txid_current')
				? {rows: [{transaction_id: String(++transactionId)}]}
				: {rows: []}
		})

		await expect(migrateSqlJobsSnapshot({
			sql: {query, transaction: async(fn) => await fn({query})}
		})).rejects.toThrow('real PostgreSQL transaction')
		expect(statements.some((sql) => sql.includes('CREATE TABLE'))).toBe(false)
	})
})
