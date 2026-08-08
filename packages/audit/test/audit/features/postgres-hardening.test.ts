import {describe, expect, it, vi} from 'vitest'

import {verifyPostgresAuditSchema} from '../../../src/audit/features/stores/postgres-schema'
import {createPostgresAuditStore} from '../../../src/audit/features/stores/postgres-store'
import {createProductionAudit} from '../../../src/audit/public/production'

const tables = {
	records: 'audit_records', heads: 'audit_chain_heads', tombstones: 'audit_record_tombstones',
	migrations: 'audit_schema_migrations'
}
const columns = [
	...[
		['id', 'text', false], ['idempotency_hash', 'text', true], ['semantic_fingerprint', 'text', true],
		['event_type', 'text', false], ['category', 'text', false], ['action', 'text', false],
		['occurred_at', 'timestamp with time zone', false], ['created_at', 'timestamp with time zone', false],
		['actor_json', 'jsonb', false], ['targets_json', 'jsonb', false], ['outcome', 'text', false],
		['sensitivity', 'text', false], ['summary', 'text', true], ['workspace_id', 'text', true],
		['tenant_id', 'text', true], ['stream', 'text', true], ['correlation_json', 'jsonb', false],
		['context_json', 'jsonb', false], ['metadata_json', 'jsonb', false], ['change_set_json', 'jsonb', true],
		['partition_key', 'text', false], ['sequence', 'bigint', false], ['prev_hash', 'text', true],
		['hash', 'text', false], ['algorithm', 'text', false]
	].map(([column_name, data_type, nullable]) => ({table_name: tables.records, column_name, data_type, is_nullable: nullable ? 'YES' : 'NO', is_generated: 'NEVER', is_identity: 'NO', column_default: null})),
	...[
		['partition_key', 'text', false], ['last_sequence', 'bigint', false], ['last_hash', 'text', false],
		['last_record_id', 'text', false], ['updated_at', 'timestamp with time zone', false]
	].map(([column_name, data_type, nullable]) => ({table_name: tables.heads, column_name, data_type, is_nullable: nullable ? 'YES' : 'NO', is_generated: 'NEVER', is_identity: 'NO', column_default: null})),
	...[
		['record_id_hash', 'text', false], ['idempotency_hash', 'text', true],
		['semantic_fingerprint', 'text', true], ['pruned_at', 'timestamp with time zone', false, 'now()']
	].map(([column_name, data_type, nullable, column_default]) => ({table_name: tables.tombstones, column_name, data_type, is_nullable: nullable ? 'YES' : 'NO', is_generated: 'NEVER', is_identity: 'NO', column_default: column_default ?? null})),
	...[
		['version', 'integer', false], ['applied_at', 'timestamp with time zone', false]
	].map(([column_name, data_type, nullable]) => ({table_name: tables.migrations, column_name, data_type, is_nullable: nullable ? 'YES' : 'NO', is_generated: 'NEVER', is_identity: 'NO', column_default: null}))
]
const constraints = [
	'audit_records_sequence_valid', 'audit_records_hash_valid', 'audit_records_prev_hash_valid',
	'audit_records_algorithm_valid', 'audit_records_idempotency_valid', 'audit_records_outcome_valid',
	'audit_records_sensitivity_valid', 'audit_records_structured_valid',
	'audit_chain_heads_sequence_valid', 'audit_chain_heads_hash_valid', 'audit_record_tombstones_idem_valid'
]

