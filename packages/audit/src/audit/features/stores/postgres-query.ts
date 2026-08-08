import type {
	AuditPage,
	AuditQuery
} from '@ooopsstudio/core/contracts/audit'

import {AUDIT_POSTGRES_RECORD_PAGE_SIZE} from '../../constants'
import {normalizeAuditQuery} from '../../core/handler-support'
import {
	assertAuditIsoTimestamp,
	assertAuditSort,
	decodeAuditCursor,
	resolveAuditQueryLimit
} from '../../utils/validation'

import {
	auditRowProjection,
	auditRowGuard,
	encodeAuditCursor,
	parseAuditRow,
	snapshotPgRows,
	type PgQueryResult,
	type StoredAuditRow
} from './postgres-support'

export interface PostgresAuditQueryContext {
	readonly query: <T>(sql: string, params?: unknown[]) => Promise<PgQueryResult<T>>
	readonly recordsTable: string
}

export async function queryPostgresAuditRecords(
	context: PostgresAuditQueryContext,
	auditQuery: AuditQuery = {}
): Promise<AuditPage> {
	auditQuery = normalizeAuditQuery(auditQuery)
	assertAuditSort(auditQuery.sort)
	const sort = auditQuery.sort ?? 'desc'
	assertAuditIsoTimestamp(auditQuery.from, 'query.from')
	assertAuditIsoTimestamp(auditQuery.to, 'query.to')
	const cursor = decodeAuditCursor(auditQuery.cursor)
	const limit = resolveAuditQueryLimit(auditQuery.limit, 100)
	const physicalLimit = Math.min(limit, AUDIT_POSTGRES_RECORD_PAGE_SIZE)
	const clauses: string[] = []
	const params: unknown[] = []
	const add = (sql: string, value: unknown) => {
		params.push(value)
		clauses.push(sql.replace('?', '$' + params.length))
	}
	if (auditQuery.eventType) add('audit_record.event_type = ?', auditQuery.eventType)
	if (auditQuery.category) add('audit_record.category = ?', auditQuery.category)
	if (auditQuery.action) add('audit_record.action = ?', auditQuery.action)
	if (auditQuery.from) add('audit_record.occurred_at >= ?::timestamptz', auditQuery.from)
	if (auditQuery.to) add('audit_record.occurred_at <= ?::timestamptz', auditQuery.to)
	if (auditQuery.actorKind) add('audit_record.actor_json ->> \'kind\' = ?', auditQuery.actorKind)
	if (auditQuery.actorId) add('audit_record.actor_json ->> \'id\' = ?', auditQuery.actorId)
	if (auditQuery.workspaceId) add('audit_record.workspace_id = ?', auditQuery.workspaceId)
	if (auditQuery.tenantId) add('audit_record.tenant_id = ?', auditQuery.tenantId)
	if (auditQuery.partitionKey) add('audit_record.partition_key = ?', auditQuery.partitionKey)
	const outcomes = Array.isArray(auditQuery.outcome) ? auditQuery.outcome : auditQuery.outcome ? [auditQuery.outcome] : undefined
	if (outcomes) add('audit_record.outcome = ANY(?::text[])', outcomes)
	const sensitivities = Array.isArray(auditQuery.sensitivity)
		? auditQuery.sensitivity
		: auditQuery.sensitivity ? [auditQuery.sensitivity] : undefined
	if (sensitivities) add('audit_record.sensitivity = ANY(?::text[])', sensitivities)
	if (auditQuery.targetEntityType || auditQuery.targetEntityId) {
		const targetClauses: string[] = []
		if (auditQuery.targetEntityType) {
			params.push(auditQuery.targetEntityType)
			targetClauses.push(`target ->> 'entityType' = $${params.length}`)
		}
		if (auditQuery.targetEntityId) {
			params.push(auditQuery.targetEntityId)
			targetClauses.push(`target ->> 'entityId' = $${params.length}`)
		}
		// An oversized/corrupt row makes the bounded projection all-null. Select
		// that sentinel so parsing fails closed, but never expand its unbounded
		// targets array inside PostgreSQL.
		clauses.push(`(b.id IS NULL OR EXISTS (
			SELECT 1 FROM jsonb_array_elements(b.targets_json) AS target
			WHERE ${targetClauses.join(' AND ')}
		))`)
	}
	if (cursor) {
		params.push(cursor.occurredAt, cursor.id)
		const timestampParam = params.length - 1
		const idParam = params.length
		clauses.push(sort === 'asc'
			? `(audit_record.occurred_at, audit_record.id COLLATE "C") > ($${timestampParam}::timestamptz, $${idParam}::text COLLATE "C")`
			: `(audit_record.occurred_at, audit_record.id COLLATE "C") < ($${timestampParam}::timestamptz, $${idParam}::text COLLATE "C")`)
	}
	params.push(physicalLimit + 1)
	const result = await context.query<StoredAuditRow>(
		`SELECT ${auditRowProjection}
		FROM ${context.recordsTable} AS audit_record
		${auditRowGuard}
		${clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''}
		ORDER BY audit_record.occurred_at ${sort.toUpperCase()}, audit_record.id COLLATE "C" ${sort.toUpperCase()}
		LIMIT $${params.length}`,
		params
	)
	const rows = snapshotPgRows<StoredAuditRow>(result, physicalLimit + 1, 'query rows').map((row) => parseAuditRow(row))
	const items = rows.slice(0, physicalLimit)
	const nextCursor = rows.length > physicalLimit ? encodeAuditCursor(items[items.length - 1]!) : undefined
	return {items, ...(nextCursor ? {nextCursor} : {})}
}
