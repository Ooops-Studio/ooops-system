import type {AuditWriteRequest} from '@ooopsstudio/core/contracts/audit'
import {describe, expect, it, vi} from 'vitest'

import {createAuditHandler} from '../../../src/audit/core/custom-handler'
import {createMemoryAuditStore} from '../../../src/audit/features/stores/memory-store'
import {attachAuditObservability} from '../../../src/audit/public/observability'

const now = Date.parse('2024-01-01T00:00:00.000Z')
const request = (overrides: Partial<AuditWriteRequest> = {}): AuditWriteRequest => ({
	eventType: 'document.updated', category: 'content', action: 'update', actor: {kind: 'user', id: 'user'},
	target: {entityType: 'document', entityId: 'doc'}, outcome: 'succeeded', sensitivity: 'moderate', ...overrides
})

describe('audit observability and capability hardening', () => {
	it('attaches observability once, emits bounded events, and disposes cleanly', async() => {
		const runtime = createAuditHandler({clock: {now: () => now}, store: createMemoryAuditStore()})
		const listener = vi.fn()
		const dispose = attachAuditObservability(runtime.audit, listener)
		expect(() => attachAuditObservability(runtime.audit, vi.fn())).toThrow(/ATTACHED/)
		await runtime.audit.record(request())
		expect(listener).toHaveBeenCalledWith({kind: 'recorded', count: 1})
		expect(listener).toHaveBeenCalledWith({kind: 'active', count: expect.any(Number)})
		expect(listener.mock.calls.every(([event]) => Object.isFrozen(event))).toBe(true)
		dispose(); dispose()
		listener.mockClear()
		await runtime.audit.record(request({target: {entityType: 'document', entityId: 'two'}}))
		expect(listener).not.toHaveBeenCalled()
	})

	it('does not emit operational failures for deterministic validation failures', async() => {
		const runtime = createAuditHandler({clock: {now: () => now}, store: createMemoryAuditStore()})
		const listener = vi.fn()
		attachAuditObservability(runtime.audit, listener)
		await expect(runtime.audit.record({...request(), id: 'caller'} as never)).rejects.toThrow()
		expect(listener.mock.calls.some(([event]) => event.kind === 'operation_failed')).toBe(false)
	})

	it('reports operational storage failures and isolates hostile listeners', async() => {
		const failure = Object.assign(new Error('database unavailable'), {code: 'AUDIT_DATABASE_UNAVAILABLE'})
		const store = {...createMemoryAuditStore(), appendMany: vi.fn(async() => { throw failure })}
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const listener = vi.fn(() => { throw new Error('observer failed') })
		attachAuditObservability(runtime.audit, listener)
		await expect(runtime.audit.record(request())).rejects.toBe(failure)
		expect(listener).toHaveBeenCalledWith({
			kind: 'operation_failed', operation: 'record', code: 'AUDIT_DATABASE_UNAVAILABLE', reportable: true
		})
		expect(runtime.audit.getStatus()).toEqual({
			state: 'running', activeOperations: 0, lastFailureCode: 'AUDIT_DATABASE_UNAVAILABLE'
		})
	})

	it('rejects invalid listeners without mutating runtime attachment state', async() => {
		const runtime = createAuditHandler({clock: {now: () => now}, store: createMemoryAuditStore()})
		expect(() => attachAuditObservability(runtime.audit, undefined as never)).toThrow(/invalid_observability/)
		const listener = vi.fn()
		attachAuditObservability(runtime.audit, listener)
		await runtime.audit.record(request())
		expect(listener).toHaveBeenCalled()
	})

	it('exposes transactional writes only through an explicit transaction-aware adapter', async() => {
		const store = createMemoryAuditStore()
		const appendTransactional = vi.fn(async(_transaction, records) => await store.appendMany(records))
		const runtime = createAuditHandler({
			clock: {now: () => now}, store, transactionalStore: {appendTransactional}
		})
		expect('appendTransactional' in store).toBe(false)
		expect(runtime.transactional).toBeDefined()
		const transaction = {}
		await expect(runtime.transactional!.recordTransactional(transaction, [request(), request({
			target: {entityType: 'document', entityId: 'two'}
		})])).resolves.toHaveLength(2)
		expect(appendTransactional).toHaveBeenCalledWith(transaction, expect.any(Array))
		await expect(runtime.transactional!.recordTransactional(undefined, [request()])).rejects.toThrow(/transaction is invalid/)
	})

	it('keeps resource enrichment bootstrap-owned and redacted', async() => {
		const runtime = createAuditHandler({
			clock: {now: () => now}, store: createMemoryAuditStore(),
			resource: {serviceName: 'audit-service', attributes: {region: 'eu'}}
		})
		const record = await runtime.audit.record(request({correlation: {requestId: 'request-1'}}))
		expect(record.correlation).toMatchObject({
			requestId: 'request-1', resource: {serviceName: 'audit-service', attributes: {region: 'eu'}}
		})
	})
})
