import type {AuditRecord} from '@ooopsstudio/core/contracts/audit'

import {AUDIT_MAXIMUM_LIMITS} from '../../constants'
import {snapshotAuditValue} from '../../utils/redaction'
import {isAuditSafeString} from '../../utils/string-safety'
import {compareAuditText} from '../../utils/validation'

export interface PgQueryResult<T = Record<string, unknown>> {rows: T[]; rowCount?: number | null}
export interface PgQueryable {query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>}
export interface PgClient extends PgQueryable {release(): void | Promise<void>}
export interface PgPoolLike extends PgQueryable {connect?(): Promise<PgClient>}
export interface PostgresAuditStoreOptions {readonly client: PgPoolLike; readonly tablePrefix?: string}
export interface PostgresAuditTables {
	readonly records: string
	readonly heads: string
	readonly migrations: string
	readonly tombstones: string
}

export const AUDIT_PRUNED_PARTITION_PREFIX = '__audit_pruned_partition__:'

export function snapshotPgObject(
	value: unknown,
	allowedFields: ReadonlySet<string>,
	label: string
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Audit invalid ${label}.`)
	}
	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || !allowedFields.has(key)) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			output[key] = descriptor.value
		}
	} catch { throw new Error(`Audit invalid ${label}.`) }
	return output
}

export function snapshotPgRowCount(value: unknown, label: string): number {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Audit invalid ${label}.`)
	}
	let rowCount: unknown
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'rowCount')
		if (!descriptor || !('value' in descriptor)) throw new Error()
		rowCount = descriptor.value
	} catch { throw new Error(`Audit invalid ${label}.`) }
	if (!Number.isSafeInteger(rowCount) || (rowCount as number) < 0) {
		throw new Error(`Audit invalid ${label}.`)
	}
	return rowCount as number
}

export function parsePgSafeInteger(value: unknown, label: string, minimum = 0): number {
	if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
		throw new Error(`Audit invalid ${label}.`)
	}
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new Error(`Audit invalid ${label}.`)
	}
	return parsed
}

