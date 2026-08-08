import {randomUUID} from 'node:crypto'

import type {AuditActor, AuditCorrelation, AuditWriteRequest} from '@ooopsstudio/core/contracts/audit'
import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'

import {AUDIT_MAX_FUTURE_SKEW_MS, AUDIT_MAXIMUM_LIMITS} from '../constants'
import type {AuditRedactionRule, AuditSafetyLimits, PreparedAuditRecord} from '../types/store'
import {sanitizeAuditValue, snapshotAuditValue} from '../utils/redaction'
import {assertAuditIsoTimestamp} from '../utils/validation'

import {buildAuditPartitionKey, resolveAuditScope, sha256Stable} from './integrity'
import {
	jsonObject,
	normalizeActor,
	normalizeChangeSet,
	normalizeCorrelation,
	normalizeTargets,
	optionalString,
	plainArray,
	plainObject,
	requireString
} from './normalization'

const outcomes = new Set<AuditWriteRequest['outcome']>(['attempted', 'succeeded', 'failed', 'denied'])
const sensitivities = new Set<AuditWriteRequest['sensitivity']>(['low', 'moderate', 'high', 'restricted'])
const MAX_IDENTIFIER_LENGTH = 512
const publicWriteRequestFields = new Set([
	'idempotencyKey', 'eventType', 'category', 'action', 'actor', 'target', 'targets',
	'outcome', 'sensitivity', 'summary', 'workspaceId', 'tenantId', 'correlation',
	'metadata', 'changeSet'
])
const internalWriteRequestFields = new Set([
	...publicWriteRequestFields, 'id', 'occurredAt', 'stream', 'context'
])
type InternalAuditWriteRequest = Omit<AuditWriteRequest, 'actor' | 'correlation'> & {
	readonly id?: string
	readonly occurredAt?: string
	readonly stream?: string
	readonly context?: Record<string, unknown>
	readonly actor: AuditActor
	readonly correlation?: AuditCorrelation
}

function byteSize(value: unknown): number {
	let serialized: string | undefined
	try { serialized = JSON.stringify(value) } catch { throw new Error('Audit record is not JSON serializable.') }
	if (serialized === undefined) throw new Error('Audit record is not JSON serializable.')
	return Buffer.byteLength(serialized)
}

