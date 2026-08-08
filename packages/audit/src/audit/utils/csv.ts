import type {AuditRecord} from '@ooopsstudio/core/contracts/audit'

function escapeCell(value: unknown): string {
	let text = value == null ? '' : String(value)
	// Spreadsheet applications evaluate leading formula markers even in quoted CSV cells.
	if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = `'${text}`
	if (!text.includes(',') && !text.includes('"') && !text.includes('\n') && !text.includes('\r')) return text
	return `"${text.replaceAll('"', '""')}"`
}

function toTargetLabel(record: AuditRecord): string {
	return record.targets.map((target) => `${target.entityType}:${target.entityId}`).join('|')
}

export function formatAuditRecordsAsCsv(records: ReadonlyArray<AuditRecord>): string {
	const header = [
		'id',
		'occurredAt',
		'eventType',
		'category',
		'action',
		'outcome',
		'sensitivity',
		'actorKind',
		'actorId',
		'targets',
		'workspaceId',
		'tenantId',
		'summary',
		'partitionKey',
		'sequence',
		'hash'
	]
	const rows = records.map((record) => [
		record.id,
		record.occurredAt,
		record.eventType,
		record.category,
		record.action,
		record.outcome,
		record.sensitivity,
		record.actor.kind,
		record.actor.id ?? '',
		toTargetLabel(record),
		record.workspaceId ?? '',
		record.tenantId ?? '',
		record.summary ?? '',
		record.integrity.partitionKey,
		record.integrity.sequence,
		record.integrity.hash
	].map(escapeCell).join(','))
	return [header.join(','), ...rows].join('\n')
}
