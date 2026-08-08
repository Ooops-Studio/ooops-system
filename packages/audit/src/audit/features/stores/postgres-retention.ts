import type {AuditRecord} from '@ooopsstudio/core/contracts/audit'

import {AUDIT_PRUNE_MAX_BYTES, AUDIT_PRUNE_MAX_SCANNED_PARTITIONS} from '../../constants'
import {groupAuditRecords, sha256Stable, verifyAuditRecords} from '../../core/integrity'
import type {AuditPrunePlan} from '../../types/store'
import {assertAuditIsoTimestamp, assertAuditPruneLimit, compareAuditText} from '../../utils/validation'

import {
	AUDIT_PRUNED_PARTITION_PREFIX,
	acquirePgAdvisoryLocks,
	ensurePgDurableTransaction,
	type PgPoolLike,
	type PgQueryable,
	type PostgresAuditTables,
	auditRowProjection,
	auditRowGuard,
	auditPgFields,
	parseAuditRow,
	parsePgSafeInteger,
	snapshotPgObject,
	snapshotPgRowCount,
	snapshotPgRows,
	type StoredAuditRow,
	withRepeatableReadTransaction,
	withTransaction
} from './postgres-support'

export interface PostgresRetentionContext {
	readonly client: PgPoolLike
	readonly tables: PostgresAuditTables
	readonly verifyTransaction?: (transaction: PgQueryable) => Promise<void>
	/** Internal test/custom-store seam; the production store uses the lazy default loader. */
	readonly loadPartitionsFrom?: (
		queryable: PgQueryable,
		partitionKeys: ReadonlyArray<string>
	) => Promise<ReadonlyArray<AuditRecord>>
}

const retentionCandidateFields = new Set(['partition_key', 'record_count', 'record_bytes'])
const retentionIdempotencyFields = new Set(['idempotency_hash'])

function anchorsFor(groups: ReadonlyMap<string, ReadonlyArray<AuditRecord>>, partitionKeys: ReadonlyArray<string>) {
	return partitionKeys.map((partitionKey) => {
		const group = groups.get(partitionKey) ?? []
		const first = group[0]
		const last = group.at(-1)
		if (!first || !last) throw new Error('Audit incomplete prune partition.')
		return {
			partitionKey, count: group.length, firstRecordId: first.id, firstHash: first.integrity.hash,
			lastRecordId: last.id, lastHash: last.integrity.hash
		}
	})
}

