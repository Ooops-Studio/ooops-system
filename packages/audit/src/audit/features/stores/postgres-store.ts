import {buildAuditIntegrity, buildAuditScopeIdentity, sha256Stable} from '../../core/integrity'
import type {AuditAppendResult, CompleteAuditStore, PreparedAuditRecord} from '../../types/store'
import {isAuditSafeString} from '../../utils/string-safety'

import {queryPostgresAuditRecords} from './postgres-query'
import {verifyPostgresAuditSchema} from './postgres-schema'
import {
	auditRowProjection,
	auditRowGuard,
	acquirePgAdvisoryLocks,
	boundedAuditPgRow,
	boundedHeadPgRow,
	bindPgQueryable,
	ensurePgDurableTransaction,
	parsePgSafeInteger,
	parseAuditRow,
	readPgMethod,
	snapshotPgObject,
	snapshotPgRowCount,
	snapshotPgRows,
	snapshotStoredAuditRow,
	toJson,
	withPgAuditSavepoint,
	withRepeatableReadTransaction,
	withTransaction,
	type PgClient,
	type PgPoolLike,
	type PgQueryable,
	type PostgresAuditStoreOptions,
	type PostgresAuditTables,
	type StoredAuditRow
} from './postgres-support'

export type {PgClient, PgPoolLike, PgQueryable, PgQueryResult, PostgresAuditStoreOptions} from './postgres-support'
export interface PostgresAuditStore extends CompleteAuditStore {
	readonly kind: 'postgres'
	verifyCompatibility(): Promise<void>
	assertCallerTransactionsSupported(): void
}

function quotePostgresIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}

function incompatibleSchemaIdentity(): Error {
	const error = new Error('Audit schema incompatible.')
	Object.defineProperty(error, 'code', {value: 'AUDIT_SCHEMA_INCOMPATIBLE', enumerable: true})
	return error
}

function assertPgMutation(value: unknown): void {
	if (snapshotPgRowCount(value, 'mutation') !== 1) throw new Error('Audit mutation failed.')
}

type PgIdentityRow = {database_name: unknown; schema_name: unknown; system_identifier: unknown; p: unknown}
const pgIdentityFields = new Set(['database_name', 'schema_name', 'system_identifier', 'p'])
const pgIdentitySql = `SELECT pg_catalog.current_database() AS database_name,pg_catalog.current_schema() AS schema_name,
	(SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()) AS system_identifier,
	pg_catalog.array_position(pg_catalog.current_schemas(true),'pg_catalog') AS p`

function serializeDedicatedClient(client: PgQueryable): PostgresAuditStoreOptions['client'] {
	let tail = Promise.resolve()
	const acquire = async() => {
		let release!: () => void
		const previous = tail
		tail = new Promise<void>((resolve) => { release = resolve })
		await previous
		let released = false
		return () => {
			if (released) return
			released = true
			release()
		}
	}
	const serialized = {
		query: async<T>(sql: string, params?: unknown[]) => {
			const release = await acquire()
			try { return await client.query<T>(sql, params) } finally { release() }
		},
		connect: async() => {
			const release = await acquire()
			return {query: <T>(sql: string, params?: unknown[]) => client.query<T>(sql, params), release}
		}
	}
	return serialized
}

