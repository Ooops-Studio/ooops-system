import type {AuditPage, AuditQuery, AuditRecord} from '@ooopsstudio/core/contracts/audit'
import type {JsonValue} from '@ooopsstudio/core/contracts/json'

import {AUDIT_MAX_FUTURE_SKEW_MS, AUDIT_MAXIMUM_LIMITS} from '../constants'
import type {AuditAppendResult, AuditRedactionRule, AuditSafetyLimits, PreparedAuditRecord} from '../types/store'
import {sanitizeAuditValue, snapshotAuditValue} from '../utils/redaction'
import {isAuditSafeString} from '../utils/string-safety'
import {
	assertAuditIsoTimestamp,
	assertAuditSort,
	compareAuditCursorValues,
	compareAuditTimestamps,
	decodeAuditCursor,
	resolveAuditQueryLimit
} from '../utils/validation'

import {buildAuditIntegrity, buildAuditPartitionKey, matchesAuditPartitionKey, resolveAuditScope, sha256Stable} from './integrity'

function boundedFilter(value: unknown, field: string): void {
	if (value !== undefined && (typeof value !== 'string' || !value.trim() || value !== value.trim()
		|| value.length > 512 || !isAuditSafeString(value))) {
		throw new Error(`Audit query ${field} is invalid.`)
	}
}

const auditQueryFields = new Set([
	'cursor', 'limit', 'sort', 'from', 'to', 'eventType', 'category', 'action', 'outcome', 'actorKind',
	'actorId', 'targetEntityType', 'targetEntityId', 'workspaceId', 'tenantId', 'sensitivity', 'partitionKey'
])

function snapshotQueryList(value: unknown, field: string): ReadonlyArray<string> | string | undefined {
	if (value === undefined || typeof value === 'string') return value
	if (!Array.isArray(value)) throw new Error(`Audit query ${field} is invalid.`)
	try {
		const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
		if (!Number.isSafeInteger(length) || length === 0 || length > 4) throw new Error()
		const allowed = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
		if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new Error()
		return Array.from({length}, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new Error()
			return descriptor.value
		})
	} catch {
		throw new Error(`Audit query ${field} is invalid.`)
	}
}

export function normalizeAuditQuery(value: AuditQuery | undefined): AuditQuery {
	if (value === undefined) return {}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Audit query is invalid.')
	let query: Record<string, unknown>
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		query = Object.create(null) as Record<string, unknown>
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || !auditQueryFields.has(key)) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			query[key] = descriptor.value
		}
	} catch { throw new Error('Audit query must be a readable plain object with known fields.') }
	query.outcome = snapshotQueryList(query.outcome, 'outcome')
	query.sensitivity = snapshotQueryList(query.sensitivity, 'sensitivity')
	if (Array.isArray(query.outcome)) Object.freeze(query.outcome)
	if (Array.isArray(query.sensitivity)) Object.freeze(query.sensitivity)
	for (const field of ['eventType', 'category', 'action', 'actorId', 'targetEntityType', 'targetEntityId', 'workspaceId', 'tenantId', 'partitionKey']) {
		if (typeof query[field] === 'string') query[field] = query[field].trim()
	}
	const snapshot = query as unknown as AuditQuery
	validateQuerySnapshot(snapshot)
	return Object.freeze(snapshot)
}

