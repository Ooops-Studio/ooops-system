import type {AuditPage, AuditQuery, AuditRecord, AuditVerificationFilter} from '@ooopsstudio/core/contracts/audit'

import {AUDIT_PRUNE_MAX_BYTES} from '../../constants'
import {normalizeAuditQuery} from '../../core/handler-support'
import {buildAuditIntegrity, groupAuditRecords, sha256Stable, verifyAuditRecords} from '../../core/integrity'
import type {AdminCapableAuditStore, AuditAppendResult, AuditPrunePlan, PreparedAuditRecord} from '../../types/store'
import {
	assertAuditIsoTimestamp,
	assertAuditPruneLimit,
	assertAuditSort,
	compareAuditText,
	compareAuditCursorValues,
	compareAuditTimestamps,
	decodeAuditCursor,
	resolveAuditQueryLimit,
	type AuditCursorValue
} from '../../utils/validation'

export interface MemoryAuditStoreOptions {readonly maxRecords?: number; readonly maxBytes?: number}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)) }
function cursor(record: AuditRecord): string { return Buffer.from(JSON.stringify({occurredAt: record.occurredAt, id: record.id})).toString('base64url') }
function compare(a: AuditRecord, b: AuditRecord, sort: 'asc' | 'desc'): number {
	return compareAuditCursorValues(a, b) * (sort === 'asc' ? 1 : -1)
}
function after(record: AuditRecord, value: AuditCursorValue | undefined, sort: 'asc' | 'desc'): boolean {
	if (!value) return true
	const comparison = compareAuditCursorValues(record, value)
	return sort === 'asc' ? comparison > 0 : comparison < 0
}
function matches(record: AuditRecord, query: AuditQuery): boolean {
	if (query.eventType && record.eventType !== query.eventType) return false
	if (query.category && record.category !== query.category) return false
	if (query.action && record.action !== query.action) return false
	if (query.from && compareAuditTimestamps(record.occurredAt, query.from) < 0) return false
	if (query.to && compareAuditTimestamps(record.occurredAt, query.to) > 0) return false
	if (query.actorKind && record.actor.kind !== query.actorKind) return false
	if (query.actorId && record.actor.id !== query.actorId) return false
	if (query.workspaceId && record.workspaceId !== query.workspaceId) return false
	if (query.tenantId && record.tenantId !== query.tenantId) return false
	if (query.partitionKey && record.integrity.partitionKey !== query.partitionKey) return false
	const outcomes = Array.isArray(query.outcome) ? query.outcome : query.outcome ? [query.outcome] : undefined
	if (outcomes && !outcomes.includes(record.outcome)) return false
	const sensitivities = Array.isArray(query.sensitivity) ? query.sensitivity : query.sensitivity ? [query.sensitivity] : undefined
	if (sensitivities && !sensitivities.includes(record.sensitivity)) return false
	if ((query.targetEntityType || query.targetEntityId) && !record.targets.some((target) =>
		(!query.targetEntityType || target.entityType === query.targetEntityType)
		&& (!query.targetEntityId || target.entityId === query.targetEntityId))) return false
	return true
}

