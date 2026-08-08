import type {JsonObject} from './json'
import type {ObservabilityResource} from './observability-shared'

export type AuditActorKind = 'user' | 'service' | 'system' | 'anonymous' | 'worker'
export type AuditOutcome = 'attempted' | 'succeeded' | 'failed' | 'denied'
export type AuditSensitivity = 'low' | 'moderate' | 'high' | 'restricted'
export type AuditExportFormat = 'ndjson' | 'csv' | 'json'
export type AuditIntegrityAlgorithm = 'sha256-stable-json-v1'

export interface AuditActor {
	readonly kind: AuditActorKind
	readonly id?: string
	readonly displayName?: string
	readonly email?: string
	readonly workspaceId?: string
	readonly tenantId?: string
	readonly metadata?: JsonObject
}

export type AuditWriteActor = Omit<AuditActor, 'email'>

export interface AuditTarget {
	readonly entityType: string
	readonly entityId: string
	readonly workspaceId?: string
	readonly tenantId?: string
	readonly resource?: string
	readonly displayName?: string
	readonly metadata?: JsonObject
}

export interface AuditChangeSet {
	readonly before?: JsonObject
	readonly after?: JsonObject
	readonly changedFields?: ReadonlyArray<string>
	readonly summary?: string
}

export interface AuditCorrelation {
	readonly requestId?: string
	readonly correlationId?: string
	readonly traceId?: string
	readonly spanId?: string
	readonly hostKind?: string
	readonly runtime?: string
	readonly resource?: ObservabilityResource
}

export type AuditWriteCorrelation = Pick<
	AuditCorrelation,
	'requestId' | 'correlationId' | 'traceId' | 'spanId'
>

export interface AuditIntegrity {
	readonly partitionKey: string
	readonly sequence: number
	readonly prevHash: string | null
	readonly hash: string
	readonly algorithm: AuditIntegrityAlgorithm
}

export interface AuditWriteRequest {
	readonly idempotencyKey?: string
	readonly eventType: string
	readonly category: string
	readonly action: string
	readonly actor: AuditWriteActor
	readonly target?: AuditTarget
	readonly targets?: ReadonlyArray<AuditTarget>
	readonly outcome: AuditOutcome
	readonly sensitivity: AuditSensitivity
	readonly summary?: string
	readonly workspaceId?: string
	readonly tenantId?: string
	readonly correlation?: AuditWriteCorrelation
	readonly metadata?: JsonObject
	readonly changeSet?: AuditChangeSet
}

export type AuditRecord = Omit<AuditWriteRequest, 'idempotencyKey' | 'target' | 'actor' | 'correlation'> & {
	readonly id: string
	readonly occurredAt: string
	readonly createdAt: string
	readonly actor: AuditActor
	readonly targets: ReadonlyArray<AuditTarget>
	readonly correlation: AuditCorrelation
	readonly context: JsonObject
	readonly metadata: JsonObject
	/** Persisted v1 compatibility field. New writes do not control it. */
	readonly stream?: string
	readonly integrity: AuditIntegrity
}

export interface AuditQuery {
	readonly cursor?: string
	readonly limit?: number
	readonly sort?: 'asc' | 'desc'
	readonly from?: string
	readonly to?: string
	readonly eventType?: string
	readonly category?: string
	readonly action?: string
	readonly outcome?: AuditOutcome | ReadonlyArray<AuditOutcome>
	readonly actorKind?: AuditActorKind
	readonly actorId?: string
	readonly targetEntityType?: string
	readonly targetEntityId?: string
	readonly workspaceId?: string
	readonly tenantId?: string
	readonly sensitivity?: AuditSensitivity | ReadonlyArray<AuditSensitivity>
	readonly partitionKey?: string
}

export interface AuditPage {
	readonly items: ReadonlyArray<AuditRecord>
	readonly nextCursor?: string
}

export type AuditQueryResult = AuditPage

export interface AuditExportRequest {
	readonly query?: AuditQuery
	readonly format: AuditExportFormat
	readonly chunkSize?: number
	readonly maxRecords?: number
}

export type AuditExportOptions = AuditExportRequest

export interface AuditExportChunk {
	readonly index: number
	readonly content: string
}

export interface AuditExportResult {
	readonly format: AuditExportFormat
	readonly contentType: string
	readonly totalRecords: number
	readonly totalBytes: number
	readonly chunks: ReadonlyArray<AuditExportChunk>
}

export interface AuditVerificationFilter {
	readonly partitionKey?: string
	readonly from?: string
	readonly to?: string
}

export type AuditIntegrityVerificationOptions = AuditVerificationFilter

export interface AuditVerificationResult {
	readonly ok: boolean
	readonly checkedCount: number
	readonly partitionKey?: string
	readonly brokenAtRecordId?: string
	readonly brokenAtSequence?: number
	readonly affectedRecordIds: ReadonlyArray<string>
}

export type AuditIntegrityVerificationResult = AuditVerificationResult

export interface AuditPruneRequest {
	readonly before: string
	readonly limit?: number
	readonly archive?: boolean
}

export type AuditPruneOptions = Omit<AuditPruneRequest, 'before'>

export interface AuditStoreRetentionResult {
	readonly deletedCount: number
	readonly archivedCount?: number
}

export type AuditPruneResult = AuditStoreRetentionResult
