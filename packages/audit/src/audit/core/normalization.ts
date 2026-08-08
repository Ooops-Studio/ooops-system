import type {AuditActor, AuditChangeSet, AuditCorrelation, AuditTarget, AuditWriteRequest} from '@ooopsstudio/core/contracts/audit'
import type {JsonObject} from '@ooopsstudio/core/contracts/json'

import type {AuditRedactionRule, AuditSafetyLimits} from '../types/store'
import {sanitizeAuditValue, snapshotAuditValue} from '../utils/redaction'
import {isAuditSafeString} from '../utils/string-safety'
import {compareAuditText} from '../utils/validation'

import {sha256Stable} from './integrity'

const actorKinds = new Set<AuditActor['kind']>(['user', 'service', 'system', 'anonymous', 'worker'])
const MAX_IDENTIFIER_LENGTH = 512
const actorFields = new Set(['kind', 'id', 'displayName', 'email', 'workspaceId', 'tenantId', 'metadata'])
const targetFields = new Set([
	'entityType', 'entityId', 'workspaceId', 'tenantId', 'resource', 'displayName', 'metadata'
])
const changeSetFields = new Set(['before', 'after', 'changedFields', 'summary'])
const correlationFields = new Set([
	'requestId', 'correlationId', 'traceId', 'spanId', 'hostKind', 'runtime', 'resource'
])
const resourceFields = new Set([
	'serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime', 'attributes'
])

export function requireString(value: unknown, field: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`Audit ${field} is required.`)
	const result = value.trim()
	if (!isAuditSafeString(result)) throw new Error(`Audit ${field} contains unsupported characters.`)
	if (result.length > maxLength) throw new Error(`Audit ${field} is too long.`)
	return result
}

export function optionalString(value: unknown, field: string, maxLength = MAX_IDENTIFIER_LENGTH): string | undefined {
	return value === undefined ? undefined : requireString(value, field, maxLength)
}

