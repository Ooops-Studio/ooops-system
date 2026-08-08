export interface AuditCursorValue {
	occurredAt: string
	id: string
}

/** Matches PostgreSQL's explicit C collation for deterministic text ordering. */
export function compareAuditText(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/** ISO strings are not lexicographically ordered across the four-to-expanded-year boundary. */
export function compareAuditTimestamps(left: string, right: string): number {
	return Date.parse(left) - Date.parse(right)
}

/** Matches PostgreSQL's explicit C collation for deterministic cursor ordering. */
export function compareAuditCursorValues(left: AuditCursorValue, right: AuditCursorValue): number {
	const timestamp = compareAuditTimestamps(left.occurredAt, right.occurredAt)
	return timestamp || compareAuditText(left.id, right.id)
}

export function resolveAuditQueryLimit(value: number | undefined, fallback: number, maximum = 500): number {
	const resolved = value ?? fallback
	if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
		throw new Error(`Audit query limit must be an integer between 1 and ${maximum}.`)
	}
	return resolved
}

export function assertAuditSort(value: unknown): asserts value is 'asc' | 'desc' | undefined {
	if (value !== undefined && value !== 'asc' && value !== 'desc') {
		throw new Error('Audit query sort must be "asc" or "desc".')
	}
}

export function assertAuditPruneLimit(value: number | undefined, maximum = 10_000): void {
	if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > maximum)) {
		throw new Error(`Audit prune limit must be an integer between 1 and ${maximum}.`)
	}
}

export function assertAuditIsoTimestamp(value: unknown, field: string): asserts value is string | undefined {
	if (value === undefined) return
	if (typeof value !== 'string' || value.length > 64 || !isAuditSafeString(value)) throw new Error(`Audit ${field} must be an ISO timestamp.`)
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new Error(`Audit ${field} must be an ISO timestamp.`)
	}
}

export function decodeAuditCursor(cursor: unknown): AuditCursorValue | undefined {
	if (cursor === undefined) return undefined
	if (typeof cursor !== 'string' || !cursor || cursor !== cursor.trim() || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
		throw new Error('Audit cursor is invalid.')
	}
	if (cursor.length > 4096) throw new Error('Audit cursor is invalid.')
	let decoded: unknown
	try {
		const bytes = Buffer.from(cursor, 'base64url')
		if (bytes.toString('base64url') !== cursor) throw new Error()
		decoded = JSON.parse(bytes.toString('utf8')) as unknown
	} catch {
		throw new Error('Audit cursor is invalid.')
	}
	if (
		!decoded
		|| typeof decoded !== 'object'
		|| Array.isArray(decoded)
		|| Object.getPrototypeOf(decoded) !== Object.prototype
		|| Reflect.ownKeys(decoded).some((key) => key !== 'occurredAt' && key !== 'id')
		|| typeof (decoded as AuditCursorValue).occurredAt !== 'string'
		|| typeof (decoded as AuditCursorValue).id !== 'string'
	) {
		throw new Error('Audit cursor is invalid.')
	}
	const value = decoded as AuditCursorValue
	assertAuditIsoTimestamp(value.occurredAt, 'cursor.occurredAt')
	if (!value.id.trim() || value.id !== value.id.trim() || value.id.length > 512 || !isAuditSafeString(value.id)) throw new Error('Audit cursor is invalid.')
	return value
}
import {isAuditSafeString} from './string-safety'
