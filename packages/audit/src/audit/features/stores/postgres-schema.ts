import {snapshotPgObject, snapshotPgRows, type PgQueryable, type PostgresAuditTables} from './postgres-support'

type RequiredColumn = readonly [
	name: string,
	dataType: string,
	nullable: boolean,
	requiredDefault?: 'current-timestamp'
]

const RECORD_COLUMNS: readonly RequiredColumn[] = Object.freeze([
	['id', 'text', false], ['idempotency_hash', 'text', true], ['semantic_fingerprint', 'text', true],
	['event_type', 'text', false], ['category', 'text', false], ['action', 'text', false],
	['occurred_at', 'timestamp with time zone', false], ['created_at', 'timestamp with time zone', false],
	['actor_json', 'jsonb', false], ['targets_json', 'jsonb', false], ['outcome', 'text', false],
	['sensitivity', 'text', false], ['summary', 'text', true], ['workspace_id', 'text', true],
	['tenant_id', 'text', true], ['stream', 'text', true], ['correlation_json', 'jsonb', false],
	['context_json', 'jsonb', false], ['metadata_json', 'jsonb', false], ['change_set_json', 'jsonb', true],
	['partition_key', 'text', false], ['sequence', 'bigint', false], ['prev_hash', 'text', true],
	['hash', 'text', false], ['algorithm', 'text', false]
])

const HEAD_COLUMNS: readonly RequiredColumn[] = Object.freeze([
	['partition_key', 'text', false], ['last_sequence', 'bigint', false], ['last_hash', 'text', false],
	['last_record_id', 'text', false], ['updated_at', 'timestamp with time zone', false]
])

const TOMBSTONE_COLUMNS: readonly RequiredColumn[] = Object.freeze([
	['record_id_hash', 'text', false], ['idempotency_hash', 'text', true],
	['semantic_fingerprint', 'text', true],
	['pruned_at', 'timestamp with time zone', false, 'current-timestamp']
])

const MIGRATION_COLUMNS: readonly RequiredColumn[] = Object.freeze([
	['version', 'integer', false], ['applied_at', 'timestamp with time zone', false]
])

function incompatible(detail: string): Error {
	const error = new Error(`Audit schema incompatible: ${detail}.`)
	Object.defineProperty(error, 'code', {value: 'AUDIT_SCHEMA_INCOMPATIBLE', enumerable: true})
	return error
}

function quotePostgresIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}

function canonicalCheckDefinition(definition: string): string {
	return definition
		.replace(/::(?:text|bigint)/gi, '')
		.replace(/'(\d+)'/g, '$1')
		.replace(/[\s()]/g, '')
		.toLowerCase()
}

function canonicalCheckStructure(definition: string): string {
	return definition
		.replace(/::(?:text|bigint)/gi, '')
		.replace(/'(\d+)'/g, '$1')
		.replace(/\s/g, '')
		.toLowerCase()
}

