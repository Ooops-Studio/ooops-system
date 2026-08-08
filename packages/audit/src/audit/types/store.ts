import type {
	AuditChangeSet,
	AuditPage,
	AuditQuery,
	AuditRecord,
	AuditStoreRetentionResult,
	AuditVerificationFilter,
	AuditVerificationResult
} from '@ooopsstudio/core/contracts/audit'
import type {JsonObject} from '@ooopsstudio/core/contracts/json'

export interface AuditKeyRedactionRule {
	readonly key: string | RegExp
	readonly action: 'mask' | 'drop' | 'hash'
}

export interface AuditPathRedactionRule {
	readonly path: readonly (string | number)[]
	readonly action: 'mask' | 'drop' | 'hash'
}

export type AuditRedactionRule = AuditKeyRedactionRule | AuditPathRedactionRule

export interface AuditSerializationLimits {
	readonly maxBatchRecords: number
	readonly maxBatchBytes: number
	readonly maxRecordBytes: number
	readonly maxTargets: number
	readonly maxDepth: number
	readonly maxObjectKeys: number
	readonly maxArrayEntries: number
	readonly maxStringLength: number
}

/** Internal name retained while subsystem files remain independently layered. */
export type AuditSafetyLimits = AuditSerializationLimits

export interface PreparedAuditRecord extends Omit<AuditRecord, 'integrity'> {
	readonly partitionKey: string
	readonly context: JsonObject
	readonly metadata: JsonObject
	readonly changeSet?: AuditChangeSet
	readonly idempotencyHash?: string
	readonly semanticFingerprint?: string
}

export interface AuditAppendResult {
	readonly record: AuditRecord
	readonly inserted: boolean
}

export interface AuditArchiveChunkRequest {
	readonly planId: string
	readonly chunkIndex: number
	readonly records: ReadonlyArray<AuditRecord>
}

export interface AuditArchiveSink {
	archive(request: AuditArchiveChunkRequest): Promise<number>
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}

export interface AuditPrunePartitionAnchor {
	readonly partitionKey: string
	readonly count: number
	readonly firstRecordId: string
	readonly firstHash: string
	readonly lastRecordId: string
	readonly lastHash: string
}

export interface AuditPrunePlan {
	readonly planId: string
	readonly before: string
	readonly partitionKeys: ReadonlyArray<string>
	readonly records: ReadonlyArray<AuditRecord>
	readonly anchors: ReadonlyArray<AuditPrunePartitionAnchor>
}

export interface AuditStore {
	readonly kind: string
	appendMany(records: ReadonlyArray<PreparedAuditRecord>): Promise<ReadonlyArray<AuditAppendResult>> | ReadonlyArray<AuditAppendResult>
	getById(id: string): Promise<AuditRecord | undefined> | AuditRecord | undefined
	query(query?: AuditQuery): Promise<AuditPage> | AuditPage
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}

export interface TransactionalAuditStore {
	appendTransactional(
		transaction: unknown,
		records: ReadonlyArray<PreparedAuditRecord>
	): Promise<ReadonlyArray<AuditAppendResult>> | ReadonlyArray<AuditAppendResult>
}

export interface AuditAdminStore {
	verifyIntegrity(filter?: AuditVerificationFilter): Promise<AuditVerificationResult> | AuditVerificationResult
	planPruneBefore(before: string, limit: number): Promise<AuditPrunePlan> | AuditPrunePlan
	prunePlanned(plan: AuditPrunePlan): Promise<AuditStoreRetentionResult> | AuditStoreRetentionResult
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}

/** Built-in stores that expose read/write plus privileged administration. */
export type AdminCapableAuditStore = AuditStore & AuditAdminStore

/** Internal composition used by the built-in stores. */
export type CompleteAuditStore = AdminCapableAuditStore & TransactionalAuditStore
