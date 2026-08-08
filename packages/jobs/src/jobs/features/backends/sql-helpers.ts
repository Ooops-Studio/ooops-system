import {validateJobsNamespace} from '../../core/handler-helpers'
import type {JobsSqlQueryPort, StoredDeadLetter, StoredJobRun, StoredSchedule} from '../../types/backend'
import type {JobsSqlBackendOptions} from '../../types/jobs'
import {snapshotJobsOptions} from '../../utils/options'

import {validateBoundedCount} from './backend-validation'
import {validateSqlRows} from './sql-result-validation'
import {JOBS_LEGACY_MIGRATION_VERSION, JOBS_SCHEMA_VERSION} from './sql-version'

export type JsonRow = {data: unknown}

/** Keeps payload-bearing SQL results below the 64 MiB collection boundary. */
export const MAX_SQL_PAYLOAD_ROWS = 60

export async function assertSqlQueueCapacity(
	sql: JobsSqlQueryPort,
	namespace: string,
	queue: string
): Promise<void> {
	// Every caller invokes this helper inside the transaction that will create the
	// queue. Lock the namespace's version marker so concurrent count-and-insert
	// decisions serialize without a runtime advisory lock. The marker is created
	// by ready() before any operation reaches this helper.
	const marker = await sql.query<{version: string}>(
		`SELECT version FROM ooops_jobs_schema_migrations
		WHERE namespace=$1 AND version=$2 FOR UPDATE`,
		[namespace, JOBS_SCHEMA_VERSION]
	)
	const markerRows = validateSqlRows<{version: string}>(marker, 1, 'queue capacity marker')
	if (markerRows.length !== 1 || markerRows[0]?.version !== JOBS_SCHEMA_VERSION) {
		throw new Error('Jobs SQL namespace marker is missing')
	}
	const result = await sql.query<{count: string}>(
		`SELECT COUNT(*)::text AS count FROM (
			SELECT queue FROM ooops_jobs_runs WHERE namespace=$1 AND queue<>$2
			UNION SELECT queue FROM ooops_jobs_paused_queues WHERE namespace=$1 AND queue<>$2
		) jobs_queues`,
		[namespace, queue]
	)
	const count = validateBoundedCount(
		validateSqlRows<{count: string}>(result, 1, 'queue capacity result')[0]?.count ?? '0',
		Number.MAX_SAFE_INTEGER,
		'queue capacity'
	)
	if (count >= 1_000) throw new Error('Jobs SQL queue capacity exceeded')
}

export const runParams = (namespace: string, run: StoredJobRun) => [
	namespace, run.id, run.task, run.queue, run.status, run.runAt, run.priority,
	run.scheduleId ?? null, run.leaseToken ?? null, run.leaseExpiresAt ?? null,
	run.terminalExpiresAt ?? null, run.createdAt, run.updatedAt, run.startedAt ?? null,
	run.completedAt ?? null, run.terminalAt ?? null, JSON.stringify(run)
]

export const RUN_UPSERT = `INSERT INTO ooops_jobs_runs(namespace,id,task,queue,status,run_at,priority,schedule_id,lease_token,lease_expires_at,terminal_expires_at,created_at,updated_at,started_at,completed_at,terminal_at,data)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
ON CONFLICT(namespace,id) DO UPDATE SET task=EXCLUDED.task,queue=EXCLUDED.queue,status=EXCLUDED.status,run_at=EXCLUDED.run_at,priority=EXCLUDED.priority,schedule_id=EXCLUDED.schedule_id,lease_token=EXCLUDED.lease_token,lease_expires_at=EXCLUDED.lease_expires_at,terminal_expires_at=EXCLUDED.terminal_expires_at,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,started_at=EXCLUDED.started_at,completed_at=EXCLUDED.completed_at,terminal_at=EXCLUDED.terminal_at,data=EXCLUDED.data`
export const RUN_INSERT = 'INSERT INTO ooops_jobs_runs(namespace,id,task,queue,status,run_at,priority,schedule_id,lease_token,lease_expires_at,terminal_expires_at,created_at,updated_at,started_at,completed_at,terminal_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)'
export const RUN_STORAGE_CONSISTENCY = "id=data->>'id' AND task=data->>'task' AND queue=data->>'queue' AND status=data->>'status' AND data->'runAt'=to_jsonb(run_at) AND data->'priority'=to_jsonb(priority) AND data->'scheduleId' IS NOT DISTINCT FROM to_jsonb(schedule_id) AND data->'leaseToken' IS NOT DISTINCT FROM to_jsonb(lease_token) AND data->'leaseExpiresAt' IS NOT DISTINCT FROM to_jsonb(lease_expires_at) AND data->'terminalExpiresAt' IS NOT DISTINCT FROM to_jsonb(terminal_expires_at) AND data->'createdAt'=to_jsonb(created_at) AND data->'updatedAt'=to_jsonb(updated_at) AND data->'startedAt' IS NOT DISTINCT FROM to_jsonb(started_at) AND data->'completedAt' IS NOT DISTINCT FROM to_jsonb(completed_at) AND data->'terminalAt' IS NOT DISTINCT FROM to_jsonb(terminal_at)"
export const SCHEDULE_STORAGE_CONSISTENCY = "id=data->>'id' AND task=data->>'task' AND queue IS NOT DISTINCT FROM data->>'queue' AND COALESCE(data->'enabled','true'::jsonb)=to_jsonb(enabled) AND data->'nextRunAt' IS NOT DISTINCT FROM to_jsonb(next_run_at)"
export const DEAD_STORAGE_CONSISTENCY = "id=data->>'id' AND run_id=data->>'runId' AND queue=data->>'queue' AND task=data->>'task' AND data->'failedAt'=to_jsonb(failed_at)"