export async function verifyPostgresAuditSchema(
	query: PgQueryable['query'],
	tables: PostgresAuditTables,
	schemaName: string
): Promise<void> {
	if (typeof schemaName !== 'string' || !schemaName || Buffer.byteLength(schemaName) > 63 || schemaName.includes('\0')) {
		throw incompatible('identity')
	}
	const names = [tables.records, tables.heads, tables.tombstones, tables.migrations]
	const relationSecurityResult = await query<{name: unknown; safe_relation: unknown}>(
		`SELECT relation_class.relname AS name,
			relation_class.relkind='r' AND relation_class.relpersistence='p'
			AND relation_class.relam=(SELECT oid FROM pg_am WHERE amname='heap')
			AND NOT relation_class.relrowsecurity AND NOT relation_class.relforcerowsecurity
			AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation_class.oid)
			AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=relation_class.oid)
			AND NOT EXISTS(SELECT 1 FROM pg_inherits
				WHERE inhrelid=relation_class.oid OR inhparent=relation_class.oid) AS safe_relation
		 FROM pg_class relation_class
		 JOIN pg_namespace relation_namespace ON relation_namespace.oid=relation_class.relnamespace
		 WHERE relation_namespace.nspname=$1 AND relation_class.relname=ANY($2::text[])`,
		[schemaName, names]
	)
	const safeRelations = snapshotPgRows<{name: unknown; safe_relation: unknown}>(
		relationSecurityResult, names.length, 'relation rows'
	)
	const securedNames = new Set<string>()
	for (const raw of safeRelations) {
		const row = snapshotPgObject(raw, new Set(['name', 'safe_relation']), 'relation row')
		if (typeof row.name !== 'string' || !names.includes(row.name) || row.safe_relation !== true
			|| securedNames.has(row.name)) throw incompatible('relation')
		securedNames.add(row.name)
	}
	if (names.some((name) => !securedNames.has(name))) throw incompatible('relation')

	const columnsResult = await query<{
		table_name: unknown
		column_name: unknown
		data_type: unknown
		is_nullable: unknown
		is_generated: unknown
		is_identity: unknown
		column_default: unknown
	}>(
		`SELECT table_name, column_name, data_type, is_nullable, is_generated, is_identity,
			left(column_default,4097) AS column_default FROM information_schema.columns
		 WHERE table_schema = $2 AND table_name = ANY($1::text[])`,
		[names, schemaName]
	)
	const columns = snapshotPgRows<{
		table_name: unknown
		column_name: unknown
		data_type: unknown
		is_nullable: unknown
		is_generated: unknown
		is_identity: unknown
		column_default: unknown
	}>(columnsResult, 256, 'schema column rows').map((raw) => {
		const row = snapshotPgObject(
			raw,
			new Set(['table_name', 'column_name', 'data_type', 'is_nullable', 'is_generated', 'is_identity', 'column_default']),
			'schema column row'
		)
		if (typeof row.table_name !== 'string' || typeof row.column_name !== 'string'
			|| typeof row.data_type !== 'string' || !['YES', 'NO'].includes(row.is_nullable as string)
			|| row.is_generated !== 'NEVER' || row.is_identity !== 'NO'
			|| (row.column_default !== null && typeof row.column_default !== 'string')) {
			throw incompatible('column')
		}
		return row
	})
	const requiredTables = [
		[tables.records, RECORD_COLUMNS],
		[tables.heads, HEAD_COLUMNS],
		[tables.tombstones, TOMBSTONE_COLUMNS],
		[tables.migrations, MIGRATION_COLUMNS]
	] as const
	for (const [tableName, requiredColumns] of requiredTables) {
		for (const [columnName, dataType, nullable, requiredDefault] of requiredColumns) {
			const column = columns.find((candidate) => candidate.table_name === tableName && candidate.column_name === columnName)
			const safeDefault = requiredDefault !== 'current-timestamp'
				|| (typeof column?.column_default === 'string'
					&& /^(?:now\(\)|CURRENT_TIMESTAMP)$/i.test(column.column_default))
			if (!column || column.data_type !== dataType || (column.is_nullable === 'YES') !== nullable || !safeDefault) {
				throw incompatible('column')
			}
		}
		if (columns.some((column) => column.table_name === tableName
			&& !requiredColumns.some(([name]) => name === column.column_name)
			&& (column.is_nullable !== 'YES' || column.column_default !== null))) throw incompatible('column')
	}

	const indexesResult = await query<{
		table_name: unknown
		indexname: unknown
		indisunique: unknown
		indisvalid: unknown
		indisready: unknown
		indexdef: unknown
	}>(
		`SELECT table_class.relname AS table_name, index_class.relname AS indexname, index_meta.indisunique,
			index_meta.indisvalid, index_meta.indisready,
			left(pg_get_indexdef(index_meta.indexrelid),4097) AS indexdef
		 FROM pg_index index_meta
		 JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
		 JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
		 JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
		 WHERE table_namespace.nspname = $2 AND table_class.relname = ANY($1::text[])
			AND NOT EXISTS(SELECT 1 FROM pg_constraint constraint_index
				WHERE constraint_index.conindid=index_meta.indexrelid)`,
		[[tables.records, tables.heads, tables.tombstones], schemaName]
	)
	const indexes = new Map(snapshotPgRows<{
		table_name: unknown
		indexname: unknown
		indisunique: unknown
		indisvalid: unknown
		indisready: unknown
		indexdef: unknown
	}>(indexesResult, 128, 'schema index rows').map((raw) => {
		const row = snapshotPgObject(
			raw,
			new Set(['table_name', 'indexname', 'indisunique', 'indisvalid', 'indisready', 'indexdef']),
			'schema index row'
		)
		if (typeof row.table_name !== 'string' || typeof row.indexname !== 'string' || typeof row.indisunique !== 'boolean'
			|| typeof row.indisvalid !== 'boolean' || typeof row.indisready !== 'boolean'
			|| typeof row.indexdef !== 'string') {
			throw incompatible('index')
		}
		return [row.indexname, row] as const
	}))
	const requiredIndexes = [
		['_partition_sequence_idx', / USING btree \(partition_key, sequence\)$/],
		['_occurred_c_idx', / USING btree \(occurred_at DESC, id COLLATE "C" DESC\)$/],
		['_idempotency_hash_idx', / USING btree \(idempotency_hash\) WHERE \(idempotency_hash IS NOT NULL\)$/]
	] as const
	for (const [suffix, definition] of requiredIndexes) {
		const name = `${tables.records}${suffix}`
		const index = indexes.get(name)
		if (!index) throw incompatible('index')
		if (index.table_name !== tables.records || index.indisvalid !== true || index.indisready !== true
			|| (suffix !== '_occurred_c_idx' && index.indisunique !== true)
			|| !definition.test(index.indexdef as string)) {
			throw incompatible('index')
		}
	}
	if (indexes.size !== requiredIndexes.length) throw incompatible('index')

	const constraintsResult = await query<{
		conname: unknown
		table_name: unknown
		contype: unknown
		convalidated: unknown
		definition: unknown
	}>(
		`SELECT constraint_meta.conname, table_class.relname AS table_name,
			constraint_meta.contype, constraint_meta.convalidated,
			left(pg_get_constraintdef(constraint_meta.oid),4097) AS definition
		 FROM pg_constraint constraint_meta
		 JOIN pg_class table_class ON table_class.oid = constraint_meta.conrelid
		 WHERE constraint_meta.conrelid = ANY($1::regclass[])`,
		[[tables.records, tables.heads, tables.tombstones].map((table) =>
			`${quotePostgresIdentifier(schemaName)}.${quotePostgresIdentifier(table)}`)]
	)
	const constraints = new Map(snapshotPgRows<{
		conname: unknown
		table_name: unknown
		contype: unknown
		convalidated: unknown
		definition: unknown
	}>(constraintsResult, 128, 'schema constraint rows').map((raw) => {
		const row = snapshotPgObject(raw, new Set(['conname', 'table_name', 'contype', 'convalidated', 'definition']), 'schema constraint row')
		if (typeof row.conname !== 'string' || typeof row.table_name !== 'string' || typeof row.contype !== 'string'
			|| typeof row.convalidated !== 'boolean' || typeof row.definition !== 'string') {
			throw incompatible('constraint')
		}
		return [row.conname, row] as const
	}))
	const hashPattern = "'^[a-f0-9]{64}$'"
	const pairConstraint = `checkidempotency_hashisnullandsemantic_fingerprintisnulloridempotency_hashisnotnullandsemantic_fingerprintisnotnullandidempotency_hash~${hashPattern}andsemantic_fingerprint~${hashPattern}`
	const pairConstraintStructure = `check((((idempotency_hashisnull)and(semantic_fingerprintisnull))or((idempotency_hashisnotnull)and(semantic_fingerprintisnotnull)and(idempotency_hash~${hashPattern})and(semantic_fingerprint~${hashPattern}))))`
	const requiredConstraints = new Map<string, {tableName: string; definition: string; structure?: string}>([
		[`${tables.records}_sequence_valid`, {tableName: tables.records, definition: 'checksequence>0andsequence<=9007199254740991'}],
		[`${tables.records}_hash_valid`, {tableName: tables.records, definition: `checkhash~${hashPattern}`}],
		[`${tables.records}_prev_hash_valid`, {tableName: tables.records, definition: `checkprev_hashisnullorprev_hash~${hashPattern}`}],
		[`${tables.records}_algorithm_valid`, {tableName: tables.records, definition: "checkalgorithm='sha256-stable-json-v1'"}],
		[`${tables.records}_idempotency_valid`, {tableName: tables.records, definition: pairConstraint, structure: pairConstraintStructure}],
		[`${tables.records}_outcome_valid`, {tableName: tables.records, definition: "checkoutcome=anyarray['attempted','succeeded','failed','denied']"}],
		[`${tables.records}_sensitivity_valid`, {tableName: tables.records, definition: "checksensitivity=anyarray['low','moderate','high','restricted']"}],
		[`${tables.records}_structured_valid`, {tableName: tables.records, definition: "checkjsonb_typeofactor_json='object'andjsonb_typeoftargets_json='array'andjsonb_array_lengthtargets_json>0andjsonb_typeofcorrelation_json='object'andjsonb_typeofcontext_json='object'andjsonb_typeofmetadata_json='object'"}],
		[`${tables.heads}_sequence_valid`, {tableName: tables.heads, definition: 'checklast_sequence>0andlast_sequence<=9007199254740991'}],
		[`${tables.heads}_hash_valid`, {tableName: tables.heads, definition: `checklast_hash~${hashPattern}`}],
		[`${tables.tombstones}_idem_valid`, {tableName: tables.tombstones, definition: pairConstraint, structure: pairConstraintStructure}]
	])
	if ([...requiredConstraints.keys()].some((constraint) => !constraints.has(constraint))) throw incompatible('constraint')
	for (const [name, expected] of requiredConstraints) {
		const constraint = constraints.get(name)
		if (constraint?.convalidated !== true) throw incompatible('constraint')
		if (constraint.table_name !== expected.tableName || constraint.contype !== 'c'
			|| canonicalCheckDefinition(constraint.definition as string) !== expected.definition
			|| (expected.structure !== undefined
				&& canonicalCheckStructure(constraint.definition as string) !== expected.structure)) {
			throw incompatible('constraint')
		}
	}
	const requiredKeys = [
		[tables.records, 'p', 'PRIMARY KEY (id)'],
		[tables.heads, 'p', 'PRIMARY KEY (partition_key)'],
		[tables.tombstones, 'p', 'PRIMARY KEY (record_id_hash)'],
		[tables.tombstones, 'u', 'UNIQUE (idempotency_hash)']
	] as const
	for (const [tableName, type, definition] of requiredKeys) {
		const constraint = [...constraints.values()].find((candidate) => candidate.table_name === tableName
			&& candidate.contype === type && candidate.definition === definition)
		if (!constraint || constraint.convalidated !== true) {
			throw incompatible('constraint')
		}
	}
	if (constraints.size !== requiredConstraints.size + requiredKeys.length) {
		throw incompatible('constraint')
	}

	const migrationResult = await query<{version: unknown}>(
		`SELECT version FROM ${quotePostgresIdentifier(schemaName)}.${quotePostgresIdentifier(tables.migrations)} WHERE version = 5 LIMIT 1`
	)
	const migrationRows = snapshotPgRows<{version: unknown}>(migrationResult, 1, 'schema version rows')
	if (migrationRows.length !== 1
		|| snapshotPgObject(migrationRows[0]!, new Set(['version']), 'schema version row').version !== 5) {
		throw incompatible('version')
	}

	const legacyResult = await query<{count: unknown}>(
		`SELECT count(*)::text AS count FROM ${quotePostgresIdentifier(schemaName)}.${quotePostgresIdentifier(tables.records)} WHERE algorithm <> 'sha256-stable-json-v1'`
	)
	const legacyRows = snapshotPgRows<{count: unknown}>(legacyResult, 1, 'legacy integrity rows')
	const count = legacyRows[0]
		? snapshotPgObject(legacyRows[0], new Set(['count']), 'legacy integrity row').count
		: undefined
	if (count !== '0') throw incompatible('integrity')
}
