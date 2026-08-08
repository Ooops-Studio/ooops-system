import type {AuditVerificationFilter, AuditVerificationResult} from '@ooopsstudio/core/contracts/audit'

import {AUDIT_POSTGRES_RECORD_PAGE_SIZE, AUDIT_QUERY_PAGE_SIZE} from '../../constants'
import {buildAuditScopeIdentity, resolveAuditScope, verifyAuditRecords} from '../../core/integrity'
import {isAuditSafeString} from '../../utils/string-safety'
import {assertAuditIsoTimestamp, compareAuditText} from '../../utils/validation'

import type {PostgresAuditQueryContext} from './postgres-query'
import {
	AUDIT_PRUNED_PARTITION_PREFIX,
	auditRowProjection,
	auditRowGuard,
	boundedAuditPgRow,
	boundedHeadPgRow,
	parseAuditRow,
	parsePgSafeInteger,
	snapshotPgObject,
	snapshotPgRows,
	type StoredAuditRow
} from './postgres-support'

const verificationHeadFields = new Set(['partition_key', 'last_sequence', 'last_hash', 'last_record_id'])

interface VerificationContext extends PostgresAuditQueryContext {
	readonly headsTable: string
	readonly tombstonesTable: string
}

interface VerificationHead {
	readonly partitionKey: string
	readonly sequence: number
	readonly hash: string
	readonly recordId: string
	readonly sealed: boolean
	readonly sealRecordIdHash?: string
}

function snapshotHead(value: unknown, previous: string): VerificationHead {
	const row = snapshotPgObject(value, verificationHeadFields, 'verification head row')
	const partitionKey = row.partition_key
	const hash = row.last_hash
	const recordId = row.last_record_id
	if (typeof partitionKey !== 'string' || !partitionKey || partitionKey !== partitionKey.trim()
		|| partitionKey.length > 512 || !isAuditSafeString(partitionKey) || compareAuditText(partitionKey, previous) <= 0
		|| typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)
		|| typeof recordId !== 'string' || !recordId || recordId !== recordId.trim()
		|| recordId.length > 512 || !isAuditSafeString(recordId)) {
		throw new Error('Audit invalid chain head.')
	}
	const sealMatch = new RegExp(`^${AUDIT_PRUNED_PARTITION_PREFIX}([a-f0-9]{64})$`).exec(recordId)
	return {
		partitionKey,
		sequence: parsePgSafeInteger(row.last_sequence, 'verification head sequence', 1),
		hash,
		recordId,
		sealed: recordId === '__audit_pruned_partition__' || sealMatch !== null,
		...(sealMatch?.[1] ? {sealRecordIdHash: sealMatch[1]} : {})
	}
}