const constraintDefinitions: Readonly<Record<string, string>> = {
	audit_records_sequence_valid: "CHECK ((sequence > 0) AND (sequence <= '9007199254740991'::bigint))",
	audit_records_hash_valid: "CHECK ((hash ~ '^[a-f0-9]{64}$'::text))",
	audit_records_prev_hash_valid: "CHECK (((prev_hash IS NULL) OR (prev_hash ~ '^[a-f0-9]{64}$'::text)))",
	audit_records_algorithm_valid: "CHECK ((algorithm = 'sha256-stable-json-v1'::text))",
	audit_records_idempotency_valid: "CHECK ((((idempotency_hash IS NULL) AND (semantic_fingerprint IS NULL)) OR ((idempotency_hash IS NOT NULL) AND (semantic_fingerprint IS NOT NULL) AND (idempotency_hash ~ '^[a-f0-9]{64}$'::text) AND (semantic_fingerprint ~ '^[a-f0-9]{64}$'::text))))",
	audit_records_outcome_valid: "CHECK ((outcome = ANY (ARRAY['attempted'::text, 'succeeded'::text, 'failed'::text, 'denied'::text])))",
	audit_records_sensitivity_valid: "CHECK ((sensitivity = ANY (ARRAY['low'::text, 'moderate'::text, 'high'::text, 'restricted'::text])))",
	audit_records_structured_valid: "CHECK (((jsonb_typeof(actor_json) = 'object'::text) AND (jsonb_typeof(targets_json) = 'array'::text) AND (jsonb_array_length(targets_json) > 0) AND (jsonb_typeof(correlation_json) = 'object'::text) AND (jsonb_typeof(context_json) = 'object'::text) AND (jsonb_typeof(metadata_json) = 'object'::text)))",
	audit_chain_heads_sequence_valid: "CHECK ((last_sequence > 0) AND (last_sequence <= '9007199254740991'::bigint))",
	audit_chain_heads_hash_valid: "CHECK ((last_hash ~ '^[a-f0-9]{64}$'::text))",
	audit_record_tombstones_idem_valid: "CHECK ((((idempotency_hash IS NULL) AND (semantic_fingerprint IS NULL)) OR ((idempotency_hash IS NOT NULL) AND (semantic_fingerprint IS NOT NULL) AND (idempotency_hash ~ '^[a-f0-9]{64}$'::text) AND (semantic_fingerprint ~ '^[a-f0-9]{64}$'::text))))"
}

const keyConstraints = [
	{conname: 'audit_records_pkey', table_name: tables.records, contype: 'p', definition: 'PRIMARY KEY (id)'},
	{conname: 'audit_chain_heads_pkey', table_name: tables.heads, contype: 'p', definition: 'PRIMARY KEY (partition_key)'},
	{conname: 'audit_record_tombstones_pkey', table_name: tables.tombstones, contype: 'p', definition: 'PRIMARY KEY (record_id_hash)'},
	{conname: 'audit_record_tombstones_idempotency_hash_key', table_name: tables.tombstones, contype: 'u', definition: 'UNIQUE (idempotency_hash)'}
]

function constraintTable(conname: string): string {
	if (conname.startsWith('audit_chain_heads')) return tables.heads
	if (conname.startsWith('audit_record_tombstones')) return tables.tombstones
	return tables.records
}

function compatibleQuery() {
	return vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
		if (sql.includes('current_schema() AS schema_name')) return {rows: [{database_name: 'audit_db', schema_name: 'public', system_identifier: '123', p: 1}]}
		if (sql.includes('relation_class.relrowsecurity')) return {rows: (parameters?.[1] as string[]).map((name) => ({
			name, safe_relation: true
		}))}
		if (sql.includes('information_schema.columns')) return {rows: columns}
		if (sql.includes('FROM pg_index')) return {rows: [
			{table_name: tables.records, indexname: 'audit_records_partition_sequence_idx', indisunique: true, indisvalid: true, indisready: true,
				indexdef: 'CREATE UNIQUE INDEX audit_records_partition_sequence_idx ON public.audit_records USING btree (partition_key, sequence)'},
			{table_name: tables.records, indexname: 'audit_records_occurred_c_idx', indisunique: false, indisvalid: true, indisready: true,
				indexdef: 'CREATE INDEX audit_records_occurred_c_idx ON public.audit_records USING btree (occurred_at DESC, id COLLATE "C" DESC)'},
			{table_name: tables.records, indexname: 'audit_records_idempotency_hash_idx', indisunique: true, indisvalid: true, indisready: true,
				indexdef: 'CREATE UNIQUE INDEX audit_records_idempotency_hash_idx ON public.audit_records USING btree (idempotency_hash) WHERE (idempotency_hash IS NOT NULL)'}
		]}
		if (sql.includes('pg_constraint')) return {rows: [
			...constraints.map((conname) => ({
				conname, table_name: constraintTable(conname), contype: 'c', convalidated: true,
				definition: constraintDefinitions[conname]
			})),
			...keyConstraints.map((constraint) => ({...constraint, convalidated: true}))
		]}
		if (sql.includes('WHERE version = 5')) return {rows: [{version: 5}]}
		if (sql.includes("algorithm <> 'sha256")) return {rows: [{count: '0'}]}
		return {rows: []}
	})
}

