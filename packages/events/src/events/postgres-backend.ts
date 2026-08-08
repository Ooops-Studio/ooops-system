import type {EventDeadLetterSummary, EventDeliveryStatus, EventEnvelope, EventOutboxSummary, EventReplayRequest} from '@ooopsstudio/core/contracts/events'
import {captureSyncMethod, isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {inputField, isolateArrayItemFields, isolateCapabilityFields, isolateInputFields} from './safe-input'
import type {EventsBackend, StoredEventRecord} from './types'

export interface PgQueryResult<T = Record<string, unknown>> {readonly rows: T[]; readonly rowCount?: number | null}
export interface PgQueryable {query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PgQueryResult<T>>}
export interface PostgresEventsBackendOptions {readonly client: PgQueryable; readonly tablePrefix?: string}

type PgTimestamp = string | Date
type Row = {event_id: string; envelope_json: unknown; status: EventDeliveryStatus; attempts: number; last_error: string | null; next_attempt_at: PgTimestamp | null; processing_started_at: PgTimestamp | null; processing_by: string | null; created_at: PgTimestamp; updated_at: PgTimestamp}

const assertPrefix = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,55}$/u.test(value)) throw new Error('EVENTS_TABLE_PREFIX_INVALID'); return value }
const sanitizeFailureCode = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(value)
	? value
	: undefined
const boundedLimit = (value: number | undefined, fallback = 100): number => {
	const result = value ?? fallback
	if (!Number.isSafeInteger(result) || result < 1 || result > 1_000) throw new Error('EVENTS_ADMIN_INPUT_INVALID')
	return result
}
const timestamp = (value: unknown): number => {
	let result: number
	try {
		result = typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : Number.NaN
	} catch(error) { isolateUnexpectedThenable(error); throw new Error('EVENTS_POSTGRES_ROW_INVALID') }
	if (!Number.isFinite(result)) throw new Error('EVENTS_POSTGRES_ROW_INVALID')
	return result
}
const captureQuery = (value: PgQueryable): PgQueryable['query'] => {
	const query = captureSyncMethod<Parameters<PgQueryable['query']>, ReturnType<PgQueryable['query']>>(value, 'query')
	if (!query) throw new Error('EVENTS_POSTGRES_CLIENT_INVALID')
	return (async<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PgQueryResult<T>> => {
		try {
			const result = await query(sql, params)
			isolateInputFields(result, ['rows', 'rowCount'])
			const rows = inputField(result, 'rows', 'EVENTS_POSTGRES_RESULT_INVALID')
			const rowCount = inputField(result, 'rowCount', 'EVENTS_POSTGRES_RESULT_INVALID')
			isolateArrayItemFields(rows, [], 10_000)
			if (!Array.isArray(rows) || (rowCount !== undefined && rowCount !== null
				&& (!Number.isSafeInteger(rowCount) || (rowCount as number) < 0))) throw new Error('EVENTS_POSTGRES_RESULT_INVALID')
			return {rows, ...(rowCount === undefined ? {} : {rowCount})} as PgQueryResult<T>
		}
		catch(error) { isolateUnexpectedThenable(error); throw error }
	}) as PgQueryable['query']
}
const encodeEnvelope = (record: StoredEventRecord): string => JSON.stringify({...record.envelope, __events: {
	payloadValidated: record.payloadValidated, binding: record.binding,
	traceContext: record.traceContext, expiresAt: record.expiresAt
}})
const decode = (row: Row): StoredEventRecord => {
	isolateInputFields(row, ['event_id', 'envelope_json', 'status', 'attempts', 'last_error', 'next_attempt_at', 'processing_started_at', 'processing_by', 'created_at', 'updated_at'])
	if (!row || typeof row !== 'object' || !row.envelope_json || typeof row.envelope_json !== 'object' || Array.isArray(row.envelope_json)) throw new Error('EVENTS_POSTGRES_ROW_INVALID')
	const raw = structuredClone(row.envelope_json) as Record<string, unknown>
	const metadata = raw.__events && typeof raw.__events === 'object' ? raw.__events as Record<string, unknown> : undefined
	delete raw.__events
	const envelope = Object.freeze(raw) as unknown as EventEnvelope
	const updatedAt = timestamp(row.updated_at); const createdAt = timestamp(row.created_at)
	return Object.freeze({envelope, ...(metadata?.payloadValidated === true ? {payloadValidated: true as const} : {}),
		...(metadata?.binding ? {binding: metadata.binding as StoredEventRecord['binding']} : {}),
		...(metadata?.traceContext ? {traceContext: metadata.traceContext as StoredEventRecord['traceContext']} : {}),
		status: row.status, attempts: row.attempts, availableAt: row.next_attempt_at ? timestamp(row.next_attempt_at) : (envelope.availableAt ? Date.parse(envelope.availableAt) : createdAt),
		...(typeof metadata?.expiresAt === 'number' ? {expiresAt: metadata.expiresAt} : envelope.expiresAt ? {expiresAt: Date.parse(envelope.expiresAt)} : {}),
		createdAt, updatedAt, ...(row.processing_by && row.processing_started_at ? {lease: {
			owner: row.processing_by, expiresAt: timestamp(row.processing_started_at), generation: row.attempts
		}} : {}),
		...(sanitizeFailureCode(row.last_error) ? {failureCode: sanitizeFailureCode(row.last_error)} : {})})
}
const eventType = (row: Row): string => {
	isolateInputFields(row, ['envelope_json'])
	const value = row.envelope_json && typeof row.envelope_json === 'object' && !Array.isArray(row.envelope_json)
		? (row.envelope_json as Record<string, unknown>).type : undefined
	return typeof value === 'string' && value && value.length <= 160 ? value : 'events.invalid'
}
const summary = (row: Row): EventOutboxSummary => { isolateInputFields(row, ['event_id', 'status', 'attempts', 'created_at', 'updated_at', 'next_attempt_at', 'last_error']); return Object.freeze({eventId: row.event_id, type: eventType(row),
	status: row.status, attempts: row.attempts, createdAt: new Date(timestamp(row.created_at)).toISOString(), updatedAt: new Date(timestamp(row.updated_at)).toISOString(),
	...(row.next_attempt_at ? {availableAt: new Date(timestamp(row.next_attempt_at)).toISOString()} : {}),
	...(sanitizeFailureCode(row.last_error) ? {failureCode: sanitizeFailureCode(row.last_error)} : {})}) }