export function createPostgresAuditStore(options: PostgresAuditStoreOptions): PostgresAuditStore {
	if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Audit invalid store options.')
	let optionValues: Record<string, unknown>
	try {
		const prototype = Object.getPrototypeOf(options)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		optionValues = Object.create(null) as Record<string, unknown>
		for (const key of Reflect.ownKeys(options)) {
			if (typeof key !== 'string' || !['client', 'tablePrefix'].includes(key)) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(options, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			optionValues[key] = descriptor.value
		}
	} catch { throw new Error('Audit invalid store options.') }
	const rawClient = optionValues.client
	if (!rawClient || typeof rawClient !== 'object' || Array.isArray(rawClient)) throw new Error('Audit PG client required.')
	const queryMethod = bindPgQueryable(rawClient).query
	const connectMethod = readPgMethod(rawClient, 'connect')
	const rootReleaseMethod = readPgMethod(rawClient, 'release')
	let connectionFactoryVerified = false
	const client: PgPoolLike = {
		query: queryMethod,
		...(connectMethod && !rootReleaseMethod ? {
			connect: async() => {
				const connected = await connectMethod()
				let release: ((...arguments_: unknown[]) => unknown) | undefined
				try {
					if (connected && typeof connected === 'object' && !Array.isArray(connected)) {
						release = readPgMethod(connected, 'release')
					}
					if (!connected || typeof connected !== 'object' || Array.isArray(connected) || connected === rawClient
						|| !readPgMethod(connected, 'query') || !release) throw new Error()
				} catch {
					try { await release?.() } catch { /* preserve invalid-client failure */ }
					throw new Error('Audit invalid PG client.')
				}
				connectionFactoryVerified = true
				return connected as PgClient
			}
		} : {})
	}
	const rawTablePrefix = optionValues.tablePrefix ?? 'audit'
	if (typeof rawTablePrefix !== 'string' || rawTablePrefix.length > 30 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawTablePrefix)) {
		throw new Error('Audit invalid PG prefix.')
	}
	// Identifiers are intentionally interpolated unquoted, so PostgreSQL folds
	// every accepted mixed-case prefix to lowercase. Keep catalog verification
	// and runtime statements on that same canonical identifier.
	const tablePrefix = rawTablePrefix.toLowerCase()
	const catalogTables: PostgresAuditTables = {
		records: `${tablePrefix}_records`, heads: `${tablePrefix}_chain_heads`,
		migrations: `${tablePrefix}_schema_migrations`, tombstones: `${tablePrefix}_record_tombstones`
	}
	const tables = {...catalogTables}
	const serialized = client.connect ? undefined : serializeDedicatedClient(client)
	const transactionClient = serialized ?? client
	let verifiedDatabase: string | undefined
	let compatibilityPromise: Promise<void> | undefined
	let verifiedSystem: string | undefined
	const readIdentity = async(tx: PgQueryable) => {
		const result = await tx.query<PgIdentityRow>(pgIdentitySql)
		const raw = snapshotPgRows<PgIdentityRow>(result, 1, 'identity rows')[0]
		return raw ? snapshotPgObject(raw, pgIdentityFields, 'identity row') : undefined
	}
	const assertVerifiedTransaction = async(tx: PgQueryable) => {
		if (verifiedDatabase === undefined || verifiedSystem === undefined) return
		const row = await readIdentity(tx)
		if (row?.database_name !== verifiedDatabase || row.system_identifier !== verifiedSystem || row.p !== 1) {
			throw new Error('Audit PostgreSQL identity differs.')
		}
	}
	const retentionContext = {client: transactionClient, tables, verifyTransaction: assertVerifiedTransaction}
	const bindVerifiedIdentity = (identity: {schema: string; database: string; system: string}) => {
		verifiedDatabase = identity.database
		verifiedSystem = identity.system
		const qualifiedSchema = quotePostgresIdentifier(identity.schema)
		for (const key of Object.keys(catalogTables) as Array<keyof PostgresAuditTables>) {
			tables[key] = `${qualifiedSchema}.${quotePostgresIdentifier(catalogTables[key])}`
		}
	}
	const verifyCompatibility = (): Promise<void> => {
		if (compatibilityPromise) return compatibilityPromise
		const verification = withRepeatableReadTransaction(transactionClient, async(tx) => {
			const schemaRow = await readIdentity(tx)
			const schema = schemaRow?.schema_name
			const database = schemaRow?.database_name
			const system = schemaRow?.system_identifier
			if (typeof schema !== 'string' || !schema || Buffer.byteLength(schema) > 63 || !isAuditSafeString(schema)) {
				throw incompatibleSchemaIdentity()
			}
			if (typeof database !== 'string' || !database || Buffer.byteLength(database) > 63 || !isAuditSafeString(database)) {
				throw incompatibleSchemaIdentity()
			}
			if (typeof system !== 'string' || !/^\d{1,20}$/.test(system)) throw incompatibleSchemaIdentity()
			await tx.query('SET LOCAL search_path=pg_catalog,pg_temp')
			await verifyPostgresAuditSchema(
				<T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params),
				catalogTables,
				schema
			)
			return {schema, database, system}
		}, undefined, false).then(bindVerifiedIdentity)
		compatibilityPromise = verification
		void verification.catch(() => {
			if (compatibilityPromise === verification) compatibilityPromise = undefined
		})
		return verification
	}
	const assertCallerTransactionsSupported = () => {
		if (!connectionFactoryVerified) {
			throw new Error('Audit PostgreSQL pool is unverified.')
		}
	}
	let verificationPromise: Promise<typeof import('./postgres-verification')['verifyPostgresAuditIntegrity']> | undefined
	const loadVerification = () => {
		if (verificationPromise) return verificationPromise
		const loading = import('./postgres-verification')
			.then(({verifyPostgresAuditIntegrity}) => verifyPostgresAuditIntegrity)
			.catch((error: unknown) => {
				if (verificationPromise === loading) verificationPromise = undefined
				throw error
			})
		verificationPromise = loading
		return loading
	}
	let retentionPromise: Promise<ReturnType<typeof import('./postgres-retention')['createPostgresRetention']>> | undefined
	const loadRetention = () => {
		if (retentionPromise) return retentionPromise
		const loading = import('./postgres-retention')
			.then(({createPostgresRetention}) => createPostgresRetention(retentionContext))
			.catch((error: unknown) => {
				if (retentionPromise === loading) retentionPromise = undefined
				throw error
			})
		retentionPromise = loading
		return loading
	}

	const acquireLocks = async(tx: PgQueryable, records: ReadonlyArray<PreparedAuditRecord>) => {
		const idempotencyHashes = records.flatMap((record) => record.idempotencyHash ? [record.idempotencyHash] : [])
		await acquirePgAdvisoryLocks(tx, 'idempotency', idempotencyHashes)
		await acquirePgAdvisoryLocks(tx, 'partition', records.map((record) => record.partitionKey))
	}

	const assertExplicitTransaction = async(tx: PgQueryable): Promise<void> => {
		const readTransactionId = async(label: string): Promise<string> => {
			const result = await tx.query<{transaction_id: unknown}>('SELECT pg_catalog.txid_current()::pg_catalog.text AS transaction_id')
			const raw = snapshotPgRows<{transaction_id: unknown}>(result, 1, `${label} transaction id rows`)[0]
			const row = raw ? snapshotPgObject(raw, new Set(['transaction_id']), `${label} transaction id row`) : undefined
			if (typeof row?.transaction_id !== 'string' || !/^\d+$/.test(row.transaction_id)) {
				throw new Error('Audit invalid transaction.')
			}
			return row.transaction_id
		}
		const first = await readTransactionId('first')
		const second = await readTransactionId('second')
		if (first !== second) throw new Error('Audit requires active PostgreSQL transaction.')
	}

	const assertCallerTransactionDatabase = async(tx: PgQueryable): Promise<void> => {
		// The production preset verifies compatibility before exposing this path.
		// Internal unverified store seams remain usable, while verified runtimes
		// reject a transaction connected to a different PostgreSQL database.
		await assertVerifiedTransaction(tx)
	}

	const insertOne = async(tx: PgQueryable, record: PreparedAuditRecord): Promise<AuditAppendResult> => {
		if (record.idempotencyHash) {
			const existing = await tx.query<StoredAuditRow>(`SELECT ${auditRowProjection}
				FROM ${tables.records} AS audit_record ${auditRowGuard} WHERE audit_record.idempotency_hash = $1 LIMIT 1`, [record.idempotencyHash])
			const existingRows = snapshotPgRows<StoredAuditRow>(existing, 1, 'idempotency rows')
			if (existingRows[0]) {
				const existingRow = snapshotStoredAuditRow(existingRows[0])
				if (existingRow.semantic_fingerprint !== record.semanticFingerprint) throw new Error('Audit idempotency conflicts.')
				return {record: parseAuditRow(existingRow), inserted: false}
			}
			const pruned = await tx.query<{semantic_fingerprint: unknown; record_id_hash: unknown}>(
				`SELECT semantic_fingerprint, record_id_hash FROM ${tables.tombstones} WHERE idempotency_hash = $1 LIMIT 1`,
				[record.idempotencyHash]
			)
			const rawPrunedRow = snapshotPgRows<{semantic_fingerprint: unknown; record_id_hash: unknown}>(pruned, 1, 'idempotency tombstone rows')[0]
			if (rawPrunedRow) {
				const row = snapshotPgObject(rawPrunedRow, new Set(['semantic_fingerprint', 'record_id_hash']), 'idempotency tombstone row')
				if (typeof row.semantic_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.semantic_fingerprint)
					|| typeof row.record_id_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.record_id_hash)) {
					throw new Error('Audit invalid tombstone.')
				}
				if (row.semantic_fingerprint !== record.semanticFingerprint) throw new Error('Audit idempotency conflicts.')
				throw new Error('Audit idempotency belongs to a pruned record.')
			}
		}
		const duplicate = await tx.query<{id: string}>(`SELECT id FROM ${tables.records} WHERE id = $1 LIMIT 1`, [record.id])
		if (snapshotPgRows<{id: string}>(duplicate, 1, 'duplicate id rows')[0]) throw new Error('Audit record id already exists.')
		const recordIdHash = sha256Stable({id: record.id})
		const prunedId = await tx.query<{record_id_hash: unknown}>(`SELECT record_id_hash FROM ${tables.tombstones} WHERE record_id_hash = $1 LIMIT 1`, [recordIdHash])
		const rawPrunedId = snapshotPgRows<{record_id_hash: unknown}>(prunedId, 1, 'record tombstone rows')[0]
		if (rawPrunedId) {
			const row = snapshotPgObject(rawPrunedId, new Set(['record_id_hash']), 'record tombstone row')
			if (row.record_id_hash !== recordIdHash) throw new Error('Audit invalid record tombstone.')
			throw new Error('Audit id belongs to a pruned record.')
		}
		type ChainHeadRow = {
			last_sequence: string | number
			last_hash: string | null
			last_record_id: string
			rs: string | number | null
			rh: string | null
			rp: string | null
			rt: string | null
			rw: string | null
		}
		const head = await tx.query<ChainHeadRow>(`SELECT bh.last_sequence::text AS last_sequence,bh.last_hash,bh.last_record_id,br.sequence::text AS rs,br.hash AS rh,br.partition_key AS rp,br.tenant_id AS rt,br.workspace_id AS rw FROM ${tables.heads} h ${boundedHeadPgRow('h', 'bh')} LEFT JOIN ${tables.records} r ON r.id=h.last_record_id ${boundedAuditPgRow('r', 'br')} WHERE h.partition_key=$1 FOR UPDATE OF h`, [record.partitionKey])
		const rawHeadRow = snapshotPgRows<ChainHeadRow>(head, 1, 'chain head rows')[0]
		const headRow = rawHeadRow
			? snapshotPgObject(rawHeadRow, new Set([
				'last_sequence', 'last_hash', 'last_record_id', 'rs', 'rh', 'rp', 'rt', 'rw'
			]), 'chain head row')
			: undefined
		if (headRow !== undefined && headRow.rs === null && headRow.rh === null && headRow.rp === null) {
			throw new Error('Audit partition is sealed.')
		}
		const previous = headRow ? parsePgSafeInteger(headRow.last_sequence, 'chain head sequence', 1) : 0
		const previousHash = headRow?.last_hash ?? null
		const expectedScope = buildAuditScopeIdentity(record)
		const tailScope = buildAuditScopeIdentity({
			...(typeof headRow?.rt === 'string' ? {tenantId: headRow.rt} : {}),
			...(typeof headRow?.rw === 'string' ? {workspaceId: headRow.rw} : {})
		})
		if (previous >= Number.MAX_SAFE_INTEGER
			|| (headRow !== undefined && (
				typeof previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(previousHash)
				|| typeof headRow.last_record_id !== 'string' || !headRow.last_record_id
				|| parsePgSafeInteger(headRow.rs, 'chain head sequence', 1) !== previous
				|| headRow.rh !== previousHash || headRow.rp !== record.partitionKey
				|| (headRow.rt !== null && typeof headRow.rt !== 'string')
				|| (headRow.rw !== null && typeof headRow.rw !== 'string')
				|| tailScope !== expectedScope
			))) {
			throw new Error('Audit invalid chain head.')
		}
		const validPreviousHash: string | null = typeof previousHash === 'string' ? previousHash : null
		const integrity = buildAuditIntegrity(record, {sequence: previous + 1, prevHash: validPreviousHash})
		const inserted = await tx.query(`INSERT INTO ${tables.records} (
			id, idempotency_hash, semantic_fingerprint, event_type, category, action, occurred_at, created_at,
			actor_json, targets_json, outcome, sensitivity, summary, workspace_id, tenant_id, stream,
			correlation_json, context_json, metadata_json, change_set_json, partition_key, sequence, prev_hash, hash, algorithm
		) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23,$24,$25)`, [
			record.id, record.idempotencyHash ?? null, record.semanticFingerprint ?? null, record.eventType, record.category, record.action,
			record.occurredAt, record.createdAt, toJson(record.actor), toJson(record.targets), record.outcome, record.sensitivity,
			record.summary ?? null, record.workspaceId ?? null, record.tenantId ?? null, record.stream ?? null,
			toJson(record.correlation), toJson(record.context), toJson(record.metadata), record.changeSet ? toJson(record.changeSet) : null,
			record.partitionKey, integrity.sequence, integrity.prevHash, integrity.hash, integrity.algorithm
		])
		assertPgMutation(inserted)
		const advanced = await tx.query(`INSERT INTO ${tables.heads} (partition_key,last_sequence,last_hash,last_record_id,updated_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (partition_key) DO UPDATE SET last_sequence=EXCLUDED.last_sequence,last_hash=EXCLUDED.last_hash,last_record_id=EXCLUDED.last_record_id,updated_at=now()`, [record.partitionKey, integrity.sequence, integrity.hash, record.id])
		assertPgMutation(advanced)
		const {idempotencyHash: _hash, semanticFingerprint: _fingerprint, partitionKey: _partition, ...body} = record
		return {record: {...body, integrity}, inserted: true}
	}

	const appendMany = async(tx: PgQueryable, records: ReadonlyArray<PreparedAuditRecord>): Promise<ReadonlyArray<AuditAppendResult>> => {
		await acquireLocks(tx, records)
		const output: AuditAppendResult[] = []
		for (const record of records) output.push(await insertOne(tx, record))
		return output
	}

	return {
		kind: 'postgres',
		assertCallerTransactionsSupported,
		verifyCompatibility,
		appendMany: async(records) => await withTransaction(transactionClient, async(tx) => {
			await ensurePgDurableTransaction(tx)
			return await appendMany(tx, records)
		}, assertVerifiedTransaction),
		appendTransactional: async(transaction, records) => {
			const tx = bindPgQueryable(transaction)
			assertCallerTransactionsSupported()
			await assertExplicitTransaction(tx)
			await assertCallerTransactionDatabase(tx)
			return await withPgAuditSavepoint(tx, async() => {
				await ensurePgDurableTransaction(tx)
				return await appendMany(tx, records)
			})
		},
		getById: async(id) => await withRepeatableReadTransaction(transactionClient, async(tx) => {
			const result = await tx.query<StoredAuditRow>(`SELECT ${auditRowProjection} FROM ${tables.records} AS audit_record
				${auditRowGuard} WHERE audit_record.id = $1 LIMIT 1`, [id])
			const row = snapshotPgRows<StoredAuditRow>(result, 1, 'record lookup rows')[0]
			return row ? parseAuditRow(row) : undefined
		}, assertVerifiedTransaction),
		query: async(auditQuery = {}) => await withRepeatableReadTransaction(transactionClient, async(tx) => {
			return await queryPostgresAuditRecords({query: tx.query, recordsTable: tables.records}, auditQuery)
		}, assertVerifiedTransaction),
		verifyIntegrity: async(filter) => {
			const verifyPostgresAuditIntegrity = await loadVerification()
			return await withRepeatableReadTransaction(transactionClient, async(tx) => {
				return await verifyPostgresAuditIntegrity({
					query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params),
					recordsTable: tables.records,
					headsTable: tables.heads,
					tombstonesTable: tables.tombstones
				}, filter)
			}, assertVerifiedTransaction)
		},
		planPruneBefore: async(before, limit) => await (await loadRetention()).planPruneBefore(before, limit),
		prunePlanned: async(plan) => await (await loadRetention()).prunePlanned(plan)
	}
}
