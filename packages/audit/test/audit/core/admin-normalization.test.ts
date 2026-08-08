import type {AuditWriteRequest} from '@ooopsstudio/core/contracts/audit'
import {describe, expect, it, vi} from 'vitest'

import {createAuditHandler} from '../../../src/audit/core/custom-handler'
import {buildAuditIntegrity, verifyAuditRecords} from '../../../src/audit/core/integrity'
import {normalizeAuditWriteRequest} from '../../../src/audit/core/write-normalization'
import {createMemoryAuditStore} from '../../../src/audit/features/stores/memory-store'
import {sanitizeAuditValue} from '../../../src/audit/utils/redaction'

const now = Date.parse('2024-01-01T00:00:00.000Z')
const clock = {now: () => now}
const write = (overrides: Partial<AuditWriteRequest> = {}): AuditWriteRequest => ({
	eventType: 'access.changed', category: 'access', action: 'change',
	actor: {kind: 'user', id: 'user'}, target: {entityType: 'resource', entityId: 'one'},
	outcome: 'succeeded', sensitivity: 'high', ...overrides
})

describe('audit admin and normalization', () => {
	it('applies mandatory and additive redaction without custom replacements', () => {
		const normalized = normalizeAuditWriteRequest(clock, {
			...write(), summary: 'token=secret', metadata: {email: 'a@b.com', private: 'value'}
		}, [{path: ['metadata', 'private'], action: 'hash'}], undefined, undefined, false)
		expect(normalized.summary).toBe('token=[REDACTED]')
		expect(normalized.metadata.email).toBe('[REDACTED]')
		expect(normalized.metadata.private).toMatch(/^\[HASH:[a-f0-9]{16}\]$/)
		expect(sanitizeAuditValue({secret: 'value'}, [{key: /^secret$/g, action: 'drop'}])).toEqual({})
	})

	it('builds and verifies the persisted v1 hash format', () => {
		const prepared = normalizeAuditWriteRequest(clock, write())
		const integrity = buildAuditIntegrity(prepared, {sequence: 1, prevHash: null})
		const {partitionKey: _partition, idempotencyHash: _idempotency, semanticFingerprint: _fingerprint, ...body} = prepared
		const record = {...body, integrity}
		expect(integrity.algorithm).toBe('sha256-stable-json-v1')
		expect(verifyAuditRecords([record])).toMatchObject({ok: true, checkedCount: 1})
		expect(verifyAuditRecords([{...record, action: 'tampered'}]).ok).toBe(false)
	})

	it('exposes admin only when a complete admin store is explicitly composed', async() => {
		const store = createMemoryAuditStore()
		const core = createAuditHandler({clock, store})
		expect(core.admin).toBeUndefined()
		const runtime = createAuditHandler({clock, store, adminStore: store})
		await runtime.audit.record(write())
		await expect(runtime.admin!.verifyIntegrity()).resolves.toMatchObject({ok: true, checkedCount: 1})
	})

	it('reports a missing whole integrity chain even when no surviving record was checked', async() => {
		const store = createMemoryAuditStore()
		const adminStore = {
			...store,
			verifyIntegrity: () => ({
				ok: false,
				checkedCount: 0,
				partitionKey: 'global:access:2024-01-01',
				brokenAtRecordId: 'deleted-only-record',
				brokenAtSequence: 1,
				affectedRecordIds: ['deleted-only-record']
			})
		}
		const runtime = createAuditHandler({clock, store, adminStore})

		await expect(runtime.admin!.verifyIntegrity()).resolves.toMatchObject({
			ok: false,
			checkedCount: 0,
			brokenAtRecordId: 'deleted-only-record'
		})
	})

	it('exports frozen bounded results and prunes complete sealed partitions', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock, store, adminStore: store})
		await runtime.audit.recordMany([write(), write({target: {entityType: 'resource', entityId: 'two'}})])
		const exported = await runtime.admin!.export({format: 'json', chunkSize: 1})
		expect(Object.isFrozen(exported)).toBe(true)
		expect(Object.isFrozen(exported.chunks)).toBe(true)
		expect(exported.totalRecords).toBe(2)
		await expect(runtime.admin!.pruneBefore(Date.parse('2025-01-01T00:00:00.000Z')))
			.resolves.toEqual({deletedCount: 2})
		await expect(runtime.audit.query({})).resolves.toMatchObject({items: []})
	})

	it('archives a stable plan before pruning and does not prune after archive failure', async() => {
		const store = createMemoryAuditStore()
		const archive = vi.fn(async() => { throw new Error('archive unavailable') })
		const runtime = createAuditHandler({clock, store, adminStore: store, archiveSink: {archive}})
		await runtime.audit.record(write())
		await expect(runtime.admin!.pruneBefore(Date.parse('2025-01-01T00:00:00.000Z'), {archive: true}))
			.rejects.toThrow('archive unavailable')
		expect((await runtime.audit.query({})).items).toHaveLength(1)
		expect(archive).toHaveBeenCalledOnce()
	})

	it('marks retention mutations dirty so a prior flush cannot suppress persistence', async() => {
		const backing = createMemoryAuditStore()
		const store = {...backing, flush: vi.fn()}
		const runtime = createAuditHandler({clock, store, adminStore: store})
		await runtime.audit.record(write())
		await runtime.audit.flush()
		expect(store.flush).toHaveBeenCalledOnce()

		await runtime.admin!.pruneBefore(Date.parse('2025-01-01T00:00:00.000Z'))
		await runtime.audit.flush()

		expect(store.flush).toHaveBeenCalledTimes(2)
	})

	it('generates runtime-owned IDs and timestamps', async() => {
		const runtime = createAuditHandler({clock, store: createMemoryAuditStore()})
		const record = await runtime.audit.record(write())
		expect(record.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(record.occurredAt).toBe('2024-01-01T00:00:00.000Z')
		expect(record.createdAt).toBe(record.occurredAt)
		expect(record.stream).toBe('access')
		expect(record.context).toEqual({})
	})
})