function validateQuerySnapshot(query: AuditQuery): void {
	assertAuditSort(query.sort)
	resolveAuditQueryLimit(query.limit, 100)
	assertAuditIsoTimestamp(query.from, 'query.from')
	assertAuditIsoTimestamp(query.to, 'query.to')
	decodeAuditCursor(query.cursor)
	for (const [field, value] of Object.entries({
		eventType: query.eventType, category: query.category, action: query.action, actorId: query.actorId,
		targetEntityType: query.targetEntityType, targetEntityId: query.targetEntityId,
		workspaceId: query.workspaceId, tenantId: query.tenantId, partitionKey: query.partitionKey
	})) boundedFilter(value, field)
	if (query.from && query.to && compareAuditTimestamps(query.from, query.to) > 0) throw new Error('Audit query from must not be after to.')
	if (query.actorKind !== undefined && !['user', 'service', 'system', 'anonymous', 'worker'].includes(query.actorKind)) {
		throw new Error('Audit query actorKind is invalid.')
	}
	if (Array.isArray(query.outcome) && (query.outcome.length === 0 || query.outcome.length > 4)) throw new Error('Audit query outcome is invalid.')
	if (Array.isArray(query.sensitivity) && (query.sensitivity.length === 0 || query.sensitivity.length > 4)) throw new Error('Audit query sensitivity is invalid.')
	const outcomes = Array.isArray(query.outcome) ? query.outcome : query.outcome ? [query.outcome] : []
	if (outcomes.some((value) => !['attempted', 'succeeded', 'failed', 'denied'].includes(value))) throw new Error('Audit query outcome is invalid.')
	const sensitivities = Array.isArray(query.sensitivity) ? query.sensitivity : query.sensitivity ? [query.sensitivity] : []
	if (sensitivities.some((value) => !['low', 'moderate', 'high', 'restricted'].includes(value))) throw new Error('Audit query sensitivity is invalid.')
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

function validOptionalString(value: unknown, maximum = 512): boolean {
	return value === undefined || (typeof value === 'string' && value.length > 0 && value === value.trim()
		&& value.length <= maximum && isAuditSafeString(value))
}

function hasOnlyFields(value: object, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key))
}

const actorRecordFields = new Set(['kind', 'id', 'displayName', 'email', 'workspaceId', 'tenantId', 'metadata'])
const targetRecordFields = new Set(['entityType', 'entityId', 'workspaceId', 'tenantId', 'resource', 'displayName', 'metadata'])
const correlationRecordFields = new Set(['requestId', 'correlationId', 'traceId', 'spanId', 'hostKind', 'runtime', 'resource'])
const resourceRecordFields = new Set(['serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime', 'attributes'])
const changeSetRecordFields = new Set(['before', 'after', 'changedFields', 'summary'])
const integrityRecordFields = new Set(['partitionKey', 'sequence', 'prevHash', 'hash', 'algorithm'])

function snapshotDenseArray(value: unknown, maximum: number, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`Audit store returned invalid ${label}.`)
	try {
		const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
		if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error()
		const allowed = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
		if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new Error()
		return Array.from({length}, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			return descriptor.value
		})
	} catch { throw new Error(`Audit store returned invalid ${label}.`) }
}