export function plainObject(value: unknown, field: string, allowedFields?: ReadonlySet<string>): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Audit ${field} must be an object.`)
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || (allowedFields && !allowedFields.has(key))) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			snapshot[key] = descriptor.value
		}
		return snapshot
	} catch {
		throw new Error(`Audit ${field} must be a readable plain object.`)
	}
}

export function plainArray(value: unknown, field: string, maximum: number): unknown[] {
	if (!Array.isArray(value)) throw new Error(`Audit ${field} must be an array.`)
	let length: number
	try { length = Object.getOwnPropertyDescriptor(value, 'length')?.value as number } catch {
		throw new Error(`Audit ${field} must be a readable bounded array.`)
	}
	if (!Number.isSafeInteger(length) || length < 0) throw new Error(`Audit ${field} must be a readable bounded array.`)
	if (length > maximum) throw new Error(`Audit ${field} exceeds the maximum of ${maximum}.`)
	try {
		const allowed = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
		if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new Error()
		return Array.from({length}, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			return descriptor.value
		})
	} catch { throw new Error(`Audit ${field} must be a readable bounded array.`) }
}

function auditValue(
	value: unknown,
	rules: ReadonlyArray<AuditRedactionRule>,
	path: string,
	limits: AuditSafetyLimits,
	redact: boolean
) {
	return redact ? sanitizeAuditValue(value, rules, path, limits) : snapshotAuditValue(value, path, limits)
}

export function jsonObject(
	value: unknown,
	rules: ReadonlyArray<AuditRedactionRule>,
	path: string,
	limits: AuditSafetyLimits,
	redact = true
): JsonObject {
	const sanitized = auditValue(value === undefined ? {} : value, rules, path, limits, redact)
	if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) throw new Error(`Audit ${path} must be an object.`)
	return sanitized as JsonObject
}

export function normalizeActor(
	value: unknown,
	rules: ReadonlyArray<AuditRedactionRule>,
	limits: AuditSafetyLimits,
	redact = true
): AuditActor {
	const actor = plainObject(value, 'actor', actorFields) as unknown as AuditActor
	if (!actorKinds.has(actor.kind)) throw new Error('Audit actor.kind is invalid.')
	const initialId = optionalString(actor.id, 'actor.id')
	const initialDisplayName = optionalString(actor.displayName, 'actor.displayName', limits.maxStringLength)
	const initialEmail = optionalString(actor.email, 'actor.email')
	const initialWorkspaceId = optionalString(actor.workspaceId, 'actor.workspaceId')
	const initialTenantId = optionalString(actor.tenantId, 'actor.tenantId')
	const result = {
		kind: actor.kind,
		...(initialId ? {id: initialId} : {}),
		...(initialDisplayName ? {displayName: initialDisplayName} : {}),
		...(initialEmail ? {email: initialEmail} : {}),
		...(initialWorkspaceId ? {workspaceId: initialWorkspaceId} : {}),
		...(initialTenantId ? {tenantId: initialTenantId} : {}),
		...(actor.metadata !== undefined ? {metadata: jsonObject(actor.metadata, [], 'actor.metadata', limits, false)} : {})
	}
	const sanitized = auditValue(result, rules, 'actor', limits, redact) as unknown as AuditActor
	if (!sanitized || typeof sanitized !== 'object') {
		throw new Error('Audit redaction rules must preserve actor.kind.')
	}
	const safe = plainObject(sanitized, 'redacted actor', actorFields) as unknown as AuditActor
	if (!actorKinds.has(safe.kind)) throw new Error('Audit redaction rules must preserve actor.kind.')
	const id = optionalString(safe.id, 'actor.id')
	const displayName = optionalString(safe.displayName, 'actor.displayName', limits.maxStringLength)
	const email = optionalString(safe.email, 'actor.email')
	const workspaceId = optionalString(safe.workspaceId, 'actor.workspaceId')
	const tenantId = optionalString(safe.tenantId, 'actor.tenantId')
	return {
		kind: safe.kind,
		...(id ? {id} : {}),
		...(displayName ? {displayName} : {}),
		...(email ? {email} : {}),
		...(workspaceId ? {workspaceId} : {}),
		...(tenantId ? {tenantId} : {}),
		...(safe.metadata !== undefined ? {metadata: jsonObject(safe.metadata, [], 'actor.metadata', limits, false)} : {})
	}
}

export function normalizeTargets(
	request: AuditWriteRequest,
	rules: ReadonlyArray<AuditRedactionRule>,
	limits: AuditSafetyLimits,
	redact = true
): ReadonlyArray<AuditTarget> {
	const targetList = request.targets === undefined ? [] : plainArray(request.targets, 'targets', limits.maxTargets)
	const values: unknown[] = [...(request.target === undefined ? [] : [request.target]), ...targetList]
	if (values.length === 0) throw new Error('Audit records require at least one target.')
	if (values.length > limits.maxTargets) throw new Error(`Audit targets exceed the maximum of ${limits.maxTargets}.`)
	const canonicalTargets = new Map<string, AuditTarget>()
	for (const value of values) {
		const target = plainObject(value, 'target', targetFields) as unknown as AuditTarget
		const initialWorkspaceId = optionalString(target.workspaceId, 'target.workspaceId')
		const initialTenantId = optionalString(target.tenantId, 'target.tenantId')
		const initialResource = optionalString(target.resource, 'target.resource', limits.maxStringLength)
		const initialDisplayName = optionalString(target.displayName, 'target.displayName', limits.maxStringLength)
		const normalized: AuditTarget = {
			entityType: requireString(target.entityType, 'target.entityType'),
			entityId: requireString(target.entityId, 'target.entityId'),
			...(initialWorkspaceId ? {workspaceId: initialWorkspaceId} : {}),
			...(initialTenantId ? {tenantId: initialTenantId} : {}),
			...(initialResource ? {resource: initialResource} : {}),
			...(initialDisplayName ? {displayName: initialDisplayName} : {}),
			...(target.metadata !== undefined ? {metadata: jsonObject(target.metadata, [], 'targets.metadata', limits, false)} : {})
		}
		const identity = sha256Stable([normalized.entityType, normalized.entityId, normalized.tenantId, normalized.workspaceId])
		const existing = canonicalTargets.get(identity)
		if (existing && sha256Stable(existing) !== sha256Stable(normalized)) {
			throw new Error('Audit targets contain conflicting data for the same entity.')
		}
		if (!existing) canonicalTargets.set(identity, normalized)
	}
	const orderedTargets = [...canonicalTargets.entries()].sort(([left], [right]) => compareAuditText(left, right))
	const auditedTargets = orderedTargets.map(([, normalized], targetIndex) => {
		// Redaction paths describe the persisted AuditRecord shape, where targets
		// is always a deterministically sorted array. Apply indexed rules only
		// after canonical deduplication and sorting so targets[n] addresses the
		// same element before and after the mutating store boundary.
		const sanitized = auditValue(normalized, rules, `targets[${targetIndex}]`, limits, redact)
		if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) throw new Error('Audit redaction rules must preserve targets.')
		const safe = plainObject(sanitized, 'redacted target', targetFields) as unknown as AuditTarget
		const entityType = requireString(safe.entityType, 'target.entityType')
		const entityId = requireString(safe.entityId, 'target.entityId')
		const workspaceId = optionalString(safe.workspaceId, 'target.workspaceId')
		const tenantId = optionalString(safe.tenantId, 'target.tenantId')
		const resource = optionalString(safe.resource, 'target.resource', limits.maxStringLength)
		const displayName = optionalString(safe.displayName, 'target.displayName', limits.maxStringLength)
		const auditedTarget: AuditTarget = {
			entityType,
			entityId,
			...(workspaceId ? {workspaceId} : {}),
			...(tenantId ? {tenantId} : {}),
			...(resource ? {resource} : {}),
			...(displayName ? {displayName} : {}),
			...(safe.metadata !== undefined ? {metadata: jsonObject(safe.metadata, [], 'targets.metadata', limits, false)} : {})
		}
		return auditedTarget
	})
	return auditedTargets
}

export function normalizeChangeSet(
	value: unknown,
	rules: ReadonlyArray<AuditRedactionRule>,
	limits: AuditSafetyLimits,
	redact = true
): AuditChangeSet | undefined {
	if (value === undefined) return undefined
	const change = plainObject(value, 'changeSet', changeSetFields) as unknown as AuditChangeSet
	const changedFields = change.changedFields === undefined
		? undefined
		: plainArray(change.changedFields, 'changeSet.changedFields', limits.maxArrayEntries)
	if (changedFields?.some((field) => typeof field !== 'string')) {
		throw new Error('Audit changeSet.changedFields must be a bounded array of strings.')
	}
	const initialSummary = optionalString(change.summary, 'changeSet.summary', limits.maxStringLength)
	const sanitized = auditValue({
		...(change.before !== undefined ? {before: plainObject(change.before, 'changeSet.before')} : {}),
		...(change.after !== undefined ? {after: plainObject(change.after, 'changeSet.after')} : {}),
		...(changedFields ? {changedFields: changedFields.map((field) => requireString(field, 'changeSet.changedFields', limits.maxStringLength))} : {}),
		...(initialSummary ? {summary: initialSummary} : {})
	}, rules, 'changeSet', limits, redact)
	if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
		throw new Error('Audit redaction rules produced an invalid changeSet.')
	}
	const safe = plainObject(sanitized, 'redacted changeSet', changeSetFields) as unknown as AuditChangeSet
	const safeChangedFields = safe.changedFields === undefined
		? undefined
		: plainArray(safe.changedFields, 'changeSet.changedFields', limits.maxArrayEntries)
	if (safeChangedFields?.some((field) => typeof field !== 'string')) {
		throw new Error('Audit changeSet.changedFields must be a bounded array of strings.')
	}
	const summary = optionalString(safe.summary, 'changeSet.summary', limits.maxStringLength)
	return {
		...(safe.before !== undefined ? {before: jsonObject(safe.before, [], 'changeSet.before', limits, false)} : {}),
		...(safe.after !== undefined ? {after: jsonObject(safe.after, [], 'changeSet.after', limits, false)} : {}),
		...(safeChangedFields ? {changedFields: safeChangedFields.map((field) => requireString(field, 'changeSet.changedFields', limits.maxStringLength))} : {}),
		...(summary ? {summary} : {})
	}
}

export function normalizeCorrelation(
	value: unknown,
	rules: ReadonlyArray<AuditRedactionRule>,
	limits: AuditSafetyLimits,
	redact = true
): AuditCorrelation {
	if (value === undefined) return {}
	const correlation = plainObject(value, 'correlation', correlationFields) as unknown as AuditCorrelation
	let resource: AuditCorrelation['resource']
	if (correlation.resource !== undefined) {
		const source = plainObject(correlation.resource, 'correlation.resource', resourceFields)
		const serviceVersion = optionalString(source.serviceVersion, 'correlation.resource.serviceVersion')
		const deploymentEnvironment = optionalString(source.deploymentEnvironment, 'correlation.resource.deploymentEnvironment')
		const hostKind = optionalString(source.hostKind, 'correlation.resource.hostKind')
		const runtime = optionalString(source.runtime, 'correlation.resource.runtime')
		resource = {
			serviceName: requireString(source.serviceName, 'correlation.resource.serviceName'),
			...(serviceVersion ? {serviceVersion} : {}),
			...(deploymentEnvironment ? {deploymentEnvironment} : {}),
			...(hostKind ? {hostKind} : {}),
			...(runtime ? {runtime} : {}),
			...(source.attributes !== undefined ? {attributes: jsonObject(source.attributes, [], 'correlation.resource.attributes', limits, false)} : {})
		}
	}
	const initialRequestId = optionalString(correlation.requestId, 'correlation.requestId')
	const initialCorrelationId = optionalString(correlation.correlationId, 'correlation.correlationId')
	const initialTraceId = optionalString(correlation.traceId, 'correlation.traceId')
	const initialSpanId = optionalString(correlation.spanId, 'correlation.spanId')
	const correlationHostKind = optionalString(correlation.hostKind, 'correlation.hostKind')
	const correlationRuntime = optionalString(correlation.runtime, 'correlation.runtime')
	const result: AuditCorrelation = {
		...(initialRequestId ? {requestId: initialRequestId} : {}),
		...(initialCorrelationId ? {correlationId: initialCorrelationId} : {}),
		...(initialTraceId ? {traceId: initialTraceId} : {}),
		...(initialSpanId ? {spanId: initialSpanId} : {}),
		...(correlationHostKind ? {hostKind: correlationHostKind} : {}),
		...(correlationRuntime ? {runtime: correlationRuntime} : {}),
		...(resource ? {resource} : {})
	}
	const sanitized = auditValue(result, rules, 'correlation', limits, redact) as unknown as AuditCorrelation
	if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) throw new Error('Audit redaction rules produced an invalid correlation object.')
	const safe = plainObject(sanitized, 'redacted correlation', correlationFields) as unknown as AuditCorrelation
	let safeResource: AuditCorrelation['resource']
	if (safe.resource !== undefined) {
		const source = plainObject(safe.resource, 'redacted correlation.resource', resourceFields)
		const serviceName = requireString(source.serviceName, 'correlation.resource.serviceName')
		const serviceVersion = optionalString(source.serviceVersion, 'correlation.resource.serviceVersion')
		const deploymentEnvironment = optionalString(source.deploymentEnvironment, 'correlation.resource.deploymentEnvironment')
		const hostKind = optionalString(source.hostKind, 'correlation.resource.hostKind')
		const runtime = optionalString(source.runtime, 'correlation.resource.runtime')
		safeResource = {
			serviceName,
			...(serviceVersion ? {serviceVersion} : {}),
			...(deploymentEnvironment ? {deploymentEnvironment} : {}),
			...(hostKind ? {hostKind} : {}),
			...(runtime ? {runtime} : {}),
			...(source.attributes !== undefined ? {attributes: jsonObject(source.attributes, [], 'correlation.resource.attributes', limits, false)} : {})
		}
	}
	const requestId = optionalString(safe.requestId, 'correlation.requestId')
	const correlationId = optionalString(safe.correlationId, 'correlation.correlationId')
	const traceId = optionalString(safe.traceId, 'correlation.traceId')
	const spanId = optionalString(safe.spanId, 'correlation.spanId')
	const hostKind = optionalString(safe.hostKind, 'correlation.hostKind')
	const runtime = optionalString(safe.runtime, 'correlation.runtime')
	return {
		...(requestId ? {requestId} : {}),
		...(correlationId ? {correlationId} : {}),
		...(traceId ? {traceId} : {}),
		...(spanId ? {spanId} : {}),
		...(hostKind ? {hostKind} : {}),
		...(runtime ? {runtime} : {}),
		...(safeResource ? {resource: safeResource} : {})
	}
}