export async function verifyPostgresAuditIntegrity(
	context: VerificationContext,
	filter?: AuditVerificationFilter
): Promise<AuditVerificationResult> {
	assertAuditIsoTimestamp(filter?.from, 'filter.from')
	assertAuditIsoTimestamp(filter?.to, 'filter.to')
	const orphanParams: unknown[] = []
	const orphanClauses = [
		`NOT EXISTS (SELECT 1 FROM ${context.headsTable} h WHERE h.partition_key = r.partition_key)`
	]
	if (filter?.partitionKey) {
		orphanParams.push(filter.partitionKey)
		orphanClauses.push(`r.partition_key = $${orphanParams.length}`)
	}
	if (filter?.from) {
		orphanParams.push(filter.from)
		orphanClauses.push(`r.occurred_at >= $${orphanParams.length}::timestamptz`)
	}
	if (filter?.to) {
		orphanParams.push(filter.to)
		orphanClauses.push(`r.occurred_at <= $${orphanParams.length}::timestamptz`)
	}
	const orphanResult = await context.query<{
		partition_key: unknown
		sequence: unknown
		id: unknown
	}>(
		`SELECT bounded_record.partition_key COLLATE "C" AS partition_key,
		bounded_record.sequence::text AS sequence, bounded_record.id
		FROM ${context.recordsTable} r
		${boundedAuditPgRow('r', 'bounded_record')}
		WHERE ${orphanClauses.join(' AND ')}
		ORDER BY r.partition_key COLLATE "C" ASC, r.sequence ASC LIMIT 1`,
		orphanParams
	)
	const rawOrphan = snapshotPgRows<{
		partition_key: unknown
		sequence: unknown
		id: unknown
	}>(orphanResult, 1, 'orphan verification rows')[0]
	if (rawOrphan) {
		const orphan = snapshotPgObject(
			rawOrphan,
			new Set(['partition_key', 'sequence', 'id']),
			'orphan verification row'
		)
		if (typeof orphan.partition_key !== 'string' || !orphan.partition_key
			|| orphan.partition_key !== orphan.partition_key.trim() || orphan.partition_key.length > 512
			|| !isAuditSafeString(orphan.partition_key) || typeof orphan.id !== 'string' || !orphan.id
			|| orphan.id !== orphan.id.trim() || orphan.id.length > 512 || !isAuditSafeString(orphan.id)) {
			throw new Error('Audit invalid orphan row.')
		}
		const brokenAtSequence = parsePgSafeInteger(orphan.sequence, 'orphan verification sequence', 1)
		return {
			ok: false,
			checkedCount: 0,
			partitionKey: orphan.partition_key,
			brokenAtRecordId: orphan.id,
			brokenAtSequence,
			affectedRecordIds: [orphan.id]
		}
	}
	let checkedCount = 0
	let lastPartition = ''
	for (;;) {
		const partitionParams: unknown[] = []
		const partitionClauses: string[] = []
		if (filter?.partitionKey) {
			partitionParams.push(filter.partitionKey)
			partitionClauses.push(`h.partition_key = $${partitionParams.length}`)
		}
		const recordClauses = ['r.partition_key = h.partition_key']
		if (filter?.from) {
			partitionParams.push(filter.from)
			recordClauses.push(`r.occurred_at >= $${partitionParams.length}::timestamptz`)
		}
		if (filter?.to) {
			partitionParams.push(filter.to)
			recordClauses.push(`r.occurred_at <= $${partitionParams.length}::timestamptz`)
		}
		if (filter?.from || filter?.to) partitionClauses.push(
			`(EXISTS(SELECT 1 FROM ${context.recordsTable} r WHERE ${recordClauses.join(' AND ')})
			OR NOT EXISTS(SELECT FROM ${context.recordsTable} e WHERE e.partition_key=h.partition_key))`
		)
		if (lastPartition) {
			partitionParams.push(lastPartition)
			partitionClauses.push(`h.partition_key COLLATE "C" > $${partitionParams.length}::text COLLATE "C"`)
		}
		partitionParams.push(AUDIT_QUERY_PAGE_SIZE)
		const partitions = await context.query<{
			partition_key: string
			last_sequence: string | number
			last_hash: string
			last_record_id: string
		}>(
			`SELECT bounded_head.partition_key COLLATE "C" AS partition_key,
				bounded_head.last_sequence::text AS last_sequence, bounded_head.last_hash, bounded_head.last_record_id
			FROM ${context.headsTable} h
			${boundedHeadPgRow('h', 'bounded_head')}
			${partitionClauses.length > 0 ? `WHERE ${partitionClauses.join(' AND ')}` : ''}
			ORDER BY h.partition_key COLLATE "C" ASC LIMIT $${partitionParams.length}`,
			partitionParams
		)
		const partitionRows = snapshotPgRows<{
			partition_key: string
			last_sequence: string | number
			last_hash: string
			last_record_id: string
		}>(partitions, AUDIT_QUERY_PAGE_SIZE, 'verification partitions')
		if (!partitionRows.length) break
		const heads: VerificationHead[] = []
		for (const row of partitionRows) heads.push(snapshotHead(row, heads.at(-1)?.partitionKey ?? lastPartition))
		for (const head of heads) {
			const partitionKey = head.partitionKey
			let sequence = 0
			let anchor: {sequence: number; hash: string | null; scopeIdentity?: string} = {sequence: 0, hash: null}
			let tail: StoredAuditRow | undefined
			for (;;) {
				const page = await context.query<StoredAuditRow>(
					`SELECT ${auditRowProjection} FROM ${context.recordsTable} AS audit_record
					${auditRowGuard}
					WHERE audit_record.partition_key = $1 AND audit_record.sequence > $2
					ORDER BY audit_record.sequence ASC LIMIT $3`,
					[partitionKey, sequence, AUDIT_POSTGRES_RECORD_PAGE_SIZE]
				)
				const pageRows = snapshotPgRows<StoredAuditRow>(page, AUDIT_POSTGRES_RECORD_PAGE_SIZE, 'verification rows')
				if (!pageRows.length) break
				tail = pageRows.at(-1)
				const records = pageRows.map((row) => parseAuditRow(row, {allowInvalidIntegrity: true}))
				const result = verifyAuditRecords(records, {
					anchors: new Map([[partitionKey, anchor]])
				})
				checkedCount += result.checkedCount
				if (!result.ok) return {...result, checkedCount}
				const recordTail = records.at(-1)!
				anchor = {
					sequence: recordTail.integrity.sequence,
					hash: recordTail.integrity.hash,
					scopeIdentity: buildAuditScopeIdentity(resolveAuditScope(recordTail))
				}
				sequence = recordTail.integrity.sequence
				if (records.length < AUDIT_POSTGRES_RECORD_PAGE_SIZE) break
			}
			const tailRecord = tail ? parseAuditRow(tail, {allowInvalidIntegrity: true}) : undefined
			if (head.sealed) {
				if (tailRecord) return {
					ok: false, checkedCount, partitionKey,
					brokenAtRecordId: tailRecord.id,
					brokenAtSequence: tailRecord.integrity.sequence,
					affectedRecordIds: [tailRecord.id]
				}
				if (head.sealRecordIdHash) {
					const tombstoneResult = await context.query<{record_id_hash: unknown}>(
						`SELECT record_id_hash FROM ${context.tombstonesTable} WHERE record_id_hash = $1 LIMIT 1`,
						[head.sealRecordIdHash]
					)
					const rawTombstone = snapshotPgRows<{record_id_hash: unknown}>(
						tombstoneResult, 1, 'seal tombstone rows'
					)[0]
					if (rawTombstone) {
						const tombstone = snapshotPgObject(
							rawTombstone,
							new Set(['record_id_hash']),
							'seal tombstone row'
						)
						if (tombstone.record_id_hash !== head.sealRecordIdHash) {
							throw new Error('Audit invalid tombstone.')
						}
						continue
					}
				}
				return {
					ok: false, checkedCount, partitionKey,
					brokenAtRecordId: head.recordId,
					brokenAtSequence: head.sequence,
					affectedRecordIds: [head.recordId]
				}
			}
			if (!tailRecord || tailRecord.id !== head.recordId || tailRecord.integrity.sequence !== head.sequence
				|| tailRecord.integrity.hash !== head.hash) {
				return {
					ok: false,
					checkedCount,
					partitionKey,
					brokenAtRecordId: head.recordId,
					brokenAtSequence: head.sequence,
					affectedRecordIds: [head.recordId]
				}
			}
		}
		lastPartition = heads.at(-1)!.partitionKey
		if (filter?.partitionKey || partitionRows.length < AUDIT_QUERY_PAGE_SIZE) break
	}
	return {
		ok: true,
		checkedCount,
		...(filter?.partitionKey ? {partitionKey: filter.partitionKey} : {}),
		affectedRecordIds: []
	}
}