export const RUN_LEASED_UPDATE = `UPDATE ooops_jobs_runs SET task=$3,queue=$4,status=$5,run_at=$6,priority=$7,schedule_id=$8,lease_token=$9,lease_expires_at=$10,terminal_expires_at=$11,created_at=$12,updated_at=$13,started_at=$14,completed_at=$15,terminal_at=$16,data=$17::jsonb WHERE namespace=$1 AND id=$2 AND ${RUN_STORAGE_CONSISTENCY} AND task=$3 AND queue=$4 AND status='running' AND lease_token=$18 AND lease_expires_at>(($17::jsonb->>'updatedAt')::bigint) RETURNING id`
export const RUN_CANCEL_UPDATE = `UPDATE ooops_jobs_runs SET status=$5,lease_token=$9,lease_expires_at=$10,terminal_expires_at=$11,updated_at=$13,terminal_at=$16,data=$17::jsonb WHERE namespace=$1 AND id=$2 AND ${RUN_STORAGE_CONSISTENCY} AND status NOT IN ('completed','failed','cancelled','dead-lettered') AND ($18::text IS NULL OR lease_token=$18) RETURNING id`

function readSqlMethod(source: object, key: 'query' | 'transaction'): Function {
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
	} catch { throw new Error('SQL jobs backend requires stable query() and transaction() support') }
	throw new Error('SQL jobs backend requires query() and transaction() support')
}

export function validateSqlOptions<T extends JobsSqlBackendOptions>(
	options: T,
	additionalKeys: ReadonlySet<string> = new Set()
): T {
	const configured = snapshotJobsOptions<T>(
		options,
		new Set(['sql', 'namespace', ...additionalKeys]),
		'SQL jobs backend options'
	)
	if (!configured.sql || (typeof configured.sql !== 'object' && typeof configured.sql !== 'function')) {
		throw new Error('SQL jobs backend requires query() and transaction() support')
	}
	const source = configured.sql as object
	const query = readSqlMethod(source, 'query')
	const transaction = readSqlMethod(source, 'transaction')
	const snapshotQuery = (candidate: unknown): JobsSqlQueryPort => {
		if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
			throw new Error('SQL jobs backend transaction requires stable query() support')
		}
		const transactionQuery = readSqlMethod(candidate as object, 'query')
		return {query: async(...arguments_) => await Reflect.apply(transactionQuery, candidate, arguments_)}
	}
	const sql: JobsSqlBackendOptions['sql'] = {
		query: async(...arguments_) => await Reflect.apply(query, configured.sql, arguments_),
		transaction: async(callback) => await Reflect.apply(transaction, configured.sql, [
			async(candidate: unknown) => await callback(snapshotQuery(candidate))
		])
	}
	if (configured.namespace !== undefined) validateJobsNamespace(configured.namespace, 'SQL jobs backend namespace')
	return {...configured, sql}
}

