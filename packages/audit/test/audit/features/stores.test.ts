import {describe, expect, it, vi} from 'vitest'

import {buildAuditIntegrity, sha256Stable, verifyAuditRecords} from '../../../src/audit/core/integrity'
import {normalizeAuditWriteRequest} from '../../../src/audit/core/write-normalization'
import {createMemoryAuditStore} from '../../../src/audit/features/stores/memory-store'
import {createPostgresRetention} from '../../../src/audit/features/stores/postgres-retention'
import {createPostgresAuditStore} from '../../../src/audit/features/stores/postgres-store'
import {
	bindPgQueryable,
	encodeAuditCursor,
	parseAuditRow,
	parsePgSafeInteger,
	snapshotPgObject,
	snapshotPgRowCount,
	snapshotPgRows,
	withPgAuditSavepoint,
	withTransaction
} from '../../../src/audit/features/stores/postgres-support'

const clock = {now: () => Date.parse('2024-01-01T00:00:00.000Z')}
const prepared = (id: string, tenantId = 'tenant') => normalizeAuditWriteRequest(clock, {
	id, eventType: 'x', category: 'audit', action: 'write', actor: {kind: 'service'},
	target: {entityType: 'x', entityId: id}, outcome: 'succeeded', sensitivity: 'moderate', tenantId
})

