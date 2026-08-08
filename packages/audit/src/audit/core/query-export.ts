import type {AuditExportRequest, AuditExportResult, AuditRecord} from '@ooopsstudio/core/contracts/audit'

import {AUDIT_EXPORT_MAX_BYTES, AUDIT_EXPORT_MAX_RECORDS, AUDIT_QUERY_PAGE_SIZE} from '../constants'
import type {AuditRedactionRule, AuditSafetyLimits, AuditStore} from '../types/store'
import {formatAuditRecordsAsCsv} from '../utils/csv'

import {normalizeAuditQuery, validateAuditPage} from './handler-support'

function contentType(format: AuditExportRequest['format']): string {
	return format === 'csv' ? 'text/csv; charset=utf-8' : format === 'ndjson' ? 'application/x-ndjson' : 'application/json; charset=utf-8'
}

function serializeRecord(record: AuditRecord, format: AuditExportRequest['format'], first: boolean): string {
	if (format === 'json') return `${first ? '[' : ','}${JSON.stringify(record)}`
	if (format === 'ndjson') return `${JSON.stringify(record)}\n`
	const csv = formatAuditRecordsAsCsv([record])
	const newline = csv.indexOf('\n')
	const row = csv.slice(newline + 1)
	return `${first ? formatAuditRecordsAsCsv([]) : ''}\n${row}`
}

function snapshotExportRequest(value: AuditExportRequest): AuditExportRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Audit export request is invalid.')
	const allowed = new Set(['query', 'format', 'chunkSize', 'maxRecords'])
	const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || !allowed.has(key)) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			snapshot[key] = descriptor.value
		}
	} catch { throw new Error('Audit export request must be a readable plain object with known fields.') }
	return snapshot as unknown as AuditExportRequest
}

export async function exportAuditRecords(
	store: AuditStore,
	request: AuditExportRequest,
	limits: AuditSafetyLimits,
	rules: ReadonlyArray<AuditRedactionRule> = [],
	now: () => number = Date.now
): Promise<AuditExportResult> {
	const input = snapshotExportRequest(request)
	const query = normalizeAuditQuery(input.query)
	if (query.limit !== undefined) throw new Error('Audit export uses maxRecords instead of query.limit.')
	if (!['json', 'ndjson', 'csv'].includes(input.format)) throw new Error('Audit export format is invalid.')
	const chunkSize = input.chunkSize ?? AUDIT_QUERY_PAGE_SIZE
	if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > AUDIT_QUERY_PAGE_SIZE) throw new Error(`Audit export chunkSize must be between 1 and ${AUDIT_QUERY_PAGE_SIZE}.`)
	const maxRecords = input.maxRecords ?? AUDIT_EXPORT_MAX_RECORDS
	if (!Number.isInteger(maxRecords) || maxRecords <= 0 || maxRecords > AUDIT_EXPORT_MAX_RECORDS) throw new Error(`Audit export maxRecords must be between 1 and ${AUDIT_EXPORT_MAX_RECORDS}.`)
	let cursor = query.cursor
	const chunks: Array<{index: number; content: string}> = []
	let totalRecords = 0
	let totalBytes = 0
	let pendingChunk = ''
	let pendingRecords = 0
	const seenRecordIds = new Set<string>()
	const commitChunk = () => {
		if (!pendingChunk) return
		chunks.push({index: chunks.length, content: pendingChunk})
		pendingChunk = ''
		pendingRecords = 0
	}
	while (totalRecords < maxRecords) {
		const pageLimit = Math.min(AUDIT_QUERY_PAGE_SIZE, maxRecords - totalRecords)
		const pageQuery = Object.freeze({...query, ...(cursor ? {cursor} : {}), limit: pageLimit})
		const page = validateAuditPage(await store.query(pageQuery), pageLimit, pageQuery, limits, rules, now())
		for (const record of page.items) {
			if (seenRecordIds.has(record.id)) throw new Error('Audit export store repeated a record id across pages.')
			seenRecordIds.add(record.id)
			if (pendingRecords === chunkSize) commitChunk()
			const content = serializeRecord(record, input.format, totalRecords === 0)
			const bytes = Buffer.byteLength(content)
			const jsonTerminatorBytes = input.format === 'json' ? 1 : 0
			if (totalBytes + bytes + jsonTerminatorBytes > AUDIT_EXPORT_MAX_BYTES) throw new Error(`Audit export exceeds the ${AUDIT_EXPORT_MAX_BYTES} byte limit.`)
			pendingChunk += content
			pendingRecords += 1
			totalBytes += bytes
			totalRecords += 1
		}
		if (!page.nextCursor || totalRecords >= maxRecords) break
		cursor = page.nextCursor
	}
	commitChunk()
	if (input.format === 'json') {
		if (chunks.length === 0) chunks.push({index: 0, content: '[]'})
		else chunks[chunks.length - 1] = {...chunks.at(-1)!, content: chunks.at(-1)!.content + ']'}
		totalBytes += chunks.length === 1 && chunks[0]!.content === '[]' ? 2 : 1
	} else if (input.format === 'csv' && chunks.length === 0) {
		const content = formatAuditRecordsAsCsv([])
		chunks.push({index: 0, content})
		totalBytes = Buffer.byteLength(content)
	}
	return {format: input.format, contentType: contentType(input.format), totalRecords, totalBytes, chunks}
}
