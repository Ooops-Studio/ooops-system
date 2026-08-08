import {describe, expect, it, vi} from 'vitest'

import {queryPostgresAuditRecords} from '../../../src/audit/features/stores/postgres-query'

describe('audit PostgreSQL queries', () => {
	it('parameterizes filters and applies a stable cursor tuple in ascending order', async() => {
		const query = vi.fn(async() => ({rows: []}))
		const cursor = Buffer.from(JSON.stringify({occurredAt: '2024-01-01T00:00:00.000Z', id: 'last'})).toString('base64url')
		await queryPostgresAuditRecords({query, recordsTable: 'audit_records'}, {
			sort: 'asc', limit: 2, cursor, eventType: "x' OR true --", outcome: ['failed', 'denied'],
			targetEntityType: 'document', targetEntityId: 'one'
		})
		const [sql, params] = query.mock.calls[0]!
		expect(sql).not.toContain("x' OR true")
		expect(sql).toContain('LEFT JOIN LATERAL')
		expect(sql).toContain('octet_length(row_to_json(safe_fields)::text)<=1048576')
		expect(sql).toContain('b.id IS NULL OR EXISTS')
		expect(sql).toContain('jsonb_array_elements(b.targets_json)')
		expect(sql).not.toContain('jsonb_array_elements(audit_record.targets_json)')
		expect(sql).toContain('(audit_record.occurred_at, audit_record.id COLLATE "C") >')
		expect(sql).toContain('ORDER BY audit_record.occurred_at ASC, audit_record.id COLLATE "C" ASC')
		expect(params).toEqual(["x' OR true --", ['failed', 'denied'], 'document', 'one', '2024-01-01T00:00:00.000Z', 'last', 3])
	})

	it('rejects unknown fields and inverted time windows before querying', async() => {
		const query = vi.fn(async() => ({rows: []}))
		const context = {query, recordsTable: 'audit_records'}
		await expect(queryPostgresAuditRecords(context, {unknown: true} as never)).rejects.toThrow(/known fields/)
		await expect(queryPostgresAuditRecords(context, {from: '2024-02-01T00:00:00.000Z', to: '2024-01-01T00:00:00.000Z'})).rejects.toThrow(/after/)
		expect(query).not.toHaveBeenCalled()
	})

	it('parameterizes every optional filter in descending order', async() => {
		const query = vi.fn(async() => ({rows: []}))
		await queryPostgresAuditRecords({query, recordsTable: 'audit_records'}, {
			sort: 'desc', from: '2024-01-01T00:00:00.000Z', to: '2024-01-02T00:00:00.000Z',
			category: 'content', action: 'delete', actorKind: 'user', actorId: 'user', workspaceId: 'workspace',
			tenantId: 'tenant', partitionKey: 'tenant=tenant:content:2024-01-01', outcome: 'succeeded',
			sensitivity: 'high', targetEntityId: 'target'
		})
		const [sql, params] = query.mock.calls[0]!
		expect(sql).toContain('ORDER BY audit_record.occurred_at DESC, audit_record.id COLLATE "C" DESC')
		expect(sql).toContain('workspace_id =')
		expect(sql).toContain('tenant_id =')
		expect(sql).toContain("actor_json ->> 'kind'")
		expect(sql).toContain("target ->> 'entityId'")
		expect(params).toContain('tenant')
	})

	it('caps the physical PostgreSQL fetch below the aggregate batch envelope', async() => {
		const query = vi.fn(async() => ({rows: []}))
		await queryPostgresAuditRecords({query, recordsTable: 'audit_records'}, {limit: 500})
		expect(query.mock.calls[0]?.[1]).toEqual([16])
	})
})