export function createMemoryAuditStore(options: MemoryAuditStoreOptions = {}): AdminCapableAuditStore {
	if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Audit memory store options are invalid.')
	const descriptors = Object.getOwnPropertyDescriptors(options)
	if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !['maxRecords', 'maxBytes'].includes(key))
		|| Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
		throw new Error('Audit memory store options must contain only readable known fields.')
	}
	const maxRecords = descriptors.maxRecords?.value ?? 10_000
	const maxBytes = descriptors.maxBytes?.value ?? 64 * 1024 * 1024
	if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new Error('Audit memory store limits must be positive safe integers.')
	}
	const records = new Map<string, AuditRecord>()
	const heads = new Map<string, {sequence: number; hash: string}>()
	const idempotency = new Map<string, {id: string; fingerprint: string}>()
	const sealedPartitions = new Set<string>()
	const knownRecordIdHashes = new Set<string>()
	let totalBytes = 0

	const snapshot = () => ({
		records: new Map([...records].map(([id, record]) => [id, clone(record)])),
		heads: new Map([...heads].map(([key, head]) => [key, {...head}])),
		idempotency: new Map([...idempotency].map(([key, entry]) => [key, {...entry}])),
		sealedPartitions: new Set(sealedPartitions),
		knownRecordIdHashes: new Set(knownRecordIdHashes),
		totalBytes
	})
	const insert = (record: PreparedAuditRecord, state: ReturnType<typeof snapshot>): AuditAppendResult => {
		if (record.idempotencyHash) {
			const existing = state.idempotency.get(record.idempotencyHash)
			if (existing) {
				if (existing.fingerprint !== record.semanticFingerprint) throw new Error('Audit idempotency key conflicts with a different request.')
				const stored = state.records.get(existing.id)
				if (!stored) throw new Error('Audit idempotency key belongs to a pruned record and cannot be reused.')
				return {record: clone(stored), inserted: false}
			}
		}
		if (state.sealedPartitions.has(record.partitionKey)) {
			throw new Error('Audit partition was pruned and cannot accept late records.')
		}
		const recordIdHash = sha256Stable({id: record.id})
		if (state.knownRecordIdHashes.has(recordIdHash)) throw new Error('Audit record id already exists or belongs to a pruned record.')
		const head = state.heads.get(record.partitionKey)
		const integrity = buildAuditIntegrity(record, {sequence: (head?.sequence ?? 0) + 1, prevHash: head?.hash ?? null})
		const {idempotencyHash, semanticFingerprint, partitionKey: _partitionKey, ...body} = record
		const stored: AuditRecord = {...body, integrity}
		const size = bytes(stored)
		const addsPartition = !state.heads.has(record.partitionKey)
		const addsIdempotency = Boolean(idempotencyHash && !state.idempotency.has(idempotencyHash))
		if (state.records.size + 1 > maxRecords || state.totalBytes + size > maxBytes
			|| (addsPartition && state.heads.size + 1 > maxRecords)
			|| (addsIdempotency && state.idempotency.size + 1 > maxRecords)
			|| state.knownRecordIdHashes.size + 1 > maxRecords) {
			throw new Error('Audit memory store capacity exhausted.')
		}
		state.records.set(stored.id, clone(stored))
		state.knownRecordIdHashes.add(recordIdHash)
		state.heads.set(record.partitionKey, {sequence: integrity.sequence, hash: integrity.hash})
		state.totalBytes += size
		if (idempotencyHash && semanticFingerprint) state.idempotency.set(idempotencyHash, {id: stored.id, fingerprint: semanticFingerprint})
		return {record: clone(stored), inserted: true}
	}
	const commit = (state: ReturnType<typeof snapshot>) => {
		records.clear(); heads.clear(); idempotency.clear(); sealedPartitions.clear(); knownRecordIdHashes.clear()
		for (const entry of state.records) records.set(...entry)
		for (const entry of state.heads) heads.set(...entry)
		for (const entry of state.idempotency) idempotency.set(...entry)
		for (const key of state.sealedPartitions) sealedPartitions.add(key)
		for (const hash of state.knownRecordIdHashes) knownRecordIdHashes.add(hash)
		totalBytes = state.totalBytes
	}
	const appendMany = (items: ReadonlyArray<PreparedAuditRecord>) => {
		const state = snapshot()
		const result = items.map((item) => insert(item, state))
		commit(state)
		return result
	}
	const groupRecords = (values: Iterable<AuditRecord>) => {
		const groups = groupAuditRecords(values)
		for (const group of groups.values()) group.sort((a, b) => a.integrity.sequence - b.integrity.sequence)
		return groups
	}
	const planPruneBefore = (before: string, limit: number): AuditPrunePlan => {
		if (typeof before !== 'string') throw new Error('Audit prune before is required.')
		assertAuditIsoTimestamp(before, 'before'); assertAuditPruneLimit(limit)
		const selected: AuditRecord[] = []; const partitionKeys: string[] = []; let selectedBytes = 0
		const groups = groupRecords(records.values())
		for (const key of [...groups.keys()].sort(compareAuditText)) {
			const candidate = groups.get(key)!
			const candidateBytes = bytes(candidate)
			if (!candidate.length || candidate.some((record) => compareAuditTimestamps(record.occurredAt, before) >= 0)
				|| selected.length + candidate.length > limit
				|| selectedBytes + candidateBytes > AUDIT_PRUNE_MAX_BYTES) continue
			partitionKeys.push(key); selected.push(...candidate); selectedBytes += candidateBytes
		}
		const selectedGroups = groupRecords(selected)
		const anchors = partitionKeys.map((partitionKey) => {
			const group = selectedGroups.get(partitionKey)!
			const first = group[0]!
			const last = group.at(-1)!
			return {
				partitionKey, count: group.length, firstRecordId: first.id, firstHash: first.integrity.hash,
				lastRecordId: last.id, lastHash: last.integrity.hash
			}
		})
		return {planId: sha256Stable({before, anchors}), before, partitionKeys, records: selected.map(clone), anchors}
	}
	const prunePlanned = (plan: AuditPrunePlan) => {
		if (plan.planId !== sha256Stable({before: plan.before, anchors: plan.anchors})) throw new Error('Audit prune plan id is invalid.')
		const partitionKeys = new Set(plan.partitionKeys)
		const anchorKeys = new Set(plan.anchors.map((anchor) => anchor.partitionKey))
		if (partitionKeys.size !== plan.partitionKeys.length || plan.anchors.length !== partitionKeys.size
			|| anchorKeys.size !== plan.anchors.length
			|| plan.anchors.some((anchor) => !partitionKeys.has(anchor.partitionKey))
			|| plan.records.some((record) => !partitionKeys.has(record.integrity.partitionKey))) {
			throw new Error('Audit prune plan partitions are invalid.')
		}
		const currentGroups = groupRecords(records.values())
		const plannedGroups = groupRecords(plan.records)
		for (const anchor of plan.anchors) {
			const current = currentGroups.get(anchor.partitionKey) ?? []
			if (current.length !== anchor.count || current[0]?.id !== anchor.firstRecordId
				|| current[0]?.integrity.hash !== anchor.firstHash || current.at(-1)?.id !== anchor.lastRecordId
				|| current.at(-1)?.integrity.hash !== anchor.lastHash) throw new Error('Audit prune plan is stale.')
			const planned = plannedGroups.get(anchor.partitionKey) ?? []
			if (planned.length !== current.length || planned.some((record, index) =>
				record.id !== current[index]?.id || record.integrity.hash !== current[index]?.integrity.hash)) {
				throw new Error('Audit prune plan records do not match the anchored partition.')
			}
		}
		let deletedCount = 0
		const ids = new Set(plan.records.map((record) => record.id))
		for (const [id, record] of records) if (ids.has(id)) { records.delete(id); totalBytes -= bytes(record); deletedCount += 1 }
		for (const key of plan.partitionKeys) sealedPartitions.add(key)
		return {deletedCount}
	}
	return {
		kind: 'memory', appendMany,
		getById: (id) => records.has(id) ? clone(records.get(id)!) : undefined,
		query(query: AuditQuery = {}): AuditPage {
			query = normalizeAuditQuery(query)
			assertAuditSort(query.sort); assertAuditIsoTimestamp(query.from, 'query.from'); assertAuditIsoTimestamp(query.to, 'query.to')
			const sort = query.sort ?? 'desc'
			const decoded = decodeAuditCursor(query.cursor)
			const limit = resolveAuditQueryLimit(query.limit, 100)
			const filtered = [...records.values()]
				.filter((record) => matches(record, query))
				.sort((a, b) => compare(a, b, sort))
				.filter((record) => after(record, decoded, sort))
			const items = filtered.slice(0, limit).map(clone)
			const nextCursor = filtered.length > limit ? cursor(filtered[limit - 1]!) : undefined
			return {items, ...(nextCursor ? {nextCursor} : {})}
		},
		verifyIntegrity(filter?: AuditVerificationFilter) {
			const selected = [...records.values()].filter((record) =>
				(!filter?.partitionKey || record.integrity.partitionKey === filter.partitionKey)
				&& (!filter?.from || compareAuditTimestamps(record.occurredAt, filter.from) >= 0)
				&& (!filter?.to || compareAuditTimestamps(record.occurredAt, filter.to) <= 0))
			if (!filter?.from && !filter?.to) {
				const result = verifyAuditRecords(selected)
				return result.ok && filter?.partitionKey && result.partitionKey === undefined
					? {...result, partitionKey: filter.partitionKey}
					: result
			}
			const selectedPartitions = new Set(selected.map((record) => record.integrity.partitionKey))
			const result = verifyAuditRecords([...records.values()].filter((record) => selectedPartitions.has(record.integrity.partitionKey)))
			return result.ok && filter.partitionKey && result.partitionKey === undefined
				? {...result, partitionKey: filter.partitionKey}
				: result
		},
		planPruneBefore, prunePlanned
	}
}
