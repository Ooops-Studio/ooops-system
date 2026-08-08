import type {AuditRecord} from '@ooopsstudio/core/contracts/audit'

import {AUDIT_ARCHIVE_CHUNK_SIZE} from '../constants'
import type {AuditArchiveSink} from '../types/store'

export interface AuditArchivePlan {
	readonly planId: string
	readonly records: ReadonlyArray<AuditRecord>
}

/** Custom-only archive delivery, intentionally excluded from standard presets. */
export async function archiveAuditPlan(
	sink: AuditArchiveSink,
	plan: AuditArchivePlan
): Promise<number> {
	let archivedCount = 0
	for (let offset = 0; offset < plan.records.length; offset += AUDIT_ARCHIVE_CHUNK_SIZE) {
		const records = plan.records.slice(offset, offset + AUDIT_ARCHIVE_CHUNK_SIZE)
		const accepted = await sink.archive({
			planId: plan.planId,
			chunkIndex: offset / AUDIT_ARCHIVE_CHUNK_SIZE,
			records: structuredClone(records)
		})
		if (!Number.isSafeInteger(accepted) || accepted !== records.length) {
			throw new Error('Audit archive sink returned an invalid accepted record count.')
		}
		archivedCount += accepted
	}
	return archivedCount
}