function snapshotStoreObject(value: unknown, allowed: ReadonlyArray<string>, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Audit store returned an invalid ${label}.`)
	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || !allowed.includes(key)) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			output[key] = descriptor.value
		}
	} catch { throw new Error(`Audit store returned an invalid ${label}.`) }
	return output
}

export function validateAuditRecord(
	value: unknown,
	limits: AuditSafetyLimits = AUDIT_MAXIMUM_LIMITS,
	rules: ReadonlyArray<AuditRedactionRule> = [],
	currentTimeMs?: number
): AuditRecord {
	if (!value || typeof value !== 'object') throw new Error('Audit store returned an invalid audit record.')
	let safeValue: JsonValue
	let exactValue: JsonValue
	try {
		safeValue = sanitizeAuditValue(value, rules, '', limits)
		exactValue = snapshotAuditValue(value, '', limits)
	} catch {
		throw new Error('Audit store returned unsafe record.')
	}
	const serialized = JSON.stringify(safeValue)
	if (sha256Stable(safeValue) !== sha256Stable(exactValue)) throw new Error('Audit store returned unsafe record.')
	const record = safeValue as Partial<AuditRecord> & {idempotencyKey?: unknown}
	const allowed = new Set([
		'id', 'eventType', 'category', 'action', 'occurredAt', 'createdAt', 'actor', 'targets', 'outcome',
		'sensitivity', 'summary', 'workspaceId', 'tenantId', 'stream', 'correlation', 'context', 'metadata',
		'changeSet', 'integrity'
	])
	if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('Audit store returned a record with unknown fields.')
	if ('idempotencyKey' in record) throw new Error('Audit store exposed a raw idempotency key.')
	if (!validOptionalString(record.id) || record.id === undefined) throw new Error('Audit store returned an invalid record id.')
	for (const [field, fieldValue] of Object.entries({eventType: record.eventType, category: record.category, action: record.action})) {
		if (fieldValue === undefined || !validOptionalString(fieldValue)) throw new Error(`Audit store returned an invalid ${field}.`)
	}
	const optionalStrings = {
		summary: record.summary,
		workspaceId: record.workspaceId,
		tenantId: record.tenantId,
		stream: record.stream
	}
	for (const [field, fieldValue] of Object.entries(optionalStrings)) {
		if (!validOptionalString(fieldValue, limits.maxStringLength)) throw new Error(`Audit store returned an invalid ${field}.`)
	}
	if (record.occurredAt === undefined) throw new Error('Audit store returned an invalid occurredAt.')
	if (record.createdAt === undefined) throw new Error('Audit store returned an invalid createdAt.')
	assertAuditIsoTimestamp(record.occurredAt, 'store.occurredAt')
	assertAuditIsoTimestamp(record.createdAt, 'store.createdAt')
	if (currentTimeMs !== undefined && (!Number.isSafeInteger(currentTimeMs) || currentTimeMs < 0
		|| currentTimeMs > 8_640_000_000_000_000)) throw new Error('Audit clock returned an invalid validation time.')
	if (currentTimeMs !== undefined && Date.parse(record.createdAt) > currentTimeMs + AUDIT_MAX_FUTURE_SKEW_MS) {
		throw new Error('Audit store returned an invalid future createdAt.')
	}
	if (Date.parse(record.occurredAt) > Date.parse(record.createdAt) + AUDIT_MAX_FUTURE_SKEW_MS) {
		throw new Error('Audit store returned an invalid future occurredAt.')
	}
	if (!record.actor || typeof record.actor !== 'object' || Array.isArray(record.actor)
		|| !hasOnlyFields(record.actor, actorRecordFields)
		|| !['user', 'service', 'system', 'anonymous', 'worker'].includes(record.actor.kind)
		|| ![record.actor.id, record.actor.email, record.actor.workspaceId, record.actor.tenantId].every((value) => validOptionalString(value))
		|| !validOptionalString(record.actor.displayName, limits.maxStringLength)
		|| (record.actor.metadata !== undefined && (!record.actor.metadata || typeof record.actor.metadata !== 'object' || Array.isArray(record.actor.metadata)))) {
		throw new Error('Audit store returned an invalid actor.')
	}
	if (!record.integrity || !hasOnlyFields(record.integrity, integrityRecordFields)
		|| record.integrity.algorithm !== 'sha256-stable-json-v1' || !Number.isSafeInteger(record.integrity.sequence) || record.integrity.sequence <= 0 || typeof record.integrity.hash !== 'string' || !/^[a-f0-9]{64}$/.test(record.integrity.hash) || typeof record.integrity.partitionKey !== 'string' || !record.integrity.partitionKey || record.integrity.partitionKey.length > 512 || (record.integrity.prevHash !== null && (typeof record.integrity.prevHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.integrity.prevHash)))) {
		throw new Error('Audit store returned invalid integrity metadata.')
	}
	if (!Array.isArray(record.targets) || record.targets.length === 0 || record.targets.length > limits.maxTargets) throw new Error('Audit store returned invalid targets.')
	if (record.targets.some((target) => !target || typeof target !== 'object' || Array.isArray(target)
		|| !hasOnlyFields(target, targetRecordFields) || !validOptionalString(target.entityType)
		|| target.entityType === undefined || !validOptionalString(target.entityId) || target.entityId === undefined
		|| ![target.workspaceId, target.tenantId].every((value) => validOptionalString(value))
		|| !validOptionalString(target.resource, limits.maxStringLength)
		|| !validOptionalString(target.displayName, limits.maxStringLength)
		|| (target.metadata !== undefined && (!target.metadata || typeof target.metadata !== 'object' || Array.isArray(target.metadata))))) {
		throw new Error('Audit store returned invalid targets.')
	}
	if (!record.correlation || typeof record.correlation !== 'object' || Array.isArray(record.correlation)
		|| !hasOnlyFields(record.correlation, correlationRecordFields)
		|| !record.context || typeof record.context !== 'object' || Array.isArray(record.context)
		|| !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
		throw new Error('Audit store returned invalid structured fields.')
	}
	if (![record.correlation.requestId, record.correlation.correlationId, record.correlation.traceId, record.correlation.spanId,
		record.correlation.hostKind, record.correlation.runtime].every((value) => validOptionalString(value))) {
		throw new Error('Audit store returned invalid correlation metadata.')
	}
	if (record.correlation.resource !== undefined
		&& (!record.correlation.resource || typeof record.correlation.resource !== 'object'
			|| Array.isArray(record.correlation.resource)
			|| !hasOnlyFields(record.correlation.resource, resourceRecordFields)
			|| !validOptionalString(record.correlation.resource.serviceName)
			|| record.correlation.resource.serviceName === undefined
			|| ![
				record.correlation.resource.serviceVersion, record.correlation.resource.deploymentEnvironment,
				record.correlation.resource.hostKind, record.correlation.resource.runtime
			].every((value) => validOptionalString(value))
			|| (record.correlation.resource.attributes !== undefined
				&& (!record.correlation.resource.attributes || typeof record.correlation.resource.attributes !== 'object'
					|| Array.isArray(record.correlation.resource.attributes))))) {
		throw new Error('Audit store returned an invalid correlation resource.')
	}
	if (record.changeSet !== undefined && (!record.changeSet || typeof record.changeSet !== 'object'
		|| Array.isArray(record.changeSet) || !hasOnlyFields(record.changeSet, changeSetRecordFields)
		|| (record.changeSet.before !== undefined && (!record.changeSet.before || typeof record.changeSet.before !== 'object' || Array.isArray(record.changeSet.before)))
		|| (record.changeSet.after !== undefined && (!record.changeSet.after || typeof record.changeSet.after !== 'object' || Array.isArray(record.changeSet.after)))
		|| (record.changeSet.changedFields !== undefined
			&& (!Array.isArray(record.changeSet.changedFields)
				|| record.changeSet.changedFields.some((field) => !validOptionalString(field, limits.maxStringLength))))
		|| !validOptionalString(record.changeSet.summary, limits.maxStringLength))) {
		throw new Error('Audit store returned an invalid changeSet.')
	}
	if (!['attempted', 'succeeded', 'failed', 'denied'].includes(record.outcome as string) || !['low', 'moderate', 'high', 'restricted'].includes(record.sensitivity as string)) throw new Error('Audit store returned invalid enums.')
	try {
		if (Buffer.byteLength(serialized) > limits.maxRecordBytes) throw new Error('oversized')
		const {integrity, ...body} = record as AuditRecord
		const partitionInput = {
			...resolveAuditScope(body),
			...(body.stream ? {stream: body.stream} : {}),
			category: body.category,
			occurredAt: body.occurredAt
		}
		if (!matchesAuditPartitionKey(partitionInput, integrity.partitionKey)) throw new Error('invalid partition')
		const expectedIntegrity = buildAuditIntegrity({
			...body,
			partitionKey: integrity.partitionKey
		}, {sequence: integrity.sequence, prevHash: integrity.prevHash})
		if (expectedIntegrity.hash !== integrity.hash) throw new Error('invalid hash')
		return clone(record as AuditRecord)
	} catch { throw new Error('Audit store returned unsafe record.') }
}

export function assertPreparedAuditRecordSafe(
	record: PreparedAuditRecord,
	limits: AuditSafetyLimits,
	rules: ReadonlyArray<AuditRedactionRule>
): void {
	const integrity = buildAuditIntegrity(record, {
		sequence: Number.MAX_SAFE_INTEGER,
		prevHash: 'f'.repeat(64)
	})
	const {
		idempotencyHash: _idempotencyHash,
		semanticFingerprint: _semanticFingerprint,
		partitionKey: _partitionKey,
		...body
	} = record
	validateAuditRecord({...body, integrity}, limits, rules)
}

function equalSemantic(expected: PreparedAuditRecord, actual: AuditRecord, inserted: boolean): boolean {
	const fields: ReadonlyArray<keyof AuditRecord> = [
		'eventType', 'category', 'action', 'actor', 'targets', 'outcome', 'sensitivity', 'summary',
		'workspaceId', 'tenantId', 'stream', 'context', 'metadata', 'changeSet'
	]
	for (const field of fields) {
		const expectedValue = (expected as unknown as Record<string, unknown>)[field]
		const actualValue = (actual as unknown as Record<string, unknown>)[field]
		if (sha256Stable(expectedValue) !== sha256Stable(actualValue)) return false
	}
	if ((inserted && sha256Stable(expected.correlation) !== sha256Stable(actual.correlation))
		|| (!inserted && ['requestId', 'correlationId', 'traceId', 'spanId'].some((field) =>
			expected.correlation[field as keyof typeof expected.correlation]
			!== actual.correlation[field as keyof typeof actual.correlation]))) return false
	if (inserted && expected.id !== actual.id) return false
	if (inserted && expected.occurredAt !== actual.occurredAt) return false
	if (inserted && expected.createdAt !== actual.createdAt) return false
	const expectedPartition = inserted ? expected.partitionKey : buildAuditPartitionKey({
		...resolveAuditScope(expected),
		...(expected.stream ? {stream: expected.stream} : {}),
		category: expected.category,
		occurredAt: actual.occurredAt
	})
	return actual.integrity.partitionKey === expectedPartition
}

export function validateAppendResults(
	requests: ReadonlyArray<PreparedAuditRecord>,
	results: ReadonlyArray<AuditAppendResult>,
	limits: AuditSafetyLimits = AUDIT_MAXIMUM_LIMITS,
	rules: ReadonlyArray<AuditRedactionRule> = [],
	currentTimeMs?: number
): ReadonlyArray<AuditAppendResult> {
	const resultValues = snapshotDenseArray(results, requests.length, 'append results')
	if (resultValues.length !== requests.length) throw new Error(`Audit store returned ${resultValues.length} results for ${requests.length} requests.`)
	const seen = new Map<string, string | undefined>()
	const idempotencyRecords = new Map<string, string>()
	return resultValues.map((value, index) => {
		const result = snapshotStoreObject(value, ['record', 'inserted'], `append result at index ${index}`)
		if (typeof result.inserted !== 'boolean') throw new Error(`Audit store returned an invalid append result at index ${index}.`)
		if (!result.inserted && !requests[index]!.idempotencyHash) {
			throw new Error(`Audit store returned a replay for a non-idempotent request at index ${index}.`)
		}
		const record = validateAuditRecord(result.record, limits, rules, currentTimeMs)
		if (!equalSemantic(requests[index]!, record, result.inserted)) throw new Error(`Audit store returned a mismatched record at index ${index}.`)
		const requestHash = requests[index]!.idempotencyHash
		if (seen.has(record.id) && (result.inserted || requestHash === undefined || seen.get(record.id) !== requestHash)) {
			throw new Error(`Audit store returned an invalid duplicate record at index ${index}.`)
		}
		if (requestHash !== undefined && idempotencyRecords.has(requestHash)
			&& (result.inserted || idempotencyRecords.get(requestHash) !== record.id)) {
			throw new Error(`Audit store returned an inconsistent idempotency replay at index ${index}.`)
		}
		if (!seen.has(record.id)) seen.set(record.id, requestHash)
		if (requestHash !== undefined && !idempotencyRecords.has(requestHash)) idempotencyRecords.set(requestHash, record.id)
		return {record, inserted: result.inserted}
	})
}

function matchesQuery(record: AuditRecord, query: AuditQuery): boolean {
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
	const outcomes = Array.isArray(query.outcome) ? query.outcome : query.outcome ? [query.outcome] : []
	if (outcomes.length > 0 && !outcomes.includes(record.outcome)) return false
	const sensitivities = Array.isArray(query.sensitivity) ? query.sensitivity : query.sensitivity ? [query.sensitivity] : []
	if (sensitivities.length > 0 && !sensitivities.includes(record.sensitivity)) return false
	return !(query.targetEntityType || query.targetEntityId) || record.targets.some((target) =>
		(!query.targetEntityType || target.entityType === query.targetEntityType)
		&& (!query.targetEntityId || target.entityId === query.targetEntityId))
}

export function validateAuditPage(
	page: unknown,
	maximum = 500,
	query: AuditQuery = {},
	limits: AuditSafetyLimits = AUDIT_MAXIMUM_LIMITS,
	rules: ReadonlyArray<AuditRedactionRule> = [],
	currentTimeMs?: number
): AuditPage {
	const candidate = snapshotStoreObject(page, ['items', 'nextCursor'], 'query page')
	const items: AuditRecord[] = []
	let pageBytes = 2
	for (const rawRecord of snapshotDenseArray(candidate.items, maximum, 'query page items')) {
		const record = validateAuditRecord(rawRecord, limits, rules, currentTimeMs)
		pageBytes += Buffer.byteLength(JSON.stringify(record)) + (items.length > 0 ? 1 : 0)
		if (pageBytes > limits.maxBatchBytes) throw new Error('Audit query page exceeds the byte limit.')
		items.push(record)
	}
	if (candidate.nextCursor !== undefined && typeof candidate.nextCursor !== 'string') throw new Error('Audit store returned an invalid query cursor.')
	const nextCursor = candidate.nextCursor === undefined ? undefined : decodeAuditCursor(candidate.nextCursor)
	const cursor = decodeAuditCursor(query.cursor)
	const sort = query.sort ?? 'desc'
	const seen = new Set<string>()
	for (let index = 0; index < items.length; index++) {
		const record = items[index]!
		if (!matchesQuery(record, query) || seen.has(record.id)) throw new Error('Audit store returned records outside the requested query.')
		seen.add(record.id)
		const previous = items[index - 1]
		if (previous) {
			const comparison = compareAuditCursorValues(previous, record)
			if ((sort === 'asc' && comparison >= 0) || (sort === 'desc' && comparison <= 0)) {
				throw new Error('Audit store returned records in an invalid order.')
			}
		}
		if (cursor) {
			const comparison = compareAuditCursorValues(record, cursor)
			if ((sort === 'asc' && comparison <= 0) || (sort === 'desc' && comparison >= 0)) {
				throw new Error('Audit store returned records before the requested cursor.')
			}
		}
	}
	if (nextCursor) {
		const tail = items.at(-1)
		if (!tail || nextCursor.id !== tail.id || nextCursor.occurredAt !== tail.occurredAt) {
			throw new Error('Audit store returned a cursor that does not match the page tail.')
		}
	}
	return {items, ...(candidate.nextCursor ? {nextCursor: candidate.nextCursor as string} : {})}
}