const REQUIRED_SQL_TABLES = [
	'ooops_jobs_schema_migrations', 'ooops_jobs_runs', 'ooops_jobs_schedules',
	'ooops_jobs_dead_letters', 'ooops_jobs_idempotency', 'ooops_jobs_paused_queues'
] as const
const REQUIRED_SQL_INDEXES = [
	'ooops_jobs_runs_due_idx', 'ooops_jobs_runs_queue_idx', 'ooops_jobs_runs_task_idx',
	'ooops_jobs_runs_schedule_idx', 'ooops_jobs_runs_lease_idx',
	'ooops_jobs_runs_terminal_idx', 'ooops_jobs_schedules_due_idx',
	'ooops_jobs_idempotency_expiry_idx', 'ooops_jobs_dead_letters_run_idx'
] as const

function quoteSqlIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}

/** Bind every runtime statement to the schema that passed compatibility checks. */
export function qualifyJobsSql(statement: string, schemaName: string): string {
	const schema = quoteSqlIdentifier(schemaName)
	return statement.replace(
		/\b(?:ooops_jobs_schema_migrations|ooops_jobs_runs|ooops_jobs_schedules|ooops_jobs_dead_letters|ooops_jobs_idempotency|ooops_jobs_paused_queues|ooops_jobs_snapshots)\b/gu,
		(relation) => `${schema}.${quoteSqlIdentifier(relation)}`
	)
}

export async function readJobsSqlTransactionIdentity(transaction: JobsSqlQueryPort): Promise<string> {
	const rows = validateSqlRows<{transaction_id: unknown}>(
		await transaction.query<{transaction_id: unknown}>(
			'SELECT txid_current()::text AS transaction_id'
		),
		1,
		'Jobs transaction identity'
	)
	const identity = rows[0]?.transaction_id
	if (typeof identity !== 'string' || !/^\d+$/u.test(identity)) {
		throw new Error('Jobs SQL adapter returned an invalid transaction identity')
	}
	return identity
}