const poison = (row: Row): StoredEventRecord => Object.freeze({
	envelope: Object.freeze({id: row.event_id}) as unknown as EventEnvelope,
	status: 'dispatching', attempts: row.attempts, availableAt: 0, createdAt: 0, updatedAt: 0,
	lease: {owner: row.processing_by ?? '', expiresAt: 0, generation: row.attempts}
})

export function createPostgresEventsBackend(options: PostgresEventsBackendOptions): EventsBackend {
	isolateInputFields(options, ['tablePrefix', 'client'])
	const client = inputField(options, 'client', 'EVENTS_POSTGRES_CLIENT_INVALID') as PgQueryable
	isolateCapabilityFields(client, ['query'])
	const prefix = assertPrefix(inputField(options, 'tablePrefix', 'EVENTS_TABLE_PREFIX_INVALID') ?? 'events'); const outbox = `${prefix}_outbox`; const inbox = `${prefix}_inbox`; const query = captureQuery(client)
	const liveEnvelope = 'CASE WHEN envelope_json#>>\'{__events,expiresAt}\' ~ \'^-?[0-9]{1,16}$\' THEN (envelope_json#>>\'{__events,expiresAt}\')::numeric>$1 ELSE true END'
	const expiredEnvelope = '(envelope_json#>>\'{__events,expiresAt}\') ~ \'^-?[0-9]{1,16}$\' AND (envelope_json#>>\'{__events,expiresAt}\')::numeric<=$1'
	const appendWith = async(client: PgQueryable['query'], batch: readonly StoredEventRecord[]): Promise<void> => {
		if (!Array.isArray(batch) || batch.length > 1_000) throw new Error('EVENTS_BATCH_INVALID')
		if (!batch.length) return
		const params: unknown[] = []
		const values = batch.map((record) => {
			const offset = params.length
			params.push(record.envelope.id, encodeEnvelope(record), new Date(record.availableAt).toISOString(), new Date(record.createdAt).toISOString())
			return `($${offset + 1},$${offset + 2}::jsonb,'queued',0,NULL,$${offset + 3},NULL,NULL,NULL,$${offset + 4},$${offset + 4},'[]'::jsonb)`
		})
		const result = await client<{event_id: string}>(`INSERT INTO ${outbox} (event_id,envelope_json,status,attempts,last_error,next_attempt_at,processing_started_at,processing_by,dispatched_at,created_at,updated_at,attempts_log_json)
			VALUES ${values.join(',')}
			ON CONFLICT (event_id) DO UPDATE SET event_id=EXCLUDED.event_id
			WHERE ${outbox}.envelope_json=EXCLUDED.envelope_json RETURNING event_id`, params)
		if ((result.rowCount ?? result.rows.length) !== batch.length) throw new Error('EVENTS_IDEMPOTENCY_CONFLICT')
	}
	const backend: EventsBackend = {
		durability: 'durable',
		compatibility: {async check() {
			try {
				const tables = await query<{outbox: string | null; inbox: string | null}>(
					'SELECT to_regclass($1) outbox, to_regclass($2) inbox',
					[outbox, inbox]
				)
				if (!tables.rows[0]?.outbox || !tables.rows[0]?.inbox) {
					return {compatible: false as const, code: 'EVENTS_SCHEMA_INCOMPATIBLE'}
				}
				const columns = await query<{table_name: string; column_name: string; udt_name: string}>(
					'SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])',
					[[outbox, inbox]]
				)
				const values = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.udt_name]))
				const required = new Map<string, string>([
					[`${outbox}.event_id`, 'text'], [`${outbox}.envelope_json`, 'jsonb'], [`${outbox}.status`, 'text'],
					[`${outbox}.attempts`, 'int4'], [`${outbox}.last_error`, 'text'], [`${outbox}.next_attempt_at`, 'timestamptz'],
					[`${outbox}.processing_started_at`, 'timestamptz'], [`${outbox}.processing_by`, 'text'],
					[`${outbox}.dispatched_at`, 'timestamptz'], [`${outbox}.created_at`, 'timestamptz'],
					[`${outbox}.updated_at`, 'timestamptz'], [`${outbox}.attempts_log_json`, 'jsonb'],
					[`${inbox}.consumer`, 'text'], [`${inbox}.event_id`, 'text'], [`${inbox}.record_json`, 'jsonb']
				])
				if (![...required].every(([column, type]) => values.get(column) === type)) {
					return {compatible: false as const, code: 'EVENTS_SCHEMA_INCOMPATIBLE'}
				}
				const constraints = await query<{table_name: string; constraint_type: string; column_name: string; ordinal_position: number}>(
					`SELECT tc.table_name,tc.constraint_type,kcu.column_name,kcu.ordinal_position
					FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu
					ON tc.constraint_schema=kcu.constraint_schema AND tc.constraint_name=kcu.constraint_name
					WHERE tc.table_schema=current_schema() AND tc.table_name=ANY($1::text[])`,
					[[outbox, inbox]]
				)
				const primaryKey = (table: string): string => constraints.rows
					.filter((row) => row.table_name === table && row.constraint_type === 'PRIMARY KEY')
					.sort((a, b) => a.ordinal_position - b.ordinal_position)
					.map((row) => row.column_name).join(',')
				const indexes = await query<{tablename: string; indexdef: string}>(
					'SELECT tablename,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=$1',
					[outbox]
				)
				const normalizedIndexes = indexes.rows.map((row) => row.indexdef.toLowerCase())
				const dueIndex = normalizedIndexes.some((value) => value.includes('(status, next_attempt_at)'))
				const processingIndex = normalizedIndexes.some((value) => value.includes('(status, processing_started_at)'))
				return primaryKey(outbox) === 'event_id' && primaryKey(inbox) === 'consumer,event_id' && dueIndex && processingIndex
					? {compatible: true as const}
					: {compatible: false as const, code: 'EVENTS_SCHEMA_INCOMPATIBLE'}
			}
			catch(error) { isolateUnexpectedThenable(error); return {compatible: false as const, code: 'EVENTS_SCHEMA_CHECK_FAILED'} }
		}},
		outbox: {
			append: (batch) => appendWith(query, batch),
			async claimDue({now, limit, owner, leaseMs}) { const result = await query<Row>(`WITH due AS (SELECT event_id FROM ${outbox} WHERE ((status IN ('queued','failed') AND COALESCE(next_attempt_at,created_at)<=to_timestamp($1/1000.0)) OR (status='dispatching' AND (processing_started_at IS NULL OR processing_started_at<to_timestamp($1/1000.0)))) AND (${liveEnvelope}) ORDER BY COALESCE(next_attempt_at,created_at) FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE ${outbox} o SET status='dispatching',attempts=CASE WHEN o.attempts>=1000000 THEN 1000000 ELSE o.attempts+1 END,processing_started_at=to_timestamp(($1+$4)/1000.0),processing_by=$3,updated_at=to_timestamp($1/1000.0) FROM due WHERE o.event_id=due.event_id RETURNING o.*`, [now, Math.min(1_000, limit), owner, leaseMs]); return result.rows.map((row) => { try { return decode(row) } catch(error) { isolateUnexpectedThenable(error); return poison(row) } }) },
			async renew(eventId, owner, generation, expiresAt) { const result = await query(`UPDATE ${outbox} SET processing_started_at=to_timestamp($4/1000.0),updated_at=now() WHERE event_id=$1 AND processing_by=$2 AND attempts=$3 AND status='dispatching'`, [eventId, owner, generation, expiresAt]); return (result.rowCount ?? 0) === 1 },
			async complete(eventId, owner, generation) { const result = await query(`UPDATE ${outbox} SET status='dispatched',processing_by=NULL,processing_started_at=NULL,dispatched_at=now(),updated_at=now(),last_error=NULL WHERE event_id=$1 AND processing_by=$2 AND attempts=$3 AND status='dispatching'`, [eventId, owner, generation]); return (result.rowCount ?? 0) === 1 },
			async retry(eventId, owner, generation, availableAt, code) { const result = await query(`UPDATE ${outbox} SET status='failed',processing_by=NULL,processing_started_at=NULL,next_attempt_at=to_timestamp($4/1000.0),last_error=$5,updated_at=now() WHERE event_id=$1 AND processing_by=$2 AND attempts=$3`, [eventId, owner, generation, availableAt, code]); return (result.rowCount ?? 0) === 1 },
			async deadLetter(eventId, owner, generation, code) { const result = await query(`UPDATE ${outbox} SET status='dead',processing_by=NULL,processing_started_at=NULL,last_error=$4,updated_at=now() WHERE event_id=$1 AND processing_by=$2 AND attempts=$3`, [eventId, owner, generation, code]); return (result.rowCount ?? 0) === 1 },
			async purgeExpired(now, limit) { const result = await query<{count: string}>(`WITH expired AS (SELECT event_id FROM ${outbox} WHERE ${expiredEnvelope} AND (status<>'dispatching' OR processing_started_at IS NULL OR processing_started_at<=to_timestamp($1/1000.0)) LIMIT $2 FOR UPDATE SKIP LOCKED), deleted AS (DELETE FROM ${outbox} WHERE event_id IN (SELECT event_id FROM expired) RETURNING event_id), cleaned AS (DELETE FROM ${inbox} WHERE event_id IN (SELECT event_id FROM deleted)) SELECT count(*)::text count FROM deleted`, [now, limit]); const count = Number(result.rows[0]?.count ?? 0); if (!Number.isSafeInteger(count) || count < 0 || count > limit) throw new Error('EVENTS_POSTGRES_RESULT_INVALID'); return count },
			async queuedCount() { const result = await query<{count: string}>(`SELECT count(*)::text count FROM ${outbox} WHERE status IN ('queued','failed','dispatching')`); return Number(result.rows[0]?.count ?? 0) }
		},
		inbox: {
			async claim({consumer, eventId, owner, expiresAt, now}) { const result = await query<{record_json: Record<string, unknown>}>(`INSERT INTO ${inbox}(consumer,event_id,record_json) VALUES ($1,$2,jsonb_build_object('owner',$3::text,'expiresAt',$4::bigint,'complete',false)) ON CONFLICT(consumer,event_id) DO UPDATE SET record_json=EXCLUDED.record_json WHERE ${inbox}.record_json->>'complete' IS DISTINCT FROM 'true' AND CASE WHEN COALESCE(${inbox}.record_json->>'expiresAt','') ~ '^-?[0-9]{1,16}$' THEN (${inbox}.record_json->>'expiresAt')::numeric<=$5 ELSE true END RETURNING record_json`, [consumer, eventId, owner, expiresAt, now ?? Date.now()]); if (!result.rows[0]) { const existing = await query<{complete: boolean}>(`SELECT record_json->>'complete'='true' complete FROM ${inbox} WHERE consumer=$1 AND event_id=$2`, [consumer, eventId]); return existing.rows[0]?.complete ? 'duplicate' : 'busy' } return 'claimed' },
			async renew({consumer, eventId, owner, expiresAt}) { const result = await query(`UPDATE ${inbox} SET record_json=jsonb_set(record_json,'{expiresAt}',to_jsonb($4::bigint)) WHERE consumer=$1 AND event_id=$2 AND record_json->>'owner'=$3 AND record_json->>'complete' IS DISTINCT FROM 'true'`, [consumer, eventId, owner, expiresAt]); return (result.rowCount ?? 0) === 1 },
			async complete({consumer, eventId, owner}) { const result = await query(`UPDATE ${inbox} SET record_json=record_json||'{"complete":true}'::jsonb WHERE consumer=$1 AND event_id=$2 AND record_json->>'owner'=$3`, [consumer, eventId, owner]); return (result.rowCount ?? 0) === 1 },
			async release({consumer, eventId, owner}) { const result = await query(`DELETE FROM ${inbox} WHERE consumer=$1 AND event_id=$2 AND record_json->>'owner'=$3 AND record_json->>'complete' IS DISTINCT FROM 'true'`, [consumer, eventId, owner]); return (result.rowCount ?? 0) === 1 }
		},
		transactional: {async appendTransactional(transaction, records) { const txQuery = captureQuery(transaction as PgQueryable); await appendWith(txQuery, records) }},
		admin: {
			async replay(request: EventReplayRequest, now: number) { const clauses = ['status IN (\'dead\',\'dispatched\',\'cancelled\')']; const maximum = boundedLimit(request.limit); const params: unknown[] = [now, maximum]; if (request.eventId) { params.push(request.eventId); clauses.push(`event_id=$${params.length}`) } if (request.type) { params.push(request.type); clauses.push(`envelope_json->>'type'=$${params.length}`) } if (request.from) { params.push(request.from); clauses.push(`created_at>=$${params.length}::timestamptz`) } if (request.to) { params.push(request.to); clauses.push(`created_at<=$${params.length}::timestamptz`) } const result = await query<{count: string}>(`WITH selected AS (SELECT event_id FROM ${outbox} WHERE ${clauses.join(' AND ')} LIMIT $2), replayed AS (UPDATE ${outbox} SET status='queued',attempts=0,last_error=NULL,next_attempt_at=to_timestamp($1/1000.0),processing_by=NULL,processing_started_at=NULL,updated_at=now() WHERE event_id IN (SELECT event_id FROM selected) RETURNING event_id), cleaned AS (DELETE FROM ${inbox} WHERE event_id IN (SELECT event_id FROM replayed)) SELECT count(*)::text count FROM replayed`, params); const count = Number(result.rows[0]?.count ?? 0); if (!Number.isSafeInteger(count) || count < 0 || count > maximum) throw new Error('EVENTS_POSTGRES_RESULT_INVALID'); return count },
			async retryDeadLetter(id, now) { const result = await query(`UPDATE ${outbox} SET status='queued',attempts=0,last_error=NULL,next_attempt_at=to_timestamp($2/1000.0),updated_at=now() WHERE event_id=$1 AND status='dead'`, [id, now]); return (result.rowCount ?? 0) === 1 },
			async cancelScheduled(id) { const result = await query(`UPDATE ${outbox} SET status='cancelled',updated_at=now() WHERE event_id=$1 AND status IN ('queued','failed')`, [id]); return (result.rowCount ?? 0) === 1 },
			async listOutbox(options) { const result = await query<Row>(`SELECT * FROM ${outbox} WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR envelope_json->>'type'=$2) ORDER BY updated_at DESC LIMIT $3`, [options?.status ?? null, options?.type ?? null, boundedLimit(options?.limit)]); return Object.freeze(result.rows.map(summary)) },
			async listDeadLetters(limit = 100): Promise<readonly EventDeadLetterSummary[]> { const result = await query<Row>(`SELECT * FROM ${outbox} WHERE status='dead' ORDER BY updated_at DESC LIMIT $1`, [boundedLimit(limit)]); return Object.freeze(result.rows.map((row) => Object.freeze({eventId:row.event_id, type:eventType(row), attempts:row.attempts, failedAt:new Date(timestamp(row.updated_at)).toISOString(), failureCode:sanitizeFailureCode(row.last_error) ?? 'EVENTS_DELIVERY_FAILURE'}))) },
			async purgeExpired(now, limit) { return backend.outbox.purgeExpired(now, limit) }
		}
	}
	return backend
}
