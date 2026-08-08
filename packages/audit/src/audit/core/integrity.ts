import {createHash} from 'node:crypto'

import type {AuditActor, AuditIntegrity, AuditRecord, AuditTarget, AuditVerificationResult} from '@ooopsstudio/core/contracts/audit'
import {createStableHasher} from '@ooopsstudio/core/utils/hashing/stable-hash'

import {AUDIT_MAX_FUTURE_SKEW_MS} from '../constants'
import type {PreparedAuditRecord} from '../types/store'
import {compareAuditText} from '../utils/validation'

const stable = createStableHasher()
const algorithm = 'sha256-stable-json-v1' as const

export function sha256Stable(value: unknown): string {
	return createHash('sha256').update(stable.stringify(value)).digest('hex')
}

export function buildAuditPartitionKey(record: {
	tenantId?: string
	workspaceId?: string
	stream?: string
	category: string
	occurredAt: string
}): string {
	const scope = record.tenantId
		? `tenant=${encodeURIComponent(record.tenantId)}`
		: record.workspaceId
			? `workspace=${encodeURIComponent(record.workspaceId)}`
			: 'global'
	const stream = encodeURIComponent(record.stream ?? record.category)
	const date = record.occurredAt.slice(0, record.occurredAt.indexOf('T'))
	return `${scope}:${stream}:${date}`
}

function buildLegacyAuditPartitionKey(record: {
	tenantId?: string
	workspaceId?: string
	stream?: string
	category: string
	occurredAt: string
}): string {
	const scope = encodeURIComponent(record.tenantId ?? record.workspaceId ?? 'global')
	const stream = encodeURIComponent(record.stream ?? record.category)
	const date = record.occurredAt.slice(0, record.occurredAt.indexOf('T'))
	return `${scope}:${stream}:${date}`
}

export function matchesAuditPartitionKey(
	record: Parameters<typeof buildAuditPartitionKey>[0],
	partitionKey: string
): boolean {
	return partitionKey === buildAuditPartitionKey(record) || partitionKey === buildLegacyAuditPartitionKey(record)
}

export function resolveAuditScope(record: {
	readonly tenantId?: string
	readonly workspaceId?: string
	readonly actor: Pick<AuditActor, 'tenantId' | 'workspaceId'>
	readonly targets: ReadonlyArray<Pick<AuditTarget, 'tenantId' | 'workspaceId'>>
}): {tenantId?: string; workspaceId?: string} {
	const resolveField = (field: 'tenantId' | 'workspaceId'): string | undefined => {
		const values = new Set([
			...(record[field] ? [record[field]] : []),
			...(record.actor[field] ? [record.actor[field]] : []),
			...record.targets.flatMap((target) => target[field] ? [target[field]] : [])
		])
		if (values.size > 1) throw new Error(`Audit ${field} scope is invalid because scope sources conflict.`)
		return [...values][0]
	}
	const tenantId = resolveField('tenantId')
	const workspaceId = resolveField('workspaceId')
	return {...(tenantId ? {tenantId} : {}), ...(workspaceId ? {workspaceId} : {})}
}

export function buildAuditScopeIdentity(scope: {readonly tenantId?: string; readonly workspaceId?: string}): string {
	return scope.tenantId
		? `tenant=${scope.tenantId}`
		: scope.workspaceId ? `workspace=${scope.workspaceId}` : 'global'
}

export function groupAuditRecords<T extends Pick<AuditRecord, 'integrity'>>(records: Iterable<T>): Map<string, T[]> {
	const groups = new Map<string, T[]>()
	for (const record of records) {
		const key = record.integrity.partitionKey
		const group = groups.get(key)
		if (group) group.push(record)
		else groups.set(key, [record])
	}
	return groups
}

export function buildAuditIntegrity(
	record: PreparedAuditRecord,
	state: {sequence: number; prevHash: string | null}
): AuditIntegrity {
	const {
		idempotencyHash: _idempotencyHash,
		semanticFingerprint: _semanticFingerprint,
		partitionKey,
		...publicRecord
	} = record as PreparedAuditRecord & {integrity?: AuditIntegrity}
	delete (publicRecord as {integrity?: AuditIntegrity}).integrity
	return {
		partitionKey,
		sequence: state.sequence,
		prevHash: state.prevHash,
		hash: sha256Stable({...publicRecord, partitionKey, sequence: state.sequence, prevHash: state.prevHash, algorithm}),
		algorithm
	}
}

export function verifyAuditRecords(
	records: ReadonlyArray<AuditRecord>,
	options: {
		anchors?: ReadonlyMap<string, {sequence: number; hash: string | null; scopeIdentity?: string}>
		checkedRecordIds?: ReadonlySet<string>
	} = {}
): AuditVerificationResult {
	const ordered = [...records].sort((a, b) =>
		compareAuditText(a.integrity.partitionKey, b.integrity.partitionKey) || a.integrity.sequence - b.integrity.sequence)
	let partition: string | undefined
	let previousHash: string | null = null
	let previousSequence = 0
	let partitionScope: string | undefined
	let checkedCount = 0
	for (const record of ordered) {
		const scope = resolveAuditScope(record)
		const recordScope = buildAuditScopeIdentity(scope)
		if (record.integrity.partitionKey !== partition) {
			partition = record.integrity.partitionKey
			const anchor = options.anchors?.get(partition)
			partitionScope = anchor?.scopeIdentity ?? recordScope
			previousHash = anchor?.hash ?? null
			previousSequence = anchor?.sequence ?? 0
		}
		if (!options.checkedRecordIds || options.checkedRecordIds.has(record.id)) checkedCount += 1
		let expected: AuditIntegrity | undefined
		if (record.integrity.algorithm === algorithm) {
			expected = buildAuditIntegrity({...record, partitionKey: record.integrity.partitionKey}, {
				sequence: record.integrity.sequence,
				prevHash: previousHash
			})
		}
		const partitionInput = {
			...scope,
			...(record.stream ? {stream: record.stream} : {}),
			category: record.category,
			occurredAt: record.occurredAt
		}
		if (!expected || Date.parse(record.occurredAt) > Date.parse(record.createdAt) + AUDIT_MAX_FUTURE_SKEW_MS
			|| partitionScope !== recordScope
			|| !matchesAuditPartitionKey(partitionInput, record.integrity.partitionKey) || record.integrity.prevHash !== previousHash
			|| record.integrity.sequence !== previousSequence + 1 || record.integrity.hash !== expected.hash) {
			return {
				ok: false, checkedCount, partitionKey: partition, brokenAtRecordId: record.id,
				brokenAtSequence: record.integrity.sequence, affectedRecordIds: [record.id]
			}
		}
		previousHash = record.integrity.hash
		previousSequence = record.integrity.sequence
	}
	const partitions = new Set(ordered.map((record) => record.integrity.partitionKey))
	return {
		ok: true,
		checkedCount,
		...(partitions.size === 1 ? {partitionKey: ordered[0]!.integrity.partitionKey} : {}),
		affectedRecordIds: []
	}
}