describe('audit PostgreSQL schema ownership', () => {
	it('performs read-only compatibility validation and never executes DDL', async() => {
		const query = compatibleQuery()
		await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).resolves.toBeUndefined()
		const statements = query.mock.calls.map(([sql]) => sql)
		expect(statements.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true)
		expect(statements.filter((sql) => /column_default|pg_get_(?:index|constraint)def/.test(sql)))
			.toHaveLength(3)
		expect(statements.filter((sql) => /column_default|pg_get_(?:index|constraint)def/.test(sql))
			.every((sql) => sql.includes('4097'))).toBe(true)
	})

	it('binds catalog and content verification to the exact quoted schema', async() => {
		const query = compatibleQuery()
		await expect(verifyPostgresAuditSchema(query as never, tables, 'tenant "audit')).resolves.toBeUndefined()

		const relation = query.mock.calls.find(([sql]) => String(sql).includes('relation_class.relrowsecurity'))
		const columnsCall = query.mock.calls.find(([sql]) => String(sql).includes('information_schema.columns'))
		const indexCall = query.mock.calls.find(([sql]) => String(sql).includes('FROM pg_index'))
		const constraintCall = query.mock.calls.find(([sql]) => String(sql).includes('constraint_meta.conname'))
		expect(relation?.[1]?.[0]).toBe('tenant "audit')
		expect(columnsCall?.[1]?.[1]).toBe('tenant "audit')
		expect(indexCall?.[1]?.[1]).toBe('tenant "audit')
		expect(constraintCall?.[1]?.[0]).toEqual([
			'"tenant ""audit"."audit_records"',
			'"tenant ""audit"."audit_chain_heads"',
			'"tenant ""audit"."audit_record_tombstones"'
		])
		expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM "tenant ""audit"."audit_schema_migrations"'))).toBe(true)
		expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM "tenant ""audit"."audit_records"'))).toBe(true)
	})

	it('fails closed with a stable code for missing tables, columns, indexes, versions, and legacy algorithms', async() => {
		for (const mutate of [
			(sql: string) => sql.includes('relation_class.relrowsecurity') ? {rows: []} : undefined,
			(sql: string) => sql.includes('information_schema.columns') ? {rows: []} : undefined,
			(sql: string) => sql.includes('FROM pg_index') ? {rows: []} : undefined,
			(sql: string) => sql.includes('pg_constraint') ? {rows: []} : undefined,
			(sql: string) => sql.includes('WHERE version = 5') ? {rows: []} : undefined,
			(sql: string) => sql.includes("algorithm <> 'sha256") ? {rows: [{count: '1'}]} : undefined
		]) {
			const base = compatibleQuery()
			const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => mutate(sql) ?? await base(sql, parameters))
			await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toMatchObject({
				code: 'AUDIT_SCHEMA_INCOMPATIBLE'
			})
		}
	})

	it('rejects hostile metadata rows without executing accessors', async() => {
		const getter = vi.fn(() => false)
		const row = {name: 'audit_records'}
		Object.defineProperty(row, 'safe_relation', {enumerable: true, get: getter})
		const query = vi.fn(async(sql: string) => sql.includes('relation_class.relrowsecurity') ? {rows: [row]} : {rows: []})
		await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toThrow(/relation row/)
		expect(getter).not.toHaveBeenCalled()
	})

	it('rejects unsafe relation behavior and verifies every guarded catalog property', async() => {
		const base = compatibleQuery()
		const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
			const result = await base(sql, parameters)
			if (!sql.includes('relation_class.relrowsecurity')) return result
			return {rows: result.rows.map((row) => (row as {name?: string}).name === tables.records
				? {...row as object, safe_relation: false}
				: row)}
		})
		await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toMatchObject({
			code: 'AUDIT_SCHEMA_INCOMPATIBLE'
		})
		const sql = base.mock.calls.find(([statement]) => statement.includes('safe_relation'))?.[0] ?? ''
		expect(sql).toMatch(/relkind='r'.*relpersistence='p'/s)
		expect(sql).toContain("amname='heap'")
		expect(sql).toMatch(/relrowsecurity.*relforcerowsecurity/s)
		expect(sql).toMatch(/pg_trigger.*pg_rewrite.*pg_inherits/s)
	})

	it('rejects generated and identity-owned mandatory audit columns', async() => {
		for (const mutation of [{is_generated: 'ALWAYS'}, {is_identity: 'YES'}]) {
			const base = compatibleQuery()
			const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
				const result = await base(sql, parameters)
				if (!sql.includes('information_schema.columns')) return result
				return {rows: result.rows.map((row) => (row as {table_name?: string; column_name?: string}).table_name === tables.records
					&& (row as {column_name?: string}).column_name === 'metadata_json'
					? {...row as object, ...mutation}
					: row)}
			})
			await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toMatchObject({
				code: 'AUDIT_SCHEMA_INCOMPATIBLE'
			})
		}
	})

	it('rejects additional columns with write-affecting defaults or nullability', async() => {
		for (const extension of [
			{is_nullable: 'YES', column_default: "nextval('unsafe_sequence'::regclass)"},
			{is_nullable: 'NO', column_default: null}
		]) {
			const base = compatibleQuery()
			const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
				const result = await base(sql, parameters)
				return sql.includes('information_schema.columns') ? {rows: [...result.rows, {
					table_name: tables.records, column_name: 'unsafe_extension', data_type: 'text',
					is_generated: 'NEVER', is_identity: 'NO', ...extension
				}]} : result
			})
			await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toMatchObject({
				code: 'AUDIT_SCHEMA_INCOMPATIBLE'
			})
		}
	})

	it('rejects correctly named but non-unique indexes and unsafe key constraints', async() => {
		for (const mutate of [
			(sql: string, rows: unknown[]) => sql.includes('information_schema.columns')
				? {rows: rows.map((row) => (row as {table_name?: string; column_name?: string}).table_name === tables.heads
					&& (row as {column_name?: string}).column_name === 'last_sequence'
					? {...row as object, data_type: 'text'}
					: row)}
				: undefined,
			(sql: string, rows: unknown[]) => sql.includes('information_schema.columns')
				? {rows: rows.map((row) => (row as {table_name?: string; column_name?: string}).table_name === tables.tombstones
					&& (row as {column_name?: string}).column_name === 'pruned_at'
					? {...row as object, column_default: null}
					: row)}
				: undefined,
			(sql: string, rows: unknown[]) => sql.includes('FROM pg_index')
				? {rows: rows.map((row) => (row as {indexname?: string}).indexname === 'audit_records_idempotency_hash_idx'
					? {...row as object, indisunique: false}
					: row)}
				: undefined,
			(sql: string, rows: unknown[]) => sql.includes('FROM pg_index')
				? {rows: rows.map((row) => (row as {indexname?: string}).indexname === 'audit_records_idempotency_hash_idx'
					? {...row as object, indexdef: 'CREATE UNIQUE INDEX audit_records_idempotency_hash_idx ON public.audit_records USING btree (event_type)'}
					: row)}
				: undefined,
			(sql: string, rows: unknown[]) => sql.includes('pg_constraint')
				? {rows: rows.map((row) => (row as {definition?: string}).definition === 'PRIMARY KEY (id)'
					? {...row as object, definition: 'PRIMARY KEY (event_type)'}
					: row)}
				: undefined,
			(sql: string, rows: unknown[]) => sql.includes('pg_constraint')
				? {rows: rows.map((row) => (row as {conname?: string}).conname === 'audit_records_sequence_valid'
					? {...row as object, definition: 'CHECK (true)'}
					: row)}
				: undefined
		]) {
			const base = compatibleQuery()
			const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
				const result = await base(sql, parameters)
				return mutate(sql, result.rows) ?? result
			})
			await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toMatchObject({
				code: 'AUDIT_SCHEMA_INCOMPATIBLE'
			})
		}
	})

	it('rejects additional indexes and constraints that can change write semantics', async() => {
		for (const mutate of [
			(sql: string, rows: unknown[]) => sql.includes('FROM pg_index') ? {rows: [...rows, {
				table_name: tables.heads, indexname: 'audit_heads_extension', indisunique: false,
				indisvalid: true, indisready: true,
				indexdef: 'CREATE INDEX audit_heads_extension ON public.audit_chain_heads USING btree (last_sequence)'
			}]} : undefined,
			(sql: string, rows: unknown[]) => sql.includes('constraint_meta.conname') ? {rows: [...rows, {
				conname: 'audit_records_extension_check', table_name: tables.records, contype: 'c', convalidated: true,
				definition: 'CHECK (event_type <> \'blocked\'::text)'
			}]} : undefined
		]) {
			const base = compatibleQuery()
			const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
				const result = await base(sql, parameters)
				return mutate(sql, result.rows) ?? result
			})
			await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toMatchObject({
				code: 'AUDIT_SCHEMA_INCOMPATIBLE'
			})
		}
	})

	it('rejects correctly named CHECK constraints attached to the wrong table', async() => {
		const base = compatibleQuery()
		const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
			const result = await base(sql, parameters)
			if (!sql.includes('pg_constraint')) return result
			return {rows: result.rows.map((row) => (row as {conname?: string}).conname === 'audit_records_hash_valid'
				? {...row as object, table_name: tables.heads}
				: row)}
		})

		await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toMatchObject({
			code: 'AUDIT_SCHEMA_INCOMPATIBLE'
		})
	})

	it('rejects idempotency CHECK constraints with the same tokens but unsafe grouping', async() => {
		const base = compatibleQuery()
		const regrouped = "CHECK ((idempotency_hash IS NULL) AND ((semantic_fingerprint IS NULL) OR (idempotency_hash IS NOT NULL)) AND (semantic_fingerprint IS NOT NULL) AND (idempotency_hash ~ '^[a-f0-9]{64}$'::text) AND (semantic_fingerprint ~ '^[a-f0-9]{64}$'::text))"
		const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
			const result = await base(sql, parameters)
			if (!sql.includes('pg_constraint')) return result
			return {rows: result.rows.map((row) => (row as {conname?: string}).conname === 'audit_records_idempotency_valid'
				? {...row as object, definition: regrouped}
				: row)}
		})

		await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).rejects.toMatchObject({
			code: 'AUDIT_SCHEMA_INCOMPATIBLE'
		})
	})

	it('accepts PostgreSQL-truncated generated key names when semantics are exact', async() => {
		const base = compatibleQuery()
		const query = vi.fn(async(sql: string, parameters?: readonly unknown[]) => {
			const result = await base(sql, parameters)
			if (!sql.includes('pg_constraint')) return result
			return {rows: result.rows.map((row) => (row as {definition?: string}).definition === 'UNIQUE (idempotency_hash)'
				? {...row as object, conname: 'audit_record_tombstones_idempotency_hash_key_truncated'}
				: row)}
		})

		await expect(verifyPostgresAuditSchema(query as never, tables, 'public')).resolves.toBeUndefined()
	})

	it('captures the PostgreSQL client method and validates options without accessors', () => {
		const getter = vi.fn(() => vi.fn())
		const client = {}
		Object.defineProperty(client, 'query', {enumerable: true, get: getter})
		expect(() => createPostgresAuditStore({client} as never)).toThrow(/query method is not readable/)
		expect(getter).not.toHaveBeenCalled()
	})

	it('canonicalizes mixed-case unquoted PostgreSQL table prefixes', async() => {
		const query = vi.fn(async(sql: string) => sql.includes('current_schema() AS schema_name')
			? {rows: [{database_name: 'audit_db', schema_name: 'public', system_identifier: '123'}]}
			: {rows: []})
		const store = createPostgresAuditStore({client: {query}, tablePrefix: 'AuditProd'})

		await expect(store.verifyCompatibility()).rejects.toMatchObject({code: 'AUDIT_SCHEMA_INCOMPATIBLE'})
		const relationCall = query.mock.calls.find(([sql]) => String(sql).includes('relation_class.relrowsecurity'))
		expect(relationCall?.[1]?.[1]).toEqual([
			'auditprod_records',
			'auditprod_chain_heads',
			'auditprod_record_tombstones',
			'auditprod_schema_migrations'
		])
		expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
			'BEGIN',
			'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
			'ROLLBACK'
		]))
	})

	it('verifies compatibility on one acquired connection and releases it after commit', async() => {
		const connectionQuery = compatibleQuery()
		const release = vi.fn()
		const connect = vi.fn(async() => ({query: connectionQuery, release}))
		const poolQuery = vi.fn(async() => ({rows: []}))
		const store = createPostgresAuditStore({client: {query: poolQuery, connect}})

		await expect(store.verifyCompatibility()).resolves.toBeUndefined()
		expect(() => store.assertCallerTransactionsSupported()).not.toThrow()
		expect(connect).toHaveBeenCalledOnce()
		expect(poolQuery).not.toHaveBeenCalled()
		expect(connectionQuery.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
			'BEGIN',
			'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
			'COMMIT'
		]))
		expect(release).toHaveBeenCalledOnce()
	})

	it('rejects caller transactions from a database other than the verified production database', async() => {
		const connectionQuery = compatibleQuery()
		const connect = vi.fn(async() => ({query: connectionQuery, release: vi.fn()}))
		const store = createPostgresAuditStore({client: {query: vi.fn(async() => ({rows: []})), connect}})
		await store.verifyCompatibility()

		const transactionQuery = vi.fn(async(sql: string) => {
			if (sql.includes('txid_current')) return {rows: [{transaction_id: '42'}]}
			if (sql.includes('current_database() AS database_name')) return {rows: [{database_name: 'foreign_db', system_identifier: '123'}]}
			return {rows: []}
		})
		await expect(store.appendTransactional({query: transactionQuery}, []))
			.rejects.toThrow(/PostgreSQL identity differs/)
		expect(transactionQuery.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_xact_lock'))).toBe(false)
		expect(transactionQuery.mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))).toBe(false)
	})

	it('rejects caller transactions from a different cluster with the same database name', async() => {
		const connectionQuery = compatibleQuery()
		const store = createPostgresAuditStore({client: {
			query: vi.fn(async() => ({rows: []})),
			connect: vi.fn(async() => ({query: connectionQuery, release: vi.fn()}))
		}})
		await store.verifyCompatibility()
		const query = vi.fn(async(sql: string) => sql.includes('txid_current')
			? {rows: [{transaction_id: '42'}]}
			: {rows: [{database_name: 'audit_db', system_identifier: '456'}]})
		await expect(store.appendTransactional({query}, []))
			.rejects.toThrow(/PostgreSQL identity differs/)
		expect(query.mock.calls.some(([sql]) => String(sql).startsWith('SAVEPOINT'))).toBe(false)
	})

	it('rejects owned operations when a pool switches away from the verified database identity', async() => {
		const verifiedQuery = compatibleQuery()
		const foreignQuery = vi.fn(async(sql: string) => sql.includes('current_database() AS database_name')
			? {rows: [{database_name: 'foreign_db', schema_name: 'public', system_identifier: '456', p: 1}]}
			: {rows: []})
		const connect = vi.fn()
			.mockResolvedValueOnce({query: verifiedQuery, release: vi.fn()})
			.mockResolvedValue({query: foreignQuery, release: vi.fn()})
		const store = createPostgresAuditStore({client: {query: vi.fn(async() => ({rows: []})), connect}})
		await store.verifyCompatibility()

		for (const operation of [
			() => store.getById('missing'),
			() => store.appendMany([]),
			() => store.query(),
			() => store.verifyIntegrity(),
			() => store.planPruneBefore('2024-01-01T00:00:00.000Z', 1),
			() => store.prunePlanned({} as never)
		]) await expect(operation()).rejects.toThrow(/PostgreSQL identity differs/)
		expect(foreignQuery.mock.calls.some(([sql]) => String(sql).includes('FROM "public"."audit_records"'))).toBe(false)
	})

	it('rejects a compatible dedicated client for production transaction isolation', async() => {
		const query = compatibleQuery()
		const store = createPostgresAuditStore({client: {query}})

		await expect(store.verifyCompatibility()).resolves.toBeUndefined()
		const verificationCallCount = query.mock.calls.length
		await store.getById('missing')
		await store.query()
		expect(query.mock.calls.slice(verificationCallCount)
			.filter(([sql]) => String(sql).includes('FROM "public"."audit_records"'))).toHaveLength(2)
		expect(() => store.assertCallerTransactionsSupported()).toThrow(/PostgreSQL pool is unverified/)
		await expect(createProductionAudit({
			clock: {now: () => 0},
			postgres: {client: {query: compatibleQuery()}}
		})).rejects.toThrow(/PostgreSQL pool is unverified/)
	})
})