describe('audit stores', () => {
	it('rejects a legacy partition that mixes tenant and workspace scopes with the same identifier', () => {
		const tenant = prepared('legacy-tenant', 'shared')
		const workspace = normalizeAuditWriteRequest(clock, {
			id: 'legacy-workspace', eventType: 'x', category: 'audit', action: 'write', actor: {kind: 'service'},
			target: {entityType: 'x', entityId: 'legacy-workspace'}, outcome: 'succeeded',
			sensitivity: 'moderate', workspaceId: 'shared'
		})
		const legacyPartition = 'shared:audit:2024-01-01'
		const tenantIntegrity = buildAuditIntegrity({...tenant, partitionKey: legacyPartition}, {sequence: 1, prevHash: null})
		const workspaceIntegrity = buildAuditIntegrity(
			{...workspace, partitionKey: legacyPartition},
			{sequence: 2, prevHash: tenantIntegrity.hash}
		)
		const publicRecord = <T extends typeof tenant>(value: T, integrity: typeof tenantIntegrity) => {
			const {partitionKey: _partition, idempotencyHash: _idempotency, semanticFingerprint: _fingerprint, ...body} = value
			return {...body, integrity}
		}

		expect(verifyAuditRecords([
			publicRecord(tenant, tenantIntegrity),
			publicRecord(workspace as typeof tenant, workspaceIntegrity)
		])).toMatchObject({ok: false, brokenAtRecordId: workspace.id, brokenAtSequence: 2})
	})

	it('carries legacy scope identity across verification page anchors', () => {
		const workspace = normalizeAuditWriteRequest(clock, {
			id: 'cross-page-workspace', eventType: 'x', category: 'audit', action: 'write', actor: {kind: 'service'},
			target: {entityType: 'x', entityId: 'cross-page-workspace'}, outcome: 'succeeded',
			sensitivity: 'moderate', workspaceId: 'shared'
		})
		const legacyPartition = 'shared:audit:2024-01-01'
		const previousHash = 'a'.repeat(64)
		const integrity = buildAuditIntegrity(
			{...workspace, partitionKey: legacyPartition},
			{sequence: 501, prevHash: previousHash}
		)
		const {partitionKey: _partition, idempotencyHash: _idempotency, semanticFingerprint: _fingerprint, ...body} = workspace

		expect(verifyAuditRecords([{...body, integrity}], {
			anchors: new Map([[legacyPartition, {
				sequence: 500, hash: previousHash, scopeIdentity: 'tenant=shared'
			}]])
		})).toMatchObject({ok: false, brokenAtRecordId: workspace.id, brokenAtSequence: 501})
	})

	it('detects PostgreSQL records whose entire chain head was deleted across verification scopes', async() => {
		const value = prepared('orphan-record')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const query = vi.fn(async(sql: string) => sql.includes('NOT EXISTS (SELECT 1 FROM audit_chain_heads')
			? {rows: [{partition_key: integrity.partitionKey, sequence: '1', id: value.id}]}
			: {rows: []})
		const store = createPostgresAuditStore({client: {query}})

		for (const filter of [
			undefined,
			{partitionKey: integrity.partitionKey},
			{from: '2023-01-01T00:00:00.000Z', to: '2025-01-01T00:00:00.000Z'}
		]) {
			await expect(store.verifyIntegrity(filter)).resolves.toEqual({
				ok: false,
				checkedCount: 0,
				partitionKey: integrity.partitionKey,
				brokenAtRecordId: value.id,
				brokenAtSequence: 1,
				affectedRecordIds: [value.id]
			})
		}
		const orphanCalls = query.mock.calls.filter(([sql]) => String(sql).includes('NOT EXISTS'))
		expect(orphanCalls).toHaveLength(3)
		expect(orphanCalls[1]?.[1]).toEqual([integrity.partitionKey])
		expect(orphanCalls[2]?.[1]).toEqual(['2023-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'])
	})

	it('detects a deleted PostgreSQL chain tail by reconciling records with the persisted head', async() => {
		const firstPrepared = prepared('tail-first')
		const secondPrepared = prepared('tail-second')
		const firstIntegrity = buildAuditIntegrity(firstPrepared, {sequence: 1, prevHash: null})
		const secondIntegrity = buildAuditIntegrity(secondPrepared, {sequence: 2, prevHash: firstIntegrity.hash})
		const toRow = (value: typeof firstPrepared, integrity: typeof firstIntegrity) => ({
			id: value.id,
			event_type: value.eventType,
			category: value.category,
			action: value.action,
			occurred_at: value.occurredAt,
			created_at: value.createdAt,
			actor_json: JSON.stringify(value.actor),
			targets_json: JSON.stringify(value.targets),
			outcome: value.outcome,
			sensitivity: value.sensitivity,
			summary: null,
			workspace_id: null,
			tenant_id: value.tenantId ?? null,
			stream: value.stream ?? null,
			correlation_json: JSON.stringify(value.correlation),
			context_json: JSON.stringify(value.context),
			metadata_json: JSON.stringify(value.metadata),
			change_set_json: null,
			partition_key: integrity.partitionKey,
			sequence: String(integrity.sequence),
			prev_hash: integrity.prevHash,
			hash: integrity.hash,
			algorithm: integrity.algorithm
		})
		const query = vi.fn(async(sql: string) => {
			if (sql.includes('NOT EXISTS (SELECT 1 FROM audit_chain_heads')) return {rows: []}
			if (sql.includes('FROM audit_chain_heads')) return {rows: [{
				partition_key: secondIntegrity.partitionKey,
				last_sequence: '2',
				last_hash: secondIntegrity.hash,
				last_record_id: secondPrepared.id
			}]}
			if (sql.includes('FROM audit_records') && sql.includes('sequence >')) {
				return {rows: [toRow(firstPrepared, firstIntegrity)]}
			}
			return {rows: []}
		})
		const store = createPostgresAuditStore({client: {query}})

		await expect(store.verifyIntegrity()).resolves.toEqual({
			ok: false,
			checkedCount: 1,
			partitionKey: secondIntegrity.partitionKey,
			brokenAtRecordId: secondPrepared.id,
			brokenAtSequence: 2,
			affectedRecordIds: [secondPrepared.id]
		})
		expect(query.mock.calls.find(([sql]) => String(sql).includes('sequence >'))?.[0])
			.toContain('ORDER BY audit_record.sequence ASC')
	})

	it('detects deletion of the only PostgreSQL record in an active partition', async() => {
		const value = prepared('only-record')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const query = vi.fn(async(sql: string) => {
			if (sql.includes('NOT EXISTS (SELECT 1 FROM audit_chain_heads')) return {rows: []}
			return sql.includes('FROM audit_chain_heads') ? {rows: [{
				partition_key: integrity.partitionKey,
				last_sequence: '1',
				last_hash: integrity.hash,
				last_record_id: value.id
			}]} : {rows: []}
		})
		const store = createPostgresAuditStore({client: {query}})

		await expect(store.verifyIntegrity({
			from: '2023-01-01T00:00:00.000Z', to: '2025-01-01T00:00:00.000Z'
		})).resolves.toMatchObject({
			ok: false,
			checkedCount: 0,
			brokenAtRecordId: value.id,
			brokenAtSequence: 1
		})
		const headQuery = query.mock.calls.find(([sql]) => String(sql).includes('SELECT bounded_head.partition_key'))?.[0]
		expect(headQuery).toContain('OR NOT EXISTS')
		expect(headQuery).toContain('e.partition_key=h.partition_key')
	})

	it('does not let a forged prune sentinel hide surviving PostgreSQL records', async() => {
		const value = prepared('hidden-record')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const row = {
			id: value.id, event_type: value.eventType, category: value.category, action: value.action,
			occurred_at: value.occurredAt, created_at: value.createdAt, actor_json: JSON.stringify(value.actor),
			targets_json: JSON.stringify(value.targets), outcome: value.outcome, sensitivity: value.sensitivity,
			summary: null, workspace_id: null, tenant_id: value.tenantId ?? null, stream: value.stream ?? null,
			correlation_json: JSON.stringify(value.correlation), context_json: JSON.stringify(value.context),
			metadata_json: JSON.stringify(value.metadata), change_set_json: null, partition_key: integrity.partitionKey,
			sequence: '1', prev_hash: null, hash: integrity.hash, algorithm: integrity.algorithm
		}
		const query = vi.fn(async(sql: string) => {
			if (sql.includes('NOT EXISTS (SELECT 1 FROM audit_chain_heads')) return {rows: []}
			if (sql.includes('FROM audit_chain_heads')) return {rows: [{
				partition_key: integrity.partitionKey,
				last_sequence: '1',
				last_hash: integrity.hash,
				last_record_id: '__audit_pruned_partition__'
			}]}
			if (sql.includes('FROM audit_records') && sql.includes('sequence >')) return {rows: [row]}
			return {rows: []}
		})
		const store = createPostgresAuditStore({client: {query}})

		await expect(store.verifyIntegrity()).resolves.toMatchObject({
			ok: false,
			checkedCount: 1,
			brokenAtRecordId: value.id
		})
	})

	it('fails closed for an unbound empty PostgreSQL prune sentinel', async() => {
		const value = prepared('unbound-prune')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const query = vi.fn(async(sql: string) => {
			if (sql.includes('NOT EXISTS (SELECT 1 FROM audit_chain_heads')) return {rows: []}
			if (sql.includes('FROM audit_chain_heads')) return {rows: [{
				partition_key: integrity.partitionKey,
				last_sequence: '1',
				last_hash: integrity.hash,
				last_record_id: '__audit_pruned_partition__'
			}]}
			return {rows: []}
		})
		const store = createPostgresAuditStore({client: {query}})

		await expect(store.verifyIntegrity({partitionKey: integrity.partitionKey})).resolves.toMatchObject({
			ok: false,
			checkedCount: 0,
			partitionKey: integrity.partitionKey,
			brokenAtRecordId: '__audit_pruned_partition__',
			brokenAtSequence: 1
		})
	})

	it('accepts an empty PostgreSQL prune seal only when its tail tombstone exists', async() => {
		const value = prepared('bound-prune')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const recordIdHash = sha256Stable({id: value.id})
		const seal = `__audit_pruned_partition__:${recordIdHash}`
		const query = vi.fn(async(sql: string, params?: unknown[]) => {
			if (sql.includes('NOT EXISTS (SELECT 1 FROM audit_chain_heads')) return {rows: []}
			if (sql.includes('FROM audit_chain_heads')) return {rows: [{
				partition_key: integrity.partitionKey,
				last_sequence: '1',
				last_hash: integrity.hash,
				last_record_id: seal
			}]}
			if (sql.includes('FROM audit_record_tombstones')) {
				expect(params).toEqual([recordIdHash])
				return {rows: [{record_id_hash: recordIdHash}]}
			}
			return {rows: []}
		})
		const store = createPostgresAuditStore({client: {query}})

		await expect(store.verifyIntegrity({partitionKey: integrity.partitionKey})).resolves.toEqual({
			ok: true,
			checkedCount: 0,
			partitionKey: integrity.partitionKey,
			affectedRecordIds: []
		})
	})

	it('rejects memory prune plans with duplicate anchors and missing partition coverage', async() => {
		const store = createMemoryAuditStore()
		await store.appendMany([prepared('tenant-a', 'tenant-a'), prepared('tenant-b', 'tenant-b')])
		const plan = await store.planPruneBefore!('2025-01-01T00:00:00.000Z', 10)
		expect(plan.anchors).toHaveLength(2)
		const anchors = [plan.anchors[0]!, plan.anchors[0]!]
		const forged = {
			...plan,
			anchors,
			planId: sha256Stable({before: plan.before, anchors})
		}
		expect(() => store.prunePlanned!(forged)).toThrow(/partitions are invalid/)
		expect((await store.query()).items).toHaveLength(2)
	})

	it('seals pruned memory partitions against late backdated chain restarts', async() => {
		const store = createMemoryAuditStore()
		await store.appendMany([prepared('original')])
		const plan = await store.planPruneBefore!('2025-01-01T00:00:00.000Z', 10)
		expect(store.prunePlanned!(plan)).toEqual({deletedCount: 1})
		expect(() => store.appendMany([prepared('late')])).toThrow(/partition was pruned/)
		expect((await store.query()).items).toEqual([])
	})

	it('reserves pruned memory idempotency keys across later partitions', async() => {
		const store = createMemoryAuditStore()
		const write = (time: string, action = 'write') => normalizeAuditWriteRequest({now: () => Date.parse(time)}, {
			idempotencyKey: 'historical-command', eventType: 'x', category: 'audit', action, actor: {kind: 'service'},
			target: {entityType: 'x', entityId: 'same'}, outcome: 'succeeded', sensitivity: 'moderate', tenantId: 'tenant'
		})
		store.appendMany([write('2024-01-01T00:00:00.000Z')])
		const plan = await store.planPruneBefore!('2024-06-01T00:00:00.000Z', 10)
		expect(store.prunePlanned!(plan)).toEqual({deletedCount: 1})
		expect(() => store.appendMany([write('2025-01-01T00:00:00.000Z')])).toThrow(/pruned record/)
		expect(() => store.appendMany([write('2025-01-01T00:00:00.000Z', 'delete')])).toThrow(/conflicts/)
	})

	it('reserves pruned memory record ids across later partitions', async() => {
		const store = createMemoryAuditStore()
		const write = (time: string) => normalizeAuditWriteRequest({now: () => Date.parse(time)}, {
			id: 'historical-id', eventType: 'x', category: 'audit', action: 'write', actor: {kind: 'service'},
			target: {entityType: 'x', entityId: 'same'}, outcome: 'succeeded', sensitivity: 'moderate', tenantId: 'tenant'
		})
		store.appendMany([write('2024-01-01T00:00:00.000Z')])
		const plan = await store.planPruneBefore!('2024-06-01T00:00:00.000Z', 10)
		expect(store.prunePlanned!(plan)).toEqual({deletedCount: 1})
		expect(() => store.appendMany([write('2025-01-01T00:00:00.000Z')])).toThrow(/id.*pruned record/)
	})

	it('validates direct memory retention limits consistently with PostgreSQL', () => {
		const store = createMemoryAuditStore()
		expect(() => store.planPruneBefore!('2025-01-01T00:00:00.000Z', 0)).toThrow(/between 1 and 10000/)
		expect(() => store.planPruneBefore!('2025-01-01T00:00:00.000Z', Number.NaN)).toThrow(/between 1 and 10000/)
	})

	it('rejects pooled connections that cannot be released before starting a transaction', async() => {
		const query = vi.fn()
		await expect(withTransaction({
			query,
			connect: vi.fn(async() => ({query}))
		} as never, async() => undefined)).rejects.toThrow(/release missing/)
		expect(query).not.toHaveBeenCalled()
	})

	it('releases an acquired pooled connection when its query method is invalid', async() => {
		const release = vi.fn()
		await expect(withTransaction({
			query: vi.fn(),
			connect: vi.fn(async() => ({query: 'invalid', release}))
		} as never, async() => undefined)).rejects.toThrow(/query method/)
		expect(release).toHaveBeenCalledOnce()
	})

	it('releases an invalid connection rejected by the PostgreSQL store wrapper', async() => {
		const release = vi.fn()
		const store = createPostgresAuditStore({
			client: {
				query: vi.fn(),
				connect: vi.fn(async() => ({query: 'invalid', release}))
			} as never
		})

		await expect(store.appendMany([])).rejects.toThrow(/invalid PG client/)
		expect(release).toHaveBeenCalledOnce()
	})

	it('attempts rollback when the BEGIN response is lost before releasing a pooled connection', async() => {
		const statements: string[] = []
		const release = vi.fn()
		const query = vi.fn(async(sql: string) => {
			statements.push(sql)
			if (sql === 'BEGIN') throw new Error('begin response lost')
			return {rows: []}
		})
		await expect(withTransaction({
			query: vi.fn(), connect: vi.fn(async() => ({query, release}))
		} as never, async() => undefined)).rejects.toThrow(/begin response lost/)
		expect(statements).toEqual(['BEGIN', 'ROLLBACK'])
		expect(release).toHaveBeenCalledOnce()
	})

	it('aborts a caller transaction when rejected-batch savepoint cleanup cannot be confirmed', async() => {
		const failure = new Error('batch rejected')
		const statements: string[] = []
		const query = vi.fn(async(sql: string) => {
			statements.push(sql)
			if (sql.startsWith('ROLLBACK TO')) throw new Error('savepoint cleanup failed')
			return {rows: []}
		})
		await expect(withPgAuditSavepoint({query}, async() => { throw failure })).rejects.toBe(failure)
		expect(statements).toEqual(['SAVEPOINT a', 'ROLLBACK TO a;RELEASE a', 'ROLLBACK'])
	})

	it('hardens PostgreSQL helper boundaries and pooled success cleanup', async() => {
		expect(() => bindPgQueryable(null)).toThrow(/PgQueryable/)
		expect(() => bindPgQueryable([])).toThrow(/PgQueryable/)
		expect(() => parsePgSafeInteger('-1', 'count')).toThrow(/invalid count/)
		expect(() => parsePgSafeInteger('9007199254740992', 'count')).toThrow(/invalid count/)
		expect(() => snapshotPgRows(null, 1, 'rows')).toThrow(/invalid rows/)
		expect(() => snapshotPgRows({rows: [1, 2]}, 1, 'rows')).toThrow(/invalid rows/)
		expect(() => snapshotPgRows({rows: []}, -1, 'rows')).toThrow(/invalid rows/)
		expect(() => snapshotPgRowCount({rowCount: -1}, 'count')).toThrow(/invalid count/)
		expect(() => snapshotPgRowCount([], 'count')).toThrow(/invalid count/)
		expect(() => snapshotPgRowCount({}, 'count')).toThrow(/invalid count/)
		expect(() => snapshotPgObject(null, new Set(), 'object')).toThrow(/invalid object/)
		expect(() => snapshotPgObject(Object.create({}), new Set(), 'object')).toThrow(/invalid object/)
		expect(parsePgSafeInteger(2, 'count', 1)).toBe(2)
		const release = vi.fn()
		const statements: string[] = []
		const result = await withTransaction({
			query: vi.fn(), connect: vi.fn(async() => ({
				query: vi.fn(async(sql: string) => (statements.push(sql), {rows: []})), release
			}))
		} as never, async() => 'done')
		expect(result).toBe('done')
		expect(statements).toEqual(['BEGIN', 'SET LOCAL search_path=pg_catalog,pg_temp', 'COMMIT'])
		expect(release).toHaveBeenCalledOnce()
		expect(encodeAuditCursor({occurredAt: '2024-01-01T00:00:00.000Z', id: 'id'} as never)).toBeTypeOf('string')
	})

	it('parses every optional PostgreSQL row field and invalid structured variants', () => {
		const value = prepared('optional')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const complete = {
			id: value.id, event_type: value.eventType, category: value.category, action: value.action,
			occurred_at: value.occurredAt, created_at: value.createdAt, actor_json: JSON.stringify(value.actor),
			targets_json: JSON.stringify(value.targets), outcome: value.outcome, sensitivity: value.sensitivity,
			summary: 'summary', workspace_id: 'workspace', tenant_id: 'tenant', stream: 'stream',
			correlation_json: '{}', context_json: '{}', metadata_json: '{}', change_set_json: JSON.stringify({summary: 'change'}),
			partition_key: integrity.partitionKey, sequence: '1', prev_hash: 'a'.repeat(64), hash: integrity.hash,
			algorithm: integrity.algorithm
		}
		expect(parseAuditRow(complete)).toMatchObject({summary: 'summary', workspaceId: 'workspace', changeSet: {summary: 'change'}})
		const extended = {...complete}
		Object.defineProperty(extended, 'extension_column', {enumerable: true, get: () => { throw new Error('unread') }})
		expect(parseAuditRow(extended)).toMatchObject({id: value.id})
		expect(() => parseAuditRow({...complete, actor_json: '[]'})).toThrow(/structured PostgreSQL/)
		expect(() => parseAuditRow({...complete, correlation_json: '[]'})).toThrow(/structured PostgreSQL/)
		expect(() => parseAuditRow({...complete, context_json: 'null'})).toThrow(/structured PostgreSQL/)
		expect(() => parseAuditRow({...complete, metadata_json: '[]'})).toThrow(/structured PostgreSQL/)
		expect(() => parseAuditRow({...complete, change_set_json: '[]'})).toThrow(/structured PostgreSQL/)
		expect(() => parseAuditRow({...complete, outcome: 'invalid'})).toThrow(/invalid enums/)
		expect(() => parseAuditRow({...complete, occurred_at: 'invalid'})).toThrow(/occurred_at/)
		expect(() => parseAuditRow({...complete, occurred_at: '2024-01-01 00:00:00.000123+00'}))
			.toThrow(/sub-millisecond occurred_at/)
		expect(() => parseAuditRow({...complete, created_at: '2024-01-01 00:00:00.000001+00'}))
			.toThrow(/sub-millisecond created_at/)
		expect(() => parseAuditRow({...complete, partition_key: 'x'.repeat(513)})).toThrow(/partition_key/)
		const largeSection = Object.fromEntries(Array.from({length: 40}, (_, index) => [
			`field${index}`,
			String(index).padStart(2, '0').repeat(7_500)
		]))
		expect(() => parseAuditRow({
			...complete,
			context_json: JSON.stringify(largeSection),
			metadata_json: JSON.stringify(largeSection)
		})).toThrow(/record is too large/)
	})

	it('rejects every malformed PostgreSQL store option shape', () => {
		for (const options of [null, [], Object.create({}), {}, {client: null},
			{client: {query: vi.fn()}, tablePrefix: 'bad-prefix'}, {client: {query: vi.fn()}, tablePrefix: 'x'.repeat(31)}]) {
			expect(() => createPostgresAuditStore(options as never)).toThrow()
		}
	})

	it('keeps memory storage atomic and rejects capacity instead of evicting', async() => {
		const store = createMemoryAuditStore({maxRecords: 1, maxBytes: 1024 * 1024})
		await store.appendMany([prepared('one')])
		expect(() => store.appendMany([prepared('two')])).toThrow(/capacity exhausted/)
		expect((await store.query()).items.map((item) => item.id)).toEqual(['one'])
	})

	it('uses deterministic UTF-8 cursor ordering for non-ASCII record ids', async() => {
		const store = createMemoryAuditStore()
		await store.appendMany([prepared('😀'), prepared('\uE000')])
		const first = await store.query({sort: 'asc', limit: 1})
		expect(first.items.map((item) => item.id)).toEqual(['\uE000'])
		expect(first.nextCursor).toBeTypeOf('string')
		const second = await store.query({sort: 'asc', limit: 1, cursor: first.nextCursor})
		expect(second.items.map((item) => item.id)).toEqual(['😀'])
	})

	it('orders and filters ISO timestamps correctly across expanded years', async() => {
		const expandedClock = {now: () => Date.parse('+010000-01-01T00:00:00.000Z')}
		const make = (id: string, occurredAt: string) => normalizeAuditWriteRequest(expandedClock, {
			id, occurredAt, eventType: 'time', category: 'audit', action: 'record', actor: {kind: 'service'},
			target: {entityType: 'time', entityId: id}, outcome: 'succeeded', sensitivity: 'moderate'
		})
		const store = createMemoryAuditStore()
		await store.appendMany([
			make('expanded', '+010000-01-01T00:00:00.000Z'),
			make('four-digit', '9999-12-31T23:59:59.999Z')
		])

		expect((await store.query({sort: 'asc'})).items.map((item) => item.id)).toEqual(['four-digit', 'expanded'])
		expect((await store.query({from: '+010000-01-01T00:00:00.000Z'})).items.map((item) => item.id))
			.toEqual(['expanded'])
	})

	it('acquires PostgreSQL idempotency and partition locks in sorted order', async() => {
		const calls: Array<[string, unknown[] | undefined]> = []
		const client = {query: vi.fn(async(sql: string, params?: unknown[]) => {
			calls.push([sql, params])
			if (sql.startsWith('SELECT') && sql.includes('last_sequence')) return {rows: []}
			return {rows: [], rowCount: sql.startsWith('INSERT INTO') ? 1 : sql.startsWith('DELETE') ? 0 : undefined}
		})}
		const store = createPostgresAuditStore({client})
		const a = normalizeAuditWriteRequest(clock, {
			id: 'a', idempotencyKey: 'z', eventType: 'x', category: 'audit', action: 'write', actor: {kind: 'service'},
			target: {entityType: 'x', entityId: 'a'}, outcome: 'succeeded', sensitivity: 'moderate', tenantId: 'tenant'
		})
		const b = normalizeAuditWriteRequest(clock, {
			id: 'b', idempotencyKey: 'a', eventType: 'x', category: 'audit', action: 'write', actor: {kind: 'service'},
			target: {entityType: 'x', entityId: 'b'}, outcome: 'succeeded', sensitivity: 'moderate', tenantId: 'aaa'
		})
		const result = await store.appendMany([a, b])
		expect(result.every((entry) => entry.inserted)).toBe(true)
		expect(calls.filter(([sql]) => sql.includes("set_config('synchronous_commit'"))).toHaveLength(1)
		const locks = calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock')).map(([, params]) => params)
		expect(locks.map((params) => params?.[0])).toEqual(['audit:idempotency:', 'audit:partition:'])
		for (const params of locks) expect(params?.[1]).toEqual([...(params?.[1] as string[])].sort())
	})

	it('serializes transactions when PostgreSQL is configured with a dedicated client', async() => {
		let activeTransactions = 0
		let maximumActive = 0
		const client = {query: vi.fn(async(sql: string) => {
			if (sql === 'BEGIN') {
				activeTransactions += 1
				maximumActive = Math.max(maximumActive, activeTransactions)
			} else if (sql === 'COMMIT' || sql === 'ROLLBACK') activeTransactions -= 1
			if (sql.includes('pg_advisory_xact_lock')) await new Promise((resolve) => setTimeout(resolve, 5))
			if (sql.startsWith('SELECT') && sql.includes('last_sequence')) return {rows: []}
			return {rows: [], rowCount: sql.startsWith('INSERT INTO') ? 1 : undefined}
		})}
		const store = createPostgresAuditStore({client})
		await Promise.all([store.appendMany([prepared('one')]), store.appendMany([prepared('two')])])
		expect(maximumActive).toBe(1)
		expect(activeTransactions).toBe(0)
	})

	it('rejects unacknowledged PostgreSQL record and chain-head mutations', async() => {
		for (const table of ['audit_records', 'audit_chain_heads']) {
			const statements: string[] = []
			const client = {query: vi.fn(async(sql: string) => {
				statements.push(sql)
				if (sql.startsWith('SELECT') && sql.includes('last_sequence')) return {rows: []}
				return {rows: [], rowCount: sql.startsWith(`INSERT INTO ${table}`)
					? 0
					: sql.startsWith('INSERT INTO') ? 1 : undefined}
			})}
			const store = createPostgresAuditStore({client})
			await expect(store.appendMany([prepared(`unacknowledged-${table}`)])).rejects.toThrow(/mutation|row count/)
			expect(statements).toContain('ROLLBACK')
		}
	})

	it('rolls back before insertion when a PostgreSQL chain head is corrupt', async() => {
		const statements: string[] = []
		const client = {query: vi.fn(async(sql: string) => {
			statements.push(sql)
			if (sql.includes('last_sequence')) return {rows: [{last_sequence: '1', last_hash: 'corrupt'}]}
			return {rows: [], rowCount: sql.startsWith('INSERT INTO') ? 1 : undefined}
		})}
		const store = createPostgresAuditStore({client})
		await expect(store.appendMany([prepared('corrupt-head')])).rejects.toThrow(/chain head/)
		expect(statements).toContain('ROLLBACK')
		expect(statements.some((sql) => sql.startsWith('INSERT INTO audit_records'))).toBe(false)
	})

	it('extends a PostgreSQL chain only from a head that matches its persisted record', async() => {
		const first = prepared('head-first')
		const firstIntegrity = buildAuditIntegrity(first, {sequence: 1, prevHash: null})
		let headReads = 0
		const client = {query: vi.fn(async(sql: string) => {
			if (sql.startsWith('SELECT') && sql.includes('last_sequence')) {
				headReads += 1
				return headReads === 1 ? {rows: []} : {rows: [{
					last_sequence: '1', last_hash: firstIntegrity.hash, last_record_id: first.id,
					rs: '1', rh: firstIntegrity.hash, rp: first.partitionKey, rt: first.tenantId, rw: null
				}]}
			}
			return {rows: [], rowCount: sql.startsWith('INSERT INTO') ? 1 : undefined}
		})}
		const store = createPostgresAuditStore({client})
		const result = await store.appendMany([first, prepared('head-second')])

		expect(result.map((entry) => entry.record.integrity.sequence)).toEqual([1, 2])
		expect(result[1]!.record.integrity.prevHash).toBe(firstIntegrity.hash)
	})

	it('refuses to extend a global partition from a colliding legacy tenant-global tail', async() => {
		const value = normalizeAuditWriteRequest(clock, {
			id: 'new-global', eventType: 'x', category: 'audit', action: 'write', actor: {kind: 'service'},
			target: {entityType: 'x', entityId: 'new-global'}, outcome: 'succeeded', sensitivity: 'moderate'
		})
		const previousHash = 'a'.repeat(64)
		const client = {query: vi.fn(async(sql: string) => sql.includes('last_sequence') ? {rows: [{
			last_sequence: '1', last_hash: previousHash, last_record_id: 'legacy-tenant-global',
			rs: '1', rh: previousHash, rp: value.partitionKey, rt: 'global', rw: null
		}]} : {rows: []})}
		const store = createPostgresAuditStore({client})

		await expect(store.appendMany([value])).rejects.toThrow(/chain head/)
		expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO audit_records'))).toBe(false)
	})

	it('rejects writes whose PostgreSQL head seals a pruned partition', async() => {
		const value = prepared('late-postgres')
		const client = {query: vi.fn(async(sql: string) => sql.includes('last_sequence') ? {rows: [{
			last_sequence: '1', last_hash: 'a'.repeat(64), last_record_id: 'archived', rs: null, rh: null, rp: null
		}]} : {rows: []})}
		const store = createPostgresAuditStore({client})
		await expect(store.appendMany([value])).rejects.toThrow(/partition is sealed/)
		expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO audit_records'))).toBe(false)
	})

	it('rejects reuse of a PostgreSQL idempotency tombstone', async() => {
		const value = normalizeAuditWriteRequest(clock, {
			id: 'pruned-id', idempotencyKey: 'pruned-command', eventType: 'x', category: 'audit', action: 'write',
			actor: {kind: 'service'}, target: {entityType: 'x', entityId: 'pruned-id'},
			outcome: 'succeeded', sensitivity: 'moderate', tenantId: 'tenant'
		})
		const client = {query: vi.fn(async(sql: string) => sql.includes('FROM audit_record_tombstones')
			? {rows: [{semantic_fingerprint: value.semanticFingerprint, record_id_hash: sha256Stable({id: value.id})}]}
			: {rows: []})}
		const store = createPostgresAuditStore({client})
		await expect(store.appendMany([value])).rejects.toThrow(/pruned record/)
		expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO audit_records'))).toBe(false)
	})

	it('rejects reuse of a PostgreSQL pruned record id', async() => {
		const value = prepared('pruned-id-reuse')
		const client = {query: vi.fn(async(sql: string) => sql.includes('FROM audit_record_tombstones WHERE record_id_hash')
			? {rows: [{record_id_hash: sha256Stable({id: value.id})}]}
			: {rows: []})}
		const store = createPostgresAuditStore({client})
		await expect(store.appendMany([value])).rejects.toThrow(/id belongs to a pruned record/)
		expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO audit_records'))).toBe(false)
	})

	it('rejects transactional query accessors without invoking them', async() => {
		const store = createPostgresAuditStore({client: {query: vi.fn(async() => ({rows: []}))}})
		const queryGetter = vi.fn()
		const transaction = {}
		Object.defineProperty(transaction, 'query', {enumerable: true, get: queryGetter})
		await expect(store.appendTransactional!(transaction, [prepared('hostile-transaction')]))
			.rejects.toThrow(/query method is not readable/)
		expect(queryGetter).not.toHaveBeenCalled()
	})

	it('rejects PostgreSQL transactional writes when statements are auto-committed', async() => {
		let transactionId = 0
		const query = vi.fn(async(sql: string) => sql.includes('txid_current')
			? {rows: [{transaction_id: String(++transactionId)}]}
			: {rows: []})
		const autonomousQuery = vi.fn(async(sql: string) => sql.startsWith('SELECT') && sql.includes('last_sequence')
			? {rows: []}
			: {rows: [], rowCount: sql.startsWith('INSERT INTO') ? 1 : undefined})
		const store = createPostgresAuditStore({client: {
			query: vi.fn(async() => ({rows: []})),
			connect: vi.fn(async() => ({query: autonomousQuery, release: vi.fn()}))
		}})
		await store.appendMany([prepared('verify-pool-auto-commit')])

		await expect(store.appendTransactional({query}, [prepared('not-transactional')]))
			.rejects.toThrow(/active PostgreSQL transaction/)
		expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))).toBe(false)
	})

	it('accepts PostgreSQL transactional writes only while the transaction identity is stable', async() => {
		const query = vi.fn(async(sql: string) => {
			if (sql.includes('txid_current')) return {rows: [{transaction_id: '42'}]}
			if (sql.startsWith('SELECT') && sql.includes('last_sequence')) return {rows: []}
			return {rows: [], rowCount: sql.startsWith('INSERT INTO') ? 1 : undefined}
		})
		const autonomousQuery = vi.fn(async(sql: string) => sql.startsWith('SELECT') && sql.includes('last_sequence')
			? {rows: []}
			: {rows: [], rowCount: sql.startsWith('INSERT INTO') ? 1 : undefined})
		const store = createPostgresAuditStore({client: {
			query: vi.fn(async() => ({rows: []})),
			connect: vi.fn(async() => ({query: autonomousQuery, release: vi.fn()}))
		}})
		await store.appendMany([prepared('verify-pool-transactional')])

		await expect(store.appendTransactional({query}, [prepared('transactional')]))
			.resolves.toMatchObject([{inserted: true}])
		expect(query.mock.calls.filter(([sql]) => String(sql).includes('txid_current'))).toHaveLength(2)
		expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['SAVEPOINT a', 'RELEASE a']))
		expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO audit_records'))).toBe(true)
	})

	it('rejects caller-owned transactions when the store uses the same dedicated connection', async() => {
		const query = vi.fn(async(sql: string) => sql.includes('txid_current')
			? {rows: [{transaction_id: '42'}]}
			: {rows: []})
		const store = createPostgresAuditStore({client: {query}})

		await expect(store.appendTransactional({query}, [prepared('dedicated-transaction')]))
			.rejects.toThrow(/PostgreSQL pool is unverified/)
		expect(query).not.toHaveBeenCalled()
	})

	it('skips oversized retention candidates instead of starving smaller partitions', async() => {
		const records = [prepared('small')]
		const auditRecord = {...records[0], integrity: {partitionKey: 'small', sequence: 1, prevHash: null, hash: 'a'.repeat(64), algorithm: 'sha256-stable-json-v1' as const}}
		const query = vi.fn(async(sql: string) => sql.includes('count(*)') ? {rows: [
			{partition_key: 'huge', record_count: '100', record_bytes: '10000'},
			{partition_key: 'small', record_count: '1', record_bytes: '100'}
		]} : {rows: []})
		const retention = createPostgresRetention({
			client: {query} as never, tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => [auditRecord]
		})
		const plan = await retention.planPruneBefore('2025-01-01T00:00:00.000Z', 10)
		expect(plan.partitionKeys).toEqual(['small'])
		expect(plan.planId).toMatch(/^[a-f0-9]{64}$/)
		expect(query).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
	})

	it('groups maximum-partition retention plans with linear partition-key reads', async() => {
		const keys = Array.from({length: 100}, (_, index) => `linear-${String(index).padStart(3, '0')}`)
		let partitionReads = 0
		const records = keys.map((key) => ({
			id: key,
			integrity: {
				get partitionKey() { partitionReads += 1; return key },
				sequence: 1, prevHash: null, hash: 'a'.repeat(64), algorithm: 'sha256-stable-json-v1'
			}
		}))
		const query = vi.fn(async(sql: string) => sql.includes('GROUP BY r.partition_key')
			? {rows: keys.map((partition_key) => ({partition_key, record_count: '1', record_bytes: '1'}))}
			: {rows: []})
		const retention = createPostgresRetention({
			client: {query} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => records as never
		})

		await expect(retention.planPruneBefore('2025-01-01T00:00:00.000Z', 100))
			.resolves.toMatchObject({partitionKeys: keys})
		expect(partitionReads).toBeLessThanOrEqual(records.length * 2)
	})

	it('bounds PostgreSQL retention candidate scanning', async() => {
		let candidateQueries = 0
		const candidateStatements: Array<{sql: string; params?: unknown[]}> = []
		const query = vi.fn(async(sql: string, params?: unknown[]) => {
			if (!sql.includes('count(*)')) return {rows: []}
			candidateQueries += 1
			candidateStatements.push({sql, params})
			const previous = typeof params?.[1] === 'string' && params[1]
				? Number(String(params[1]).slice('partition-'.length)) + 1
				: 0
			const pageSize = Number(params?.[2])
			return {rows: Array.from({length: pageSize}, (_, offset) => ({
				partition_key: `partition-${String(previous + offset).padStart(5, '0')}`,
				record_count: '10001',
				record_bytes: '100'
			}))}
		})
		const retention = createPostgresRetention({
			client: {query} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => []
		})
		await expect(retention.planPruneBefore('2025-01-01T00:00:00.000Z', 10)).resolves.toMatchObject({records: []})
		expect(candidateQueries).toBe(20)
		expect(candidateStatements[0]?.sql).toContain('count(*) <= $4::bigint')
		expect(candidateStatements[0]?.sql).toContain('sum(octet_length(row_to_json(audit_fields)::text)) <= $5::bigint')
		expect(candidateStatements[0]?.params?.slice(3)).toEqual([10, 32 * 1024 * 1024])
	})

	it('uses C collation for deterministic PostgreSQL partition pagination', async() => {
		const statements: string[] = []
		const query = vi.fn(async(sql: string) => {
			statements.push(sql)
			return {rows: []}
		})
		const retention = createPostgresRetention({
			client: {query} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => []
		})
		await retention.planPruneBefore('2025-01-01T00:00:00.000Z', 10)
		expect(statements.find((sql) => sql.includes('count(*)'))).toContain('partition_key COLLATE "C"')
	})

	it('rejects hostile retention candidate and delete result accessors', async() => {
		const candidateGetter = vi.fn(() => 'partition')
		const candidate = {record_count: '1', record_bytes: '100'}
		Object.defineProperty(candidate, 'partition_key', {enumerable: true, get: candidateGetter})
		const hostileCandidate = createPostgresRetention({
			client: {query: vi.fn(async(sql: string) => sql.includes('count(*)') ? {rows: [candidate]} : {rows: []})} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => []
		})
		await expect(hostileCandidate.planPruneBefore('2025-01-01T00:00:00.000Z', 10))
			.rejects.toThrow(/retention candidate row/)
		expect(candidateGetter).not.toHaveBeenCalled()

		const value = prepared('row-count')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const {partitionKey: _partition, explicitId: _explicitId, explicitOccurredAt: _explicitOccurredAt, ...body} = value
		const auditRecord = {...body, integrity}
		const anchors = [{
			partitionKey: integrity.partitionKey, count: 1, firstRecordId: value.id, firstHash: integrity.hash,
			lastRecordId: value.id, lastHash: integrity.hash
		}]
		const plan = {
			planId: sha256Stable({before: '2025-01-01T00:00:00.000Z', anchors}),
			before: '2025-01-01T00:00:00.000Z', partitionKeys: [integrity.partitionKey], records: [auditRecord], anchors
		}
		const rowCountGetter = vi.fn(() => 1)
		const deleteResult = {rows: []}
		Object.defineProperty(deleteResult, 'rowCount', {enumerable: true, get: rowCountGetter})
		const hostileDelete = createPostgresRetention({
			client: {query: vi.fn(async(sql: string) => sql.startsWith('DELETE FROM records')
				? deleteResult
				: {rows: [], rowCount: sql.startsWith('INSERT INTO tombstones') || sql.startsWith('UPDATE heads') ? 1 : undefined})} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => [auditRecord]
		})
		await expect(hostileDelete.prunePlanned(plan)).rejects.toThrow(/prune delete row count/)
		expect(rowCountGetter).not.toHaveBeenCalled()

		const missingReservationQuery = vi.fn(async(sql: string) => ({
			rows: [], rowCount: sql.startsWith('INSERT INTO tombstones') ? 0 : undefined
		}))
		const missingReservation = createPostgresRetention({
			client: {query: missingReservationQuery} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => [auditRecord]
		})
		await expect(missingReservation.prunePlanned(plan)).rejects.toThrow(/reservation mismatch/)
		expect(missingReservationQuery.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM records'))).toBe(false)

		const missingHeadQuery = vi.fn(async(sql: string) => ({
			rows: [], rowCount: sql.startsWith('INSERT INTO tombstones') ? 1 : sql.startsWith('UPDATE heads') ? 0 : undefined
		}))
		const missingHead = createPostgresRetention({
			client: {query: missingHeadQuery} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => [auditRecord]
		})
		await expect(missingHead.prunePlanned(plan)).rejects.toThrow(/head mismatch/)
		expect(missingHeadQuery.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM records'))).toBe(false)
	})

	it('rejects incomplete PostgreSQL prune partition loads with a stable error', async() => {
		const query = vi.fn(async(sql: string) => sql.includes('GROUP BY r.partition_key')
			? {rows: [{partition_key: 'missing', record_count: '1', record_bytes: '100'}]}
			: {rows: []})
		const retention = createPostgresRetention({
			client: {query} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'}
		})
		await expect(retention.planPruneBefore('2025-01-01T00:00:00.000Z', 10))
			.rejects.toThrow(/incomplete prune partition/)
		expect(query.mock.calls.find(([sql]) => String(sql).includes('AS audit_record'))?.[0])
			.toContain('ORDER BY audit_record.partition_key COLLATE "C" ASC, audit_record.sequence ASC')
		const loadCall = query.mock.calls.find(([sql]) => String(sql).includes('AS audit_record'))
		expect(loadCall?.[0]).toContain('count(*)<=10000')
		expect(loadCall?.[0]).toContain('sum(octet_length(row_to_json(audit_fields)::text))')
		expect(loadCall?.[1]).toEqual([['missing']])
	})

	it('rejects a PostgreSQL prune when record content changed without updating its stored hash', async() => {
		const value = prepared('tampered-prune')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const {partitionKey: _partition, explicitId: _id, explicitOccurredAt: _occurredAt, ...body} = value
		const record = {...body, integrity}
		const tampered = {...record, action: 'tampered-with-stale-hash'}
		const anchors = [{
			partitionKey: integrity.partitionKey,
			count: 1,
			firstRecordId: record.id,
			firstHash: integrity.hash,
			lastRecordId: record.id,
			lastHash: integrity.hash
		}]
		const before = '2025-01-01T00:00:00.000Z'
		const plan = {
			planId: sha256Stable({before, anchors}), before,
			partitionKeys: [integrity.partitionKey], records: [record], anchors
		}
		const query = vi.fn(async() => ({rows: [], rowCount: 0}))
		const retention = createPostgresRetention({
			client: {query} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => [tampered]
		})

		await expect(retention.prunePlanned(plan)).rejects.toThrow(/invalid prune chain/)
		expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO tombstones'))).toBe(false)
		expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM records'))).toBe(false)
	})

	it('runs PostgreSQL verification inside a repeatable-read snapshot', async() => {
		const statements: string[] = []
		const client = {query: vi.fn(async(sql: string) => {
			statements.push(sql)
			if (sql.includes('SELECT DISTINCT partition_key')) return {rows: []}
			return {rows: []}
		})}
		const store = createPostgresAuditStore({client})
		await expect(store.verifyIntegrity!()).resolves.toMatchObject({ok: true, checkedCount: 0})
		expect(statements).toEqual(expect.arrayContaining([
			'BEGIN', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', 'COMMIT'
		]))
	})

	it('loads PostgreSQL retention lazily and accepts an empty exact plan', async() => {
		const client = {query: vi.fn(async(sql: string) => ({
			rows: [], rowCount: sql.startsWith('DELETE FROM audit_records') ? 0 : undefined
		}))}
		const store = createPostgresAuditStore({client})
		const plan = await store.planPruneBefore!('2025-01-01T00:00:00.000Z', 10)
		expect(plan).toMatchObject({partitionKeys: [], records: [], anchors: []})
		await expect(store.prunePlanned!(plan)).resolves.toEqual({deletedCount: 0})
	})

	it('deletes only the exact PostgreSQL records in a fresh anchored plan', async() => {
		const value = prepared('one')
		const integrity = buildAuditIntegrity(value, {sequence: 1, prevHash: null})
		const {partitionKey: _partition, explicitId: _explicitId, explicitOccurredAt: _explicitOccurredAt, ...body} = value
		const auditRecord = {...body, integrity}
		const anchors = [{
			partitionKey: integrity.partitionKey, count: 1, firstRecordId: value.id, firstHash: integrity.hash,
			lastRecordId: value.id, lastHash: integrity.hash
		}]
		const plan = {
			planId: sha256Stable({before: '2025-01-01T00:00:00.000Z', anchors}), before: '2025-01-01T00:00:00.000Z',
			partitionKeys: [integrity.partitionKey], records: [auditRecord], anchors
		}
		const query = vi.fn(async(sql: string) => ({
			rows: [], rowCount: sql.startsWith('DELETE FROM audit_records') || sql.startsWith('INSERT INTO audit_tombstones')
				|| sql.startsWith('UPDATE audit_heads') ? 1 : 0
		}))
		const retention = createPostgresRetention({
			client: {query} as never,
			tables: {records: 'audit_records', heads: 'audit_heads', migrations: 'audit_migrations', tombstones: 'audit_tombstones'},
			loadPartitionsFrom: async() => [auditRecord]
		})
		await expect(retention.prunePlanned(plan)).resolves.toEqual({deletedCount: 1})
		expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']))
		expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO audit_tombstones'))).toBe(true)
		expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE audit_heads'))).toBe(true)
		const sealCall = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE audit_heads'))
		expect(sealCall?.[1]?.[4]).toEqual([`__audit_pruned_partition__:${sha256Stable({id: value.id})}`])
		expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM audit_heads'))).toBe(false)

		const forged = {...plan, records: [{...auditRecord, id: 'other'}]}
		await expect(retention.prunePlanned(forged)).rejects.toThrow(/records mismatch/)
	})

	it('sorts multi-record PostgreSQL prune plans before exact comparison', async() => {
		const firstPrepared = prepared('first')
		const firstIntegrity = buildAuditIntegrity(firstPrepared, {sequence: 1, prevHash: null})
		const secondPrepared = prepared('second')
		const secondIntegrity = buildAuditIntegrity(secondPrepared, {sequence: 2, prevHash: firstIntegrity.hash})
		const publicRecord = (value: typeof firstPrepared, integrity: typeof firstIntegrity) => {
			const {partitionKey: _partition, explicitId: _id, explicitOccurredAt: _occurredAt, ...body} = value
			return {...body, integrity}
		}
		const first = publicRecord(firstPrepared, firstIntegrity)
		const second = publicRecord(secondPrepared, secondIntegrity)
		const anchors = [{
			partitionKey: firstIntegrity.partitionKey, count: 2, firstRecordId: first.id, firstHash: firstIntegrity.hash,
			lastRecordId: second.id, lastHash: secondIntegrity.hash
		}]
		const before = '2025-01-01T00:00:00.000Z'
		const plan = {
			planId: sha256Stable({before, anchors}), before, partitionKeys: [firstIntegrity.partitionKey],
			records: [second, first], anchors
		}
		const firstIdempotencyHash = 'b'.repeat(64)
		const secondIdempotencyHash = 'a'.repeat(64)
		const query = vi.fn(async(sql: string) => ({
			rows: sql.startsWith('SELECT idempotency_hash')
				? [{idempotency_hash: firstIdempotencyHash}, {idempotency_hash: secondIdempotencyHash}]
				: [],
			rowCount: sql.startsWith('DELETE FROM records') || sql.startsWith('INSERT INTO tombstones')
				? 2
				: sql.startsWith('UPDATE heads') ? 1 : 0
		}))
		const retention = createPostgresRetention({
			client: {query} as never,
			tables: {records: 'records', heads: 'heads', migrations: 'migrations', tombstones: 'tombstones'},
			loadPartitionsFrom: async() => [first, second]
		})
		await expect(retention.prunePlanned(plan)).resolves.toEqual({deletedCount: 2})
		expect(query.mock.calls.filter(([sql]) => sql.includes("set_config('synchronous_commit'"))).toHaveLength(1)
		const locks = query.mock.calls
			.filter(([sql]) => sql.includes('pg_advisory_xact_lock'))
			.map(([, params]) => params)
		expect(locks).toEqual([
			['audit:idempotency:', [secondIdempotencyHash, firstIdempotencyHash]],
			['audit:partition:', [firstIntegrity.partitionKey]]
		])
	})
})
