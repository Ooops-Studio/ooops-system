import type {AuditSafetyLimits} from './types/store'

export const AUDIT_MAXIMUM_LIMITS: AuditSafetyLimits = Object.freeze({
	maxBatchRecords: 500,
	maxBatchBytes: 16 * 1024 * 1024,
	maxRecordBytes: 1024 * 1024,
	maxTargets: 100,
	maxDepth: 8,
	maxObjectKeys: 100,
	maxArrayEntries: 100,
	maxStringLength: 16 * 1024
})

export const AUDIT_FLUSH_TIMEOUT_MS = 5_000
export const AUDIT_SHUTDOWN_TIMEOUT_MS = 10_000
export const AUDIT_MAX_ACTIVE_OPERATIONS = 1_000
export const AUDIT_MAX_PENDING_FLUSH_ATTEMPTS = 64
export const AUDIT_MAX_PENDING_SHUTDOWN_ATTEMPTS = 64
export const AUDIT_MAX_FUTURE_SKEW_MS = 5 * 60_000
export const AUDIT_QUERY_PAGE_SIZE = 500
// Keep the requested logical page limit independent from the physical
// PostgreSQL fetch. One additional record is fetched as the cursor lookahead,
// so reserve one max-sized record inside the 16 MiB batch envelope.
export const AUDIT_POSTGRES_RECORD_PAGE_SIZE = Math.max(
	1,
	Math.floor(AUDIT_MAXIMUM_LIMITS.maxBatchBytes / AUDIT_MAXIMUM_LIMITS.maxRecordBytes) - 1
)
export const AUDIT_EXPORT_MAX_RECORDS = 10_000
export const AUDIT_EXPORT_MAX_BYTES = 32 * 1024 * 1024
export const AUDIT_ARCHIVE_CHUNK_SIZE = 500
export const AUDIT_PRUNE_MAX_RECORDS = 10_000
export const AUDIT_PRUNE_MAX_BYTES = 32 * 1024 * 1024
export const AUDIT_PRUNE_MAX_SCANNED_PARTITIONS = 10_000