export function snapshotPgRows<T>(value: unknown, maximum: number, label: string): T[] {
	if (!Number.isSafeInteger(maximum) || maximum < 0 || !value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Audit invalid ${label}.`)
	}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'rows')
		if (!descriptor?.enumerable || !('value' in descriptor) || !Array.isArray(descriptor.value)) throw new Error()
		const rows = descriptor.value as unknown[]
		const length = Object.getOwnPropertyDescriptor(rows, 'length')?.value
		if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error()
		const allowed = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
		if (Reflect.ownKeys(rows).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new Error()
		return Array.from({length}, (_, index) => {
			const row = Object.getOwnPropertyDescriptor(rows, String(index))
			if (!row?.enumerable || !('value' in row)) throw new Error()
			return row.value as T
		})
	} catch { throw new Error(`Audit invalid ${label}.`) }
}

export type StoredAuditRow = {
	id: unknown; idempotency_hash?: unknown; semantic_fingerprint?: unknown; event_type: unknown; category: unknown; action: unknown
	occurred_at: unknown; created_at: unknown; actor_json: unknown; targets_json: unknown; outcome: unknown; sensitivity: unknown
	summary: unknown; workspace_id: unknown; tenant_id: unknown; stream: unknown; correlation_json: unknown; context_json: unknown
	metadata_json: unknown; change_set_json: unknown; partition_key: unknown; sequence: unknown; prev_hash: unknown; hash: unknown
	algorithm: unknown
}

const storedAuditRowFieldNames = [
	'id', 'idempotency_hash', 'semantic_fingerprint', 'event_type', 'category', 'action', 'occurred_at',
	'created_at', 'actor_json', 'targets_json', 'outcome', 'sensitivity', 'summary', 'workspace_id',
	'tenant_id', 'stream', 'correlation_json', 'context_json', 'metadata_json', 'change_set_json',
	'partition_key', 'sequence', 'prev_hash', 'hash', 'algorithm'
] as const
const storedAuditRowFields = new Set<string>(storedAuditRowFieldNames)

export function snapshotStoredAuditRow(value: unknown): StoredAuditRow {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Audit invalid PostgreSQL row.')
	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string') throw new Error()
			if (!storedAuditRowFields.has(key)) continue
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			output[key] = descriptor.value
		}
	} catch { throw new Error('Audit invalid PostgreSQL row.') }
	return output as unknown as StoredAuditRow
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 16_384 || !isAuditSafeString(value)) {
		throw new Error(`Audit invalid ${field}.`)
	}
	return value
}
function optionalString(value: unknown, field: string): string | undefined {
	if (value === null || value === undefined) return undefined
	return requiredString(value, field)
}
function parseJson(value: unknown, field: string): unknown {
	try {
		if (typeof value === 'string') {
			if (Buffer.byteLength(value) > AUDIT_MAXIMUM_LIMITS.maxRecordBytes) throw new Error()
			value = JSON.parse(value) as unknown
		}
		return snapshotAuditValue(value, field, AUDIT_MAXIMUM_LIMITS)
	} catch {
		throw new Error(`Audit invalid ${field}.`)
	}
}
function iso(value: unknown, field: string): string {
	if (value instanceof Date) {
		const time = Date.prototype.getTime.call(value)
		if (Number.isFinite(time)) return new Date(time).toISOString()
	}
	const text = requiredString(value, field)
	const fraction = /\.(\d+)(?=(?:Z|[+-]\d{2}(?::?\d{2})?)?$)/i.exec(text)?.[1]
	if (fraction && fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) {
		throw new Error(`Audit sub-millisecond ${field}.`)
	}
	const time = Date.parse(text)
	if (!Number.isFinite(time)) throw new Error(`Audit invalid ${field}.`)
	return new Date(time).toISOString()
}

export function parseAuditRow(row: StoredAuditRow, options: {allowInvalidIntegrity?: boolean} = {}): AuditRecord {
	row = snapshotStoredAuditRow(row)
	let sequence: number
	try { sequence = parsePgSafeInteger(row.sequence, 'row sequence', 1) } catch {
		throw new Error('Audit unsafe sequence.')
	}
	const actor = parseJson(row.actor_json, 'actor_json') as AuditRecord['actor']
	const targets = parseJson(row.targets_json, 'targets_json') as AuditRecord['targets']
	const correlation = parseJson(row.correlation_json, 'correlation_json') as AuditRecord['correlation']
	const context = parseJson(row.context_json, 'context_json') as AuditRecord['context']
	const metadata = parseJson(row.metadata_json, 'metadata_json') as AuditRecord['metadata']
	const changeSet = row.change_set_json === null || row.change_set_json === undefined
		? undefined
		: parseJson(row.change_set_json, 'change_set_json') as AuditRecord['changeSet']
	if (!actor || typeof actor !== 'object' || Array.isArray(actor) || !Array.isArray(targets) || targets.length === 0
		|| !correlation || typeof correlation !== 'object' || Array.isArray(correlation)
		|| !context || typeof context !== 'object' || Array.isArray(context)
		|| !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
		|| (changeSet !== undefined && (!changeSet || typeof changeSet !== 'object' || Array.isArray(changeSet)))) {
		throw new Error('Audit invalid structured PostgreSQL row.')
	}
	const outcome = requiredString(row.outcome, 'outcome') as AuditRecord['outcome']
	const sensitivity = requiredString(row.sensitivity, 'sensitivity') as AuditRecord['sensitivity']
	if (!['attempted', 'succeeded', 'failed', 'denied'].includes(outcome) || !['low', 'moderate', 'high', 'restricted'].includes(sensitivity)) throw new Error('Audit invalid enums.')
	const algorithm = requiredString(row.algorithm, 'algorithm')
	const hash = requiredString(row.hash, 'hash')
	if (!options.allowInvalidIntegrity
		&& (algorithm !== 'sha256-stable-json-v1' || !/^[a-f0-9]{64}$/.test(hash))) {
		throw new Error('Audit invalid integrity metadata.')
	}
	const prevHash = row.prev_hash === null ? null : requiredString(row.prev_hash, 'prev_hash')
	if (!options.allowInvalidIntegrity && prevHash !== null && !/^[a-f0-9]{64}$/.test(prevHash)) {
		throw new Error('Audit invalid integrity metadata.')
	}
	const partitionKey = requiredString(row.partition_key, 'partition_key')
	if (partitionKey.length > 512) throw new Error('Audit invalid partition_key.')
	const summary = optionalString(row.summary, 'summary')
	const workspaceId = optionalString(row.workspace_id, 'workspace_id')
	const tenantId = optionalString(row.tenant_id, 'tenant_id')
	const stream = optionalString(row.stream, 'stream')
	const record: AuditRecord = {
		id: requiredString(row.id, 'id'), eventType: requiredString(row.event_type, 'event_type'), category: requiredString(row.category, 'category'),
		action: requiredString(row.action, 'action'), occurredAt: iso(row.occurred_at, 'occurred_at'), createdAt: iso(row.created_at, 'created_at'),
		actor, targets, outcome, sensitivity, ...(summary ? {summary} : {}),
		...(workspaceId ? {workspaceId} : {}),
		...(tenantId ? {tenantId} : {}),
		...(stream ? {stream} : {}),
		correlation, context, metadata, ...(changeSet ? {changeSet} : {}),
		integrity: {partitionKey, sequence, prevHash, hash, algorithm: algorithm as AuditRecord['integrity']['algorithm']}
	}
	if (Buffer.byteLength(JSON.stringify(record)) > AUDIT_MAXIMUM_LIMITS.maxRecordBytes) {
		throw new Error('Audit record is too large.')
	}
	return record
}

export const auditRowProjection = 'b.*'

/** Returns one all-null projection for an oversized row so reads reject it fail-closed without transferring its payload. */
function pgFields(source: string, fields: readonly string[]): string {
	return fields.map((field) => `${source}.${field}`).join(',')
}
export function auditPgFields(source: string): string {
	return pgFields(source, storedAuditRowFieldNames)
}
function boundedPgFields(source: string, alias: string, fields: readonly string[], maximum: number): string {
	return `LEFT JOIN LATERAL(SELECT safe_fields.* FROM(SELECT ${pgFields(source, fields)})safe_fields WHERE octet_length(row_to_json(safe_fields)::text)<=${maximum} OFFSET 0)${alias} ON true`
}
export function boundedAuditPgRow(source: string, alias: string): string {
	return boundedPgFields(source, alias, storedAuditRowFieldNames, AUDIT_MAXIMUM_LIMITS.maxRecordBytes)
}
export function boundedHeadPgRow(source: string, alias: string): string {
	return boundedPgFields(source, alias, ['partition_key', 'last_sequence', 'last_hash', 'last_record_id'], 2048)
}
export const auditRowGuard = boundedAuditPgRow('audit_record', 'b')

export function toJson(value: unknown): string { return JSON.stringify(value) }
export function encodeAuditCursor(record: AuditRecord): string { return Buffer.from(JSON.stringify({occurredAt: record.occurredAt, id: record.id})).toString('base64url') }

export async function acquirePgAdvisoryLocks(tx: PgQueryable, scope: string, values: ReadonlyArray<string>): Promise<void> {
	const keys = [...new Set(values)].sort(compareAuditText)
	if (keys.length) await tx.query(
		'SELECT pg_advisory_xact_lock(hashtextextended($1||lock_key,0)) FROM unnest($2::text[]) lock_key',
		[`audit:${scope}:`, keys]
	)
}

export async function ensurePgDurableTransaction(tx: PgQueryable): Promise<void> {
	// Preserve stronger replication modes, but never acknowledge an audit
	// mutation while the session explicitly permits loss on database crash.
	await tx.query(`SELECT set_config('synchronous_commit',
		CASE WHEN current_setting('synchronous_commit')='off' THEN 'on'
		ELSE current_setting('synchronous_commit') END,true)`)
}

export async function withPgAuditSavepoint<T>(tx: PgQueryable, fn: () => Promise<T>): Promise<T> {
	const savepoint = 'a'
	await tx.query(`SAVEPOINT ${savepoint}`)
	try {
		const result = await fn()
		await tx.query(`RELEASE ${savepoint}`)
		return result
	} catch(error) {
		try { await tx.query(`ROLLBACK TO ${savepoint};RELEASE ${savepoint}`) }
		catch { try { await tx.query('ROLLBACK') } catch { /* preserve cause */ } }
		throw error
	}
}

export function readPgMethod(value: object, name: 'query' | 'release' | 'connect'): ((...arguments_: unknown[]) => unknown) | undefined {
	let current: object | null = value
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error()
				return descriptor.value.bind(value) as (...arguments_: unknown[]) => unknown
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { throw new Error(`Audit ${name} method is not readable.`) }
	return undefined
}

export function bindPgQueryable(value: unknown): PgQueryable {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Audit invalid PgQueryable transaction.')
	}
	const query = readPgMethod(value, 'query')
	if (!query) throw new Error('Audit invalid PgQueryable transaction.')
	return {
		query: async<T>(sql: string, params?: unknown[]) => await (
			params === undefined ? query(sql) : query(sql, params)
		) as PgQueryResult<T>
	}
}

export async function withTransaction<T>(
	client: PgPoolLike,
	fn: (tx: PgQueryable) => Promise<T>,
	verify?: (tx: PgQueryable) => Promise<void>,
	safePath = true
): Promise<T> {
	const hasConnectionFactory = typeof client.connect === 'function'
	const rawTransaction = hasConnectionFactory ? await client.connect!() : client
	const release = hasConnectionFactory && rawTransaction && typeof rawTransaction === 'object'
		? readPgMethod(rawTransaction, 'release')
		: undefined
	if (hasConnectionFactory && !release) {
		throw new Error('Audit release missing.')
	}
	let tx: PgQueryable
	try { tx = bindPgQueryable(rawTransaction) } catch(error) {
		if (hasConnectionFactory) try { await release?.() } catch { /* preserve validation failure */ }
		throw error
	}
	let began = false
	try { began = true; await tx.query('BEGIN'); if (safePath) await tx.query('SET LOCAL search_path=pg_catalog,pg_temp'); await verify?.(tx); const result = await fn(tx); await tx.query('COMMIT'); return result }
	catch(error) { if (began) try { await tx.query('ROLLBACK') } catch { /* preserve cause */ }; throw error }
	finally { if (hasConnectionFactory) try { await release?.() } catch { /* transaction outcome is authoritative */ } }
}

export async function withRepeatableReadTransaction<T>(
	client: PgPoolLike,
	fn: (tx: PgQueryable) => Promise<T>,
	verify?: (tx: PgQueryable) => Promise<void>,
	safePath = true
): Promise<T> {
	return await withTransaction(client, async(tx) => {
		await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
		await verify?.(tx)
		return await fn(tx)
	}, undefined, safePath)
}