/** Read-only runtime compatibility check. Schema creation belongs to migrations. */
export async function assertNativeJobsSchemaCompatible(
	sql: JobsSqlQueryPort,
	namespace: string
): Promise<string> {
	const schemaRows = validateSqlRows<{schema_name: unknown}>(
		await sql.query<{schema_name: unknown}>('SELECT current_schema() AS schema_name'),
		1,
		'Jobs current schema'
	)
	const schemaName = schemaRows[0]?.schema_name
	if (typeof schemaName !== 'string' || !schemaName || schemaName.length > 63 || schemaName.includes('\0')) {
		throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
	}
	const tables = validateSqlRows<{name: string; relation: string | null}>(
		await sql.query<{name: string; relation: string | null}>(
			`SELECT name,to_regclass(quote_ident($1) || '.' || quote_ident(name)) AS relation
			FROM unnest($2::text[]) AS required(name)`,
			[schemaName, REQUIRED_SQL_TABLES]
		),
		REQUIRED_SQL_TABLES.length,
		'Jobs schema table compatibility'
	)
	if (tables.length !== REQUIRED_SQL_TABLES.length
		|| tables.some((row) => !REQUIRED_SQL_TABLES.includes(row.name as never) || !row.relation)) {
		throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
	}
	const columns = validateSqlRows<{
		table_name: string; column_name: string; data_type: string; is_nullable: string
	}>(
		await sql.query<{
			table_name: string; column_name: string; data_type: string; is_nullable: string
		}>(
			`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
			WHERE table_schema=$1 AND table_name=ANY($2::text[])`,
			[schemaName, REQUIRED_SQL_TABLES]
		),
		128,
		'Jobs schema column compatibility'
	)
	const requiredColumns: Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>> = {
		ooops_jobs_schema_migrations: {
			namespace: ['text', 'NO'], version: ['text', 'NO'], applied_at: ['bigint', 'NO']
		},
		ooops_jobs_runs: {
			namespace: ['text', 'NO'], id: ['text', 'NO'], task: ['text', 'NO'], queue: ['text', 'NO'],
			status: ['text', 'NO'], run_at: ['bigint', 'NO'], priority: ['integer', 'NO'],
			schedule_id: ['text', 'YES'], lease_token: ['text', 'YES'], lease_expires_at: ['bigint', 'YES'],
			terminal_expires_at: ['bigint', 'YES'], created_at: ['bigint', 'NO'], updated_at: ['bigint', 'NO'],
			started_at: ['bigint', 'YES'], completed_at: ['bigint', 'YES'], terminal_at: ['bigint', 'YES'],
			data: ['jsonb', 'NO']
		},
		ooops_jobs_schedules: {
			namespace: ['text', 'NO'], id: ['text', 'NO'], task: ['text', 'NO'], queue: ['text', 'YES'],
			enabled: ['boolean', 'NO'], next_run_at: ['bigint', 'YES'], data: ['jsonb', 'NO']
		},
		ooops_jobs_dead_letters: {
			namespace: ['text', 'NO'], id: ['text', 'NO'], run_id: ['text', 'NO'], queue: ['text', 'NO'],
			task: ['text', 'NO'], failed_at: ['bigint', 'NO'], data: ['jsonb', 'NO']
		},
		ooops_jobs_idempotency: {
			namespace: ['text', 'NO'], key: ['text', 'NO'], run_id: ['text', 'NO'], checksum: ['text', 'NO'],
			expires_at: ['bigint', 'NO']
		},
		ooops_jobs_paused_queues: {namespace: ['text', 'NO'], queue: ['text', 'NO']}
	}
	const availableColumns = new Map(columns.map((row) => [
		`${row.table_name}.${row.column_name}`,
		[row.data_type, row.is_nullable]
	]))
	if (Object.entries(requiredColumns).some(([table, definitions]) =>
		Object.entries(definitions).some(([name, expected]) => {
			const actual = availableColumns.get(`${table}.${name}`)
			return !actual || actual[0] !== expected[0] || actual[1] !== expected[1]
		}))) {
		throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
	}
	const indexes = validateSqlRows<{indexname: string; tablename: string; indexdef: string}>(
		await sql.query<{indexname: string; tablename: string; indexdef: string}>(
			`SELECT indexname,tablename,indexdef FROM pg_indexes
			WHERE schemaname=$1 AND indexname=ANY($2::text[])`,
			[schemaName, REQUIRED_SQL_INDEXES]
		),
		REQUIRED_SQL_INDEXES.length,
		'Jobs schema index compatibility'
	)
	const expectedIndexes: Readonly<Record<string, {table: string; columns: string; unique?: boolean}>> = {
		ooops_jobs_runs_due_idx: {table: 'ooops_jobs_runs', columns: '(namespace,status,run_at,prioritydesc)'},
		ooops_jobs_runs_queue_idx: {table: 'ooops_jobs_runs', columns: '(namespace,queue,status,run_at)'},
		ooops_jobs_runs_task_idx: {table: 'ooops_jobs_runs', columns: '(namespace,task,status)'},
		ooops_jobs_runs_schedule_idx: {table: 'ooops_jobs_runs', columns: '(namespace,schedule_id,status)'},
		ooops_jobs_runs_lease_idx: {table: 'ooops_jobs_runs', columns: '(namespace,lease_expires_at)'},
		ooops_jobs_runs_terminal_idx: {table: 'ooops_jobs_runs', columns: '(namespace,terminal_expires_at)'},
		ooops_jobs_schedules_due_idx: {table: 'ooops_jobs_schedules', columns: '(namespace,enabled,next_run_at)'},
		ooops_jobs_idempotency_expiry_idx: {table: 'ooops_jobs_idempotency', columns: '(namespace,expires_at)'},
		ooops_jobs_dead_letters_run_idx: {
			table: 'ooops_jobs_dead_letters', columns: '(namespace,run_id)', unique: true
		}
	}
	if (new Set(indexes.map((row) => row.indexname)).size !== REQUIRED_SQL_INDEXES.length
		|| indexes.some((row) => {
			const expected = expectedIndexes[row.indexname]
			const definition = typeof row.indexdef === 'string'
				? row.indexdef.toLowerCase().replace(/[\s"]/gu, '')
				: ''
			return !expected || row.tablename !== expected.table
				|| !definition.includes(expected.columns)
				|| Boolean(expected.unique) !== definition.startsWith('createuniqueindex')
		})) {
		throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
	}
	const primaryKeys = validateSqlRows<{table_name: string; definition: string}>(
		await sql.query<{table_name: string; definition: string}>(
			`SELECT relation.relname AS table_name,pg_get_constraintdef(constraint_record.oid) AS definition
			FROM pg_constraint constraint_record
			JOIN pg_class relation ON relation.oid=constraint_record.conrelid
			JOIN pg_namespace namespace_record ON namespace_record.oid=relation.relnamespace
			WHERE namespace_record.nspname=$1 AND constraint_record.contype='p'
			AND relation.relname=ANY($2::text[])`,
			[schemaName, REQUIRED_SQL_TABLES]
		),
		REQUIRED_SQL_TABLES.length,
		'Jobs schema constraint compatibility'
	)
	const expectedPrimaryKeys: Readonly<Record<string, string>> = {
		ooops_jobs_schema_migrations: 'PRIMARYKEY(namespace,version)',
		ooops_jobs_runs: 'PRIMARYKEY(namespace,id)',
		ooops_jobs_schedules: 'PRIMARYKEY(namespace,id)',
		ooops_jobs_dead_letters: 'PRIMARYKEY(namespace,id)',
		ooops_jobs_idempotency: 'PRIMARYKEY(namespace,key)',
		ooops_jobs_paused_queues: 'PRIMARYKEY(namespace,queue)'
	}
	if (new Set(primaryKeys.map((row) => row.table_name)).size !== REQUIRED_SQL_TABLES.length
		|| primaryKeys.some((row) => typeof row.definition !== 'string'
			|| row.definition.toUpperCase().replace(/[\s"]/gu, '')
				!== expectedPrimaryKeys[row.table_name]?.toUpperCase())) {
		throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
	}
	const markers = validateSqlRows<{version: string}>(
		await sql.query<{version: string}>(
			`SELECT version FROM ${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier('ooops_jobs_schema_migrations')}
			WHERE namespace=$1 AND version=ANY($2::text[])`,
			[namespace, [JOBS_SCHEMA_VERSION, JOBS_LEGACY_MIGRATION_VERSION]]
		),
		2,
		'Jobs schema version compatibility'
	)
	const versions = new Set(markers.map((row) => row.version))
	if (!versions.has(JOBS_SCHEMA_VERSION)) throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
	const legacyTable = validateSqlRows<{table_name: string | null}>(
		await sql.query<{table_name: string | null}>(
			"SELECT to_regclass(quote_ident($1) || '.' || quote_ident('ooops_jobs_snapshots')) AS table_name",
			[schemaName]
		),
		1,
		'Jobs legacy schema lookup'
	)[0]?.table_name
	if (legacyTable) {
		const legacyRows = validateSqlRows(
			await sql.query(
				`SELECT 1 FROM ${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier('ooops_jobs_snapshots')} WHERE namespace=$1 LIMIT 1`,
				[namespace]
			),
			1,
			'Jobs legacy snapshot lookup'
		)
		if (legacyRows.length > 0 && !versions.has(JOBS_LEGACY_MIGRATION_VERSION)) {
			throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
		}
	}
	return schemaName
}

export async function saveScheduleQuery(
	sql: JobsSqlQueryPort,
	namespace: string,
	schedule: StoredSchedule,
	expected?: StoredSchedule | null
): Promise<boolean> {
	const values = [namespace, schedule.id, schedule.task, schedule.queue ?? null, schedule.enabled !== false,
		schedule.nextRunAt ?? null, JSON.stringify(schedule)]
	if (expected === null) {
		const inserted = await sql.query<{id: string}>(
			`INSERT INTO ooops_jobs_schedules(namespace,id,task,queue,enabled,next_run_at,data)
			VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(namespace,id) DO NOTHING RETURNING id`,
			values
		)
		return validateSqlRows<{id: string}>(inserted, 1, 'schedule insert result').length === 1
	}
	if (expected) {
		const updated = await sql.query<{id: string}>(
			`UPDATE ooops_jobs_schedules SET task=$3,queue=$4,enabled=$5,next_run_at=$6,data=$7::jsonb
			WHERE namespace=$1 AND id=$2 AND ${SCHEDULE_STORAGE_CONSISTENCY} AND data=$8::jsonb RETURNING id`,
			[...values, JSON.stringify(expected)]
		)
		return validateSqlRows<{id: string}>(updated, 1, 'schedule compare-and-set result').length === 1
	}
	await sql.query(
		`INSERT INTO ooops_jobs_schedules(namespace,id,task,queue,enabled,next_run_at,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
		ON CONFLICT(namespace,id) DO UPDATE SET task=EXCLUDED.task,queue=EXCLUDED.queue,enabled=EXCLUDED.enabled,
		next_run_at=EXCLUDED.next_run_at,data=EXCLUDED.data`,
		values
	)
	return true
}

export async function insertDeadLetter(sql: JobsSqlQueryPort, namespace: string, item: StoredDeadLetter): Promise<void> {
	await sql.query('INSERT INTO ooops_jobs_dead_letters(namespace,id,run_id,queue,task,failed_at,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [namespace, item.id, item.runId, item.queue, item.task, item.failedAt, JSON.stringify(item)])
}

export {JOBS_LEGACY_MIGRATION_VERSION, JOBS_SCHEMA_VERSION}