export function createPostgresRetention(context: PostgresRetentionContext) {
	const defaultLoadPartitionsFrom = async(
		queryable: PgQueryable,
		partitionKeys: ReadonlyArray<string>
	): Promise<ReadonlyArray<AuditRecord>> => {
		if (!partitionKeys.length) return []
		const result = await queryable.query<StoredAuditRow>(
			`SELECT ${auditRowProjection} FROM ${context.tables.records} AS audit_record
			${auditRowGuard}
			WHERE audit_record.partition_key = ANY($1::text[])
			AND(SELECT count(*)<=10000 AND sum(octet_length(row_to_json(audit_fields)::text))<=33554432
				FROM ${context.tables.records} r CROSS JOIN LATERAL(SELECT ${auditPgFields('r')})audit_fields
				WHERE r.partition_key=ANY($1::text[]))
			ORDER BY audit_record.partition_key COLLATE "C" ASC, audit_record.sequence ASC`,
			[partitionKeys]
		)
		return snapshotPgRows<StoredAuditRow>(result, 10_000, 'retention records').map((row) => parseAuditRow(row))
	}
	const loadPartitionsFrom = context.loadPartitionsFrom ?? defaultLoadPartitionsFrom
	const planPruneBefore = async(before: string, limit: number): Promise<AuditPrunePlan> => await withRepeatableReadTransaction(
		context.client,
		async(tx) => {
			if (typeof before !== 'string') throw new Error('Audit prune before required.')
			assertAuditIsoTimestamp(before, 'before'); assertAuditPruneLimit(limit)
			const partitionKeys: string[] = []; let selected = 0; let selectedBytes = 0; let lastPartition = ''; let scanned = 0
			while (scanned < AUDIT_PRUNE_MAX_SCANNED_PARTITIONS) {
				const pageLimit = Math.min(500, AUDIT_PRUNE_MAX_SCANNED_PARTITIONS - scanned)
				const candidates = await tx.query<{partition_key: string; record_count: string | number; record_bytes: string | number}>(
					`SELECT CASE WHEN octet_length(r.partition_key)<=512 THEN r.partition_key END AS partition_key,
					count(*)::text AS record_count, sum(octet_length(row_to_json(audit_fields)::text))::text AS record_bytes
				FROM ${context.tables.records} r CROSS JOIN LATERAL(SELECT ${auditPgFields('r')})audit_fields
					WHERE r.partition_key COLLATE "C" > $2::text COLLATE "C"
				GROUP BY r.partition_key
				HAVING max(r.occurred_at) < $1::timestamptz
					AND count(*) <= $4::bigint
					AND sum(octet_length(row_to_json(audit_fields)::text)) <= $5::bigint
					ORDER BY r.partition_key COLLATE "C" ASC LIMIT $3`,
					[before, lastPartition, pageLimit, limit, AUDIT_PRUNE_MAX_BYTES]
				)
				const candidateRows = snapshotPgRows<{
					partition_key: string; record_count: string | number; record_bytes: string | number
				}>(candidates, pageLimit, 'retention candidates')
				if (!candidateRows.length) break
				for (const rawRow of candidateRows) {
					const row = snapshotPgObject(rawRow, retentionCandidateFields, 'retention candidate row')
					const partitionKey = row.partition_key
					if (typeof partitionKey !== 'string' || !partitionKey || partitionKey !== partitionKey.trim()
						|| partitionKey.length > 512 || compareAuditText(partitionKey, lastPartition) <= 0) {
						throw new Error('Audit invalid prune partition key.')
					}
					lastPartition = partitionKey
					const count = parsePgSafeInteger(row.record_count, 'record count', 1)
					const recordBytes = parsePgSafeInteger(row.record_bytes, 'record bytes', 1)
					if (count > limit || selected + count > limit || recordBytes > AUDIT_PRUNE_MAX_BYTES
					|| selectedBytes + recordBytes > AUDIT_PRUNE_MAX_BYTES) continue
					partitionKeys.push(partitionKey); selected += count; selectedBytes += recordBytes
				}
				scanned += candidateRows.length
				if (candidateRows.length < pageLimit || selected >= limit) break
			}
			const records = await loadPartitionsFrom(tx, partitionKeys)
			if (records.length > limit) throw new Error('Audit prune limit exceeded.')
			const anchors = anchorsFor(groupAuditRecords(records), partitionKeys)
			return {planId: sha256Stable({before, anchors}), before, partitionKeys, records, anchors}
		},
		context.verifyTransaction
	)

	const prunePlanned = async(plan: AuditPrunePlan) => await withTransaction(context.client, async(tx) => {
		await ensurePgDurableTransaction(tx)
		if (plan.planId !== sha256Stable({before: plan.before, anchors: plan.anchors})) throw new Error('Audit invalid plan id.')
		const recordIds = plan.records.map((record) => record.id)
		const idempotencyHashes = recordIds.length
			? snapshotPgRows<{idempotency_hash: string}>(await tx.query(
				`SELECT idempotency_hash FROM ${context.tables.records}
				WHERE id = ANY($1::text[]) AND idempotency_hash IS NOT NULL
				ORDER BY idempotency_hash COLLATE "C" ASC`,
				[recordIds]
			), recordIds.length, 'retention idempotency hashes').map((rawRow) => {
				const row = snapshotPgObject(rawRow, retentionIdempotencyFields, 'retention idempotency hash row')
				if (typeof row.idempotency_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.idempotency_hash)) {
					throw new Error('Audit invalid hash.')
				}
				return row.idempotency_hash
			})
			: []
		await acquirePgAdvisoryLocks(tx, 'idempotency', idempotencyHashes)
		const keys = [...new Set(plan.partitionKeys)].sort(compareAuditText)
		await acquirePgAdvisoryLocks(tx, 'partition', keys)
		const current = await loadPartitionsFrom(tx, keys)
		const currentGroups = groupAuditRecords(current)
		const currentIntegrity = verifyAuditRecords(current)
		if (!currentIntegrity.ok || currentIntegrity.checkedCount !== current.length) {
			throw new Error('Audit invalid prune chain.')
		}
		const currentAnchors = anchorsFor(currentGroups, keys)
		if (sha256Stable(currentAnchors) !== sha256Stable(plan.anchors)) throw new Error('Audit stale plan.')
		const byPartitionAndSequence = (a: AuditRecord, b: AuditRecord) =>
			compareAuditText(a.integrity.partitionKey, b.integrity.partitionKey) || a.integrity.sequence - b.integrity.sequence
		const plannedRecords = [...plan.records].sort(byPartitionAndSequence)
		const currentRecords = [...current].sort(byPartitionAndSequence)
		if (plannedRecords.length !== currentRecords.length || plannedRecords.some((record, index) =>
			record.id !== currentRecords[index]?.id || record.integrity.hash !== currentRecords[index]?.integrity.hash)) {
			throw new Error('Audit records mismatch.')
		}
		if (!plan.records.length) return {deletedCount: 0}
		const recordIdHashes = recordIds.map((id) => sha256Stable({id}))
		const reserved = await tx.query(`INSERT INTO ${context.tables.tombstones} (record_id_hash, idempotency_hash, semantic_fingerprint)
			SELECT requested.record_id_hash, records.idempotency_hash, records.semantic_fingerprint
			FROM unnest($1::text[], $2::text[]) AS requested(record_id, record_id_hash)
			JOIN ${context.tables.records} records ON records.id = requested.record_id`, [recordIds, recordIdHashes])
		const reservedCount = snapshotPgRowCount(reserved, 'prune tombstone row count')
		if (reservedCount !== recordIds.length) throw new Error('Audit reservation mismatch.')
		const tails = keys.map((partitionKey) => currentGroups.get(partitionKey)!.at(-1)!)
		const sealIds = tails.map((record) => `${AUDIT_PRUNED_PARTITION_PREFIX}${sha256Stable({id: record.id})}`)
		const sealed = await tx.query(`UPDATE ${context.tables.heads} AS head
			SET last_record_id = expected.seal_id, updated_at = now()
			FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[])
				AS expected(partition_key, last_sequence, last_hash, last_record_id, seal_id)
			WHERE head.partition_key = expected.partition_key
				AND head.last_sequence = expected.last_sequence
				AND head.last_hash = expected.last_hash
				AND head.last_record_id = expected.last_record_id`, [
			keys,
			tails.map((record) => record.integrity.sequence),
			tails.map((record) => record.integrity.hash),
			tails.map((record) => record.id),
			sealIds
		])
		const sealedCount = snapshotPgRowCount(sealed, 'prune chain head row count')
		if (sealedCount !== keys.length) throw new Error('Audit head mismatch.')
		const deleted = await tx.query(`DELETE FROM ${context.tables.records} WHERE id = ANY($1::text[])`, [recordIds])
		const deletedCount = snapshotPgRowCount(deleted, 'prune delete row count')
		if (deletedCount !== recordIds.length) throw new Error('Audit deletion mismatch.')
		return {deletedCount}
	}, context.verifyTransaction)

	return {planPruneBefore, prunePlanned}
}
