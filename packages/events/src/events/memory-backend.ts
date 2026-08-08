import type {EventDeadLetterSummary, EventDeliveryStatus, EventOutboxSummary, EventReplayRequest} from '@ooopsstudio/core/contracts/events'

import {inputField, isolateInputFields} from './safe-input'
import type {EventsBackend, StoredEventRecord} from './types'

const clone = <T>(value: T): T => structuredClone(value)

export interface MemoryEventsBackendOptions {readonly maxRecords?: number; readonly maxBytes?: number}

export function createMemoryEventsBackend(options: MemoryEventsBackendOptions = {}): EventsBackend {
	isolateInputFields(options, ['maxRecords', 'maxBytes'])
	const maximum = (inputField(options, 'maxRecords', 'EVENTS_BACKEND_OPTIONS_INVALID') ?? 10_000) as number
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50_000) throw new Error('EVENTS_BACKEND_OPTIONS_INVALID')
	const maximumBytes = (inputField(options, 'maxBytes', 'EVENTS_BACKEND_OPTIONS_INVALID') ?? 64_000_000) as number
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1_000_000 || maximumBytes > 512_000_000) {
		throw new Error('EVENTS_BACKEND_OPTIONS_INVALID')
	}
	const records = new Map<string, StoredEventRecord>()
	const recordBytes = new Map<string, number>()
	let usedBytes = 0
	const inbox = new Map<string, {eventId: string; owner: string; expiresAt: number; complete: boolean}>()
	const inboxBytes = new Map<string, number>()
	const inboxKey = (consumer: string, eventId: string): string => {
		if (consumer.length > 128 || eventId.length > 128) throw new Error('EVENTS_BACKEND_CAPACITY')
		return JSON.stringify([consumer, eventId])
	}
	const setInbox = (key: string, value: {eventId: string; owner: string; expiresAt: number; complete: boolean}): void => {
		if (value.owner.length > 256) throw new Error('EVENTS_BACKEND_CAPACITY')
		const previous = inboxBytes.get(key) ?? 0
		const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value))
		if (usedBytes - previous + bytes > maximumBytes) throw new Error('EVENTS_BACKEND_CAPACITY')
		inbox.set(key, value); inboxBytes.set(key, bytes); usedBytes += bytes - previous
	}
	const deleteInbox = (key: string): boolean => {
		if (!inbox.delete(key)) return false
		usedBytes -= inboxBytes.get(key) ?? 0; inboxBytes.delete(key); return true
	}
	const identity = (record: StoredEventRecord): string => JSON.stringify({
		envelope: record.envelope, payloadValidated: record.payloadValidated,
		binding: record.binding, traceContext: record.traceContext, expiresAt: record.expiresAt
	})
	const limit = (value: number | undefined, fallback = 100): number => {
		const result = value ?? fallback
		if (!Number.isSafeInteger(result) || result < 1 || result > 1_000) throw new Error('EVENTS_ADMIN_INPUT_INVALID')
		return result
	}
	const set = (record: StoredEventRecord): void => {
		const id = record.envelope.id; const previous = recordBytes.get(id) ?? 0
		const bytes = Buffer.byteLength(JSON.stringify(record))
		if ((!records.has(id) && records.size >= maximum) || usedBytes - previous + bytes > maximumBytes) throw new Error('EVENTS_BACKEND_CAPACITY')
		const snapshot = clone(record)
		records.set(id, snapshot); recordBytes.set(id, bytes); usedBytes += bytes - previous
	}
	const summary = (record: StoredEventRecord): EventOutboxSummary => Object.freeze({
		eventId: record.envelope.id, type: record.envelope.type, status: record.status,
		attempts: record.attempts, createdAt: new Date(record.createdAt).toISOString(),
		updatedAt: new Date(record.updatedAt).toISOString(),
		...(record.availableAt ? {availableAt: new Date(record.availableAt).toISOString()} : {}),
		...(record.failureCode ? {failureCode: record.failureCode} : {})
	})
	const outbox = {
		async append(batch: readonly StoredEventRecord[]): Promise<void> {
			if (!Array.isArray(batch) || batch.length > 1_000) throw new Error('EVENTS_BATCH_TOO_LARGE')
			const additions = new Map<string, StoredEventRecord>()
			for (const record of batch) {
				const existing = records.get(record.envelope.id)
				if (existing && identity(existing) !== identity(record)) throw new Error('EVENTS_IDEMPOTENCY_CONFLICT')
				const pending = additions.get(record.envelope.id)
				if (pending && identity(pending) !== identity(record)) throw new Error('EVENTS_IDEMPOTENCY_CONFLICT')
				if (!existing && !pending) additions.set(record.envelope.id, record)
			}
			if (records.size + additions.size > maximum) throw new Error('EVENTS_BACKEND_CAPACITY')
			const snapshots = [...additions.values()].map(clone)
			const additionBytes = snapshots.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0)
			if (usedBytes + additionBytes > maximumBytes) throw new Error('EVENTS_BACKEND_CAPACITY')
			for (const record of snapshots) set(record)
		},
		async claimDue({now, limit, owner, leaseMs}: {now: number; limit: number; owner: string; leaseMs: number}): Promise<readonly StoredEventRecord[]> {
			const due = [...records.values()].filter((record) => {
				if (record.expiresAt !== undefined && record.expiresAt <= now) return false
				return ((record.status === 'queued' || record.status === 'failed') && record.availableAt <= now)
					|| (record.status === 'dispatching' && (record.lease?.expiresAt ?? 0) <= now)
			}).sort((a, b) => a.availableAt - b.availableAt).slice(0, Math.min(1_000, limit))
			const claimed = due.map((record) => ({...record, status: 'dispatching' as const, attempts: record.attempts + 1, updatedAt: now,
				lease: {owner, expiresAt: now + leaseMs, generation: (record.lease?.generation ?? 0) + 1}}))
			const growth = claimed.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)) - (recordBytes.get(record.envelope.id) ?? 0), 0)
			if (usedBytes + growth > maximumBytes) throw new Error('EVENTS_BACKEND_CAPACITY')
			for (const record of claimed) set(record)
			return clone(claimed)
		},
		async renew(eventId: string, owner: string, generation: number, expiresAt: number): Promise<boolean> {
			const record = records.get(eventId); if (!record || record.lease?.owner !== owner || record.lease.generation !== generation) return false
			set({...record, lease: {...record.lease, expiresAt}}); return true
		},
		async complete(eventId: string, owner: string, generation: number): Promise<boolean> {
			const record = records.get(eventId); if (!record || record.lease?.owner !== owner || record.lease.generation !== generation) return false
			set({...record, status: 'dispatched', updatedAt: Date.now(), lease: undefined, failureCode: undefined}); return true
		},
		async retry(eventId: string, owner: string, generation: number, availableAt: number, failureCode: string): Promise<boolean> {
			const record = records.get(eventId); if (!record || record.lease?.owner !== owner || record.lease.generation !== generation) return false
			set({...record, status: 'failed', availableAt, updatedAt: Date.now(), lease: undefined, failureCode}); return true
		},
		async deadLetter(eventId: string, owner: string, generation: number, failureCode: string): Promise<boolean> {
			const record = records.get(eventId); if (!record || record.lease?.owner !== owner || record.lease.generation !== generation) return false
			set({...record, status: 'dead', updatedAt: Date.now(), lease: undefined, failureCode}); return true
		},
		async purgeExpired(now: number, limit: number): Promise<number> {
			const purgedIds = new Set<string>(); for (const [id, record] of records) { if (purgedIds.size >= limit) break; if (record.expiresAt !== undefined && record.expiresAt <= now && (record.status !== 'dispatching' || (record.lease?.expiresAt ?? 0) <= now)) { records.delete(id); usedBytes -= recordBytes.get(id) ?? 0; recordBytes.delete(id); purgedIds.add(id) } } if (purgedIds.size) for (const [key, value] of inbox) if (purgedIds.has(value.eventId)) deleteInbox(key); return purgedIds.size
		},
		async queuedCount(): Promise<number> { return [...records.values()].filter((record) => ['queued', 'failed', 'dispatching'].includes(record.status)).length }
	}
	const admin = {
		async replay(request: EventReplayRequest, now: number): Promise<number> { const maximum = limit(request.limit); const from = request.from ? Date.parse(request.from) : undefined; const to = request.to ? Date.parse(request.to) : undefined; if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) throw new Error('EVENTS_ADMIN_INPUT_INVALID'); const replayed = new Set<string>(); for (const record of records.values()) { if (request.eventId && request.eventId !== record.envelope.id) continue; if (request.type && request.type !== record.envelope.type) continue; if (from !== undefined && record.createdAt < from) continue; if (to !== undefined && record.createdAt > to) continue; if (!['dead', 'dispatched', 'cancelled'].includes(record.status)) continue; set({...record, status: 'queued', attempts: 0, availableAt: now, updatedAt: now, failureCode: undefined, lease: undefined}); replayed.add(record.envelope.id); if (replayed.size >= maximum) break } if (replayed.size) for (const [key, value] of inbox) if (replayed.has(value.eventId)) deleteInbox(key); return replayed.size },
		async retryDeadLetter(eventId: string, now: number): Promise<boolean> { const record = records.get(eventId); if (record?.status !== 'dead') return false; set({...record, status: 'queued', attempts: 0, availableAt: now, updatedAt: now, failureCode: undefined}); return true },
		async cancelScheduled(eventId: string, now: number): Promise<boolean> { const record = records.get(eventId); if (!record || !['queued', 'failed'].includes(record.status)) return false; set({...record, status: 'cancelled', updatedAt: now}); return true },
		async listOutbox(options?: {status?: EventDeliveryStatus; type?: string; limit?: number}): Promise<readonly EventOutboxSummary[]> { return Object.freeze([...records.values()].filter((r) => (!options?.status || r.status === options.status) && (!options?.type || r.envelope.type === options.type)).slice(0, limit(options?.limit)).map(summary)) },
		async listDeadLetters(inputLimit = 100): Promise<readonly EventDeadLetterSummary[]> { return Object.freeze([...records.values()].filter((r) => r.status === 'dead').slice(0, limit(inputLimit)).map((r) => Object.freeze({eventId: r.envelope.id, type: r.envelope.type, attempts: r.attempts, failedAt: new Date(r.updatedAt).toISOString(), failureCode: r.failureCode ?? 'EVENTS_DELIVERY_FAILURE'}))) },
		async purgeExpired(now: number, limit: number): Promise<number> { return outbox.purgeExpired(now, limit) }
	}
	return {durability: 'ephemeral', outbox, inbox: {
		async claim({consumer, eventId, owner, expiresAt, now}) { const key = inboxKey(consumer, eventId); const value = inbox.get(key); if (value?.complete) return 'duplicate'; if (value && value.expiresAt > (now ?? Date.now())) return 'busy'; setInbox(key, {eventId, owner, expiresAt, complete: false}); return 'claimed' },
		async renew({consumer, eventId, owner, expiresAt}) { const key = inboxKey(consumer, eventId); const value = inbox.get(key); if (!value || value.owner !== owner || value.complete) return false; setInbox(key, {...value, expiresAt}); return true },
		async complete({consumer, eventId, owner}) { const key = inboxKey(consumer, eventId); const value = inbox.get(key); if (!value || value.owner !== owner) return false; setInbox(key, {...value, complete: true}); return true },
		async release({consumer, eventId, owner}) { const key = inboxKey(consumer, eventId); const value = inbox.get(key); if (!value || value.owner !== owner || value.complete) return false; return deleteInbox(key) }
	}, admin}
}