export function normalizeAuditWriteRequest(
	clock: Clock,
	request: AuditWriteRequest,
	rules: ReadonlyArray<AuditRedactionRule> = [],
	limits: AuditSafetyLimits = AUDIT_MAXIMUM_LIMITS,
	resource?: ObservabilityResource,
	allowRuntimeFields = true
): PreparedAuditRecord {
	const writeRequestFields = allowRuntimeFields ? internalWriteRequestFields : publicWriteRequestFields
	const readableSource = plainObject(request, 'write request', writeRequestFields)
	const definedSource: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	for (const [key, value] of Object.entries(readableSource)) if (value !== undefined) definedSource[key] = value
	if (definedSource.targets !== undefined) definedSource.targets = plainArray(definedSource.targets, 'targets', limits.maxTargets)
	const preflightLimits: AuditSafetyLimits = {
		...limits,
		maxDepth: limits.maxDepth + 3,
		maxObjectKeys: Math.max(limits.maxObjectKeys, writeRequestFields.size),
		maxArrayEntries: Math.max(limits.maxArrayEntries, limits.maxTargets)
	}
	const boundedSource = snapshotAuditValue(definedSource, 'write request', preflightLimits)
	if (!boundedSource || typeof boundedSource !== 'object' || Array.isArray(boundedSource)) {
		throw new Error('Audit write request must be an object.')
	}
	const source = boundedSource as unknown as InternalAuditWriteRequest
	const eventType = requireString(source.eventType, 'eventType')
	const category = requireString(source.category, 'category')
	const action = requireString(source.action, 'action')
	if (!outcomes.has(source.outcome)) throw new Error('Audit outcome is invalid.')
	if (!sensitivities.has(source.sensitivity)) throw new Error('Audit sensitivity is invalid.')
	if (!allowRuntimeFields && source.actor && typeof source.actor === 'object' && Object.hasOwn(source.actor, 'email')) {
		throw new Error('Audit actor.email is not accepted on writes.')
	}
	if (!allowRuntimeFields && source.correlation && typeof source.correlation === 'object'
		&& ['hostKind', 'runtime', 'resource'].some((field) => Object.hasOwn(source.correlation!, field))) {
		throw new Error('Audit write correlation contains runtime-owned fields.')
	}
	const canonicalActor = normalizeActor(source.actor, [], limits, false)
	const canonicalTargets = normalizeTargets(source, [], limits, false)
	const canonicalCorrelation = normalizeCorrelation(source.correlation, [], limits, false)
	const canonicalContext = jsonObject(allowRuntimeFields ? source.context : undefined, [], 'context', limits, false)
	const canonicalMetadata = jsonObject(source.metadata, [], 'metadata', limits, false)
	const canonicalChangeSet = normalizeChangeSet(source.changeSet, [], limits, false)
	const actor = normalizeActor(canonicalActor, rules, limits)
	const targets = normalizeTargets({targets: canonicalTargets} as AuditWriteRequest, rules, limits)
	if (actor.kind !== canonicalActor.kind) throw new Error('Audit redaction rules must not change actor.kind.')
	if (targets.length !== canonicalTargets.length) throw new Error('Audit redaction rules must not merge distinct targets.')
	const idempotencyKey = optionalString(source.idempotencyKey, 'idempotencyKey', 1024)
	const workspaceId = optionalString(source.workspaceId, 'workspaceId')
	const tenantId = optionalString(source.tenantId, 'tenantId')
	const id = allowRuntimeFields ? optionalString(source.id, 'id') : undefined
	// Persist the legacy stream projection deterministically so v1 records and hashes
	// remain structurally compatible without giving callers partition control.
	const stream = allowRuntimeFields ? optionalString(source.stream, 'stream') : category
	const now = clock.now()
	if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
		throw new Error('Audit clock must return valid non-negative epoch milliseconds.')
	}
	const nowIso = new Date(now).toISOString()
	const occurredAt = allowRuntimeFields && source.occurredAt ? source.occurredAt : nowIso
	assertAuditIsoTimestamp(occurredAt, 'occurredAt')
	if (Date.parse(occurredAt) > now + AUDIT_MAX_FUTURE_SKEW_MS) {
		throw new Error('Audit occurredAt exceeds the maximum future clock skew.')
	}
	const rawSummary = optionalString(source.summary, 'summary', limits.maxStringLength)
	const sanitizedSummary = rawSummary === undefined
		? undefined
		: sanitizeAuditValue({summary: rawSummary}, rules, '', limits) as {summary?: unknown}
	const summary = typeof sanitizedSummary?.summary === 'string' ? sanitizedSummary.summary : undefined
	const correlation = normalizeCorrelation({...canonicalCorrelation, ...(resource ? {resource} : {})}, rules, limits)
	const context = jsonObject(canonicalContext, rules, 'context', limits)
	const metadata = jsonObject(canonicalMetadata, rules, 'metadata', limits)
	const changeSet = normalizeChangeSet(canonicalChangeSet, rules, limits)
	const semanticCorrelation = {
		...(correlation.requestId ? {requestId: correlation.requestId} : {}),
		...(correlation.correlationId ? {correlationId: correlation.correlationId} : {}),
		...(correlation.traceId ? {traceId: correlation.traceId} : {}),
		...(correlation.spanId ? {spanId: correlation.spanId} : {})
	}
	const scope = resolveAuditScope({
		...(tenantId ? {tenantId} : {}), ...(workspaceId ? {workspaceId} : {}),
		actor: canonicalActor, targets: canonicalTargets
	})
	const partitionKey = buildAuditPartitionKey({...scope, ...(stream ? {stream} : {}), category, occurredAt})
	if (partitionKey.length > MAX_IDENTIFIER_LENGTH) throw new Error('Audit partition key is too long.')
	const semanticFingerprint = idempotencyKey ? sha256Stable({
		...(id ? {id} : {}), eventType, category, action,
		...(allowRuntimeFields && source.occurredAt ? {occurredAt: source.occurredAt} : {}),
		actor, targets, outcome: source.outcome, sensitivity: source.sensitivity,
		...(summary ? {summary} : {}),
		...(scope.workspaceId ? {workspaceId: scope.workspaceId} : {}),
		...(scope.tenantId ? {tenantId: scope.tenantId} : {}),
		...(stream ? {stream} : {}), correlation: semanticCorrelation, context,
		metadata, ...(changeSet ? {changeSet} : {})
	}) : undefined
	const record: PreparedAuditRecord = {
		id: id ?? randomUUID(), eventType, category, action, occurredAt, createdAt: nowIso, actor, targets,
		outcome: source.outcome, sensitivity: source.sensitivity, ...(summary ? {summary} : {}),
		...(scope.workspaceId ? {workspaceId: scope.workspaceId} : {}),
		...(scope.tenantId ? {tenantId: scope.tenantId} : {}), ...(stream ? {stream} : {}),
		correlation, context, metadata, ...(changeSet ? {changeSet} : {}), partitionKey,
		...(idempotencyKey && semanticFingerprint ? {
			idempotencyHash: sha256Stable({
				tenantId: scope.tenantId ?? null, workspaceId: scope.workspaceId ?? null, key: idempotencyKey
			}),
			semanticFingerprint
		} : {})
	}
	if (byteSize(record) > limits.maxRecordBytes) {
		throw new Error(`Audit record exceeds the maximum of ${limits.maxRecordBytes} bytes.`)
	}
	return record
}
