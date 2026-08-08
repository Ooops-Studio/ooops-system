import type {
	AuditExportOptions,
	AuditExportResult,
	AuditQueryResult,
	AuditPruneOptions,
	AuditPruneResult,
	AuditQuery,
	AuditRecord,
	AuditIntegrityVerificationOptions,
	AuditIntegrityVerificationResult,
	AuditWriteRequest
} from '../contracts/audit'

export type AuditRuntimeState = 'running' | 'draining' | 'closed'

export interface AuditStatus {
	readonly state: AuditRuntimeState
	readonly activeOperations: number
	readonly lastFailureCode?: string
}

export interface AuditPort {
	record(request: AuditWriteRequest): Promise<AuditRecord>
	recordMany(requests: ReadonlyArray<AuditWriteRequest>): Promise<ReadonlyArray<AuditRecord>>
	getById(id: string): Promise<AuditRecord | undefined>
	query(query: AuditQuery): Promise<AuditQueryResult>
}

export interface ManagedAudit extends AuditPort {
	getStatus(): AuditStatus
	flush(): Promise<void>
	shutdown(): Promise<void>
}

export interface TransactionalAuditPort {
	recordTransactional(transaction: unknown, requests: ReadonlyArray<AuditWriteRequest>): Promise<ReadonlyArray<AuditRecord>>
}

export interface AuditAdminPort {
	export(options: AuditExportOptions): Promise<AuditExportResult>
	verifyIntegrity(options?: AuditIntegrityVerificationOptions): Promise<AuditIntegrityVerificationResult>
	pruneBefore(cutoff: number, options?: AuditPruneOptions): Promise<AuditPruneResult>
}

export interface AuditRuntime {
	readonly audit: ManagedAudit
	readonly transactional?: TransactionalAuditPort
	readonly admin?: AuditAdminPort
}
