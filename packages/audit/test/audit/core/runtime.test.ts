import type {AuditWriteRequest} from '@ooopsstudio/core/contracts/audit'
import {describe, expect, it, vi} from 'vitest'

import {createAuditHandler} from '../../../src/audit/core/custom-handler'
import {buildAuditIntegrity, matchesAuditPartitionKey, verifyAuditRecords} from '../../../src/audit/core/integrity'
import {createMemoryAuditStore} from '../../../src/audit/features/stores/memory-store'

const request = (overrides: Partial<AuditWriteRequest> = {}): AuditWriteRequest => ({
	eventType: 'document.updated', category: 'content', action: 'update', actor: {kind: 'user', id: 'user-1'},
	target: {entityType: 'document', entityId: 'doc-1'}, outcome: 'succeeded', sensitivity: 'moderate',
	...overrides
})

describe('audit runtime', () => {
	it('keeps idempotency stable across generated timestamps and scopes keys by tenant', async() => {
		let now = Date.parse('2024-01-01T00:00:00.000Z')
		const {audit} = createAuditHandler({clock: {now: () => now}, store: createMemoryAuditStore()})
		const first = await audit.record(request({idempotencyKey: 'same', tenantId: 'tenant-a'}))
		now += 60_000
		const replay = await audit.record(request({idempotencyKey: 'same', tenantId: 'tenant-a'}))
		const independent = await audit.record(request({idempotencyKey: 'same', tenantId: 'tenant-b'}))
		expect(replay).toEqual(first)
		expect(independent.id).not.toBe(first.id)
		expect(JSON.stringify(first)).not.toContain('same')
		await expect(audit.record(request({idempotencyKey: 'same', tenantId: 'tenant-a', action: 'delete'}))).rejects.toThrow(/conflicts/)
	})

	it('replays idempotently across bootstrap resource changes', async() => {
		const store = createMemoryAuditStore()
		const firstRuntime = createAuditHandler({
			clock: {now: () => Date.parse('2024-01-01T00:00:00.000Z')}, store,
			resource: {serviceName: 'documents', serviceVersion: '1.0.0'}
		})
		const first = await firstRuntime.audit.record(request({
			idempotencyKey: 'deployment-retry', correlation: {requestId: 'request-1'}
		}))
		const nextRuntime = createAuditHandler({
			clock: {now: () => Date.parse('2024-01-02T00:00:00.000Z')}, store,
			resource: {serviceName: 'documents', serviceVersion: '2.0.0'}
		})

		await expect(nextRuntime.audit.record(request({
			idempotencyKey: 'deployment-retry', correlation: {requestId: 'request-1'}
		}))).resolves.toEqual(first)
		await expect(nextRuntime.audit.record(request({
			idempotencyKey: 'deployment-retry', correlation: {requestId: 'request-2'}
		}))).rejects.toThrow(/conflicts/)
	})

	it('rejects conflicting tenant and workspace scope sources before storage', async() => {
		const backing = createMemoryAuditStore()
		const appendMany = vi.fn(backing.appendMany)
		const runtime = createAuditHandler({
			clock: {now: () => 1_704_067_200_000},
			store: {...backing, appendMany}
		})

		await expect(runtime.audit.record(request({
			tenantId: 'tenant-a',
			actor: {kind: 'user', id: 'user-1', tenantId: 'tenant-b'}
		}))).rejects.toThrow(/tenantId scope.*conflict/)
		await expect(runtime.audit.record(request({
			targets: [
				{entityType: 'document', entityId: 'one', workspaceId: 'workspace-a'},
				{entityType: 'document', entityId: 'two', workspaceId: 'workspace-b'}
			],
			target: undefined
		}))).rejects.toThrow(/workspaceId scope.*conflict/)

		expect(appendMany).not.toHaveBeenCalled()
	})

	it('validates positional custom-store append responses', async() => {
		const backing = createMemoryAuditStore()
		const store = {...backing, appendMany: vi.fn(async(records) => [...await backing.appendMany(records)].reverse())}
		const {audit} = createAuditHandler({clock: {now: () => Date.parse('2024-01-01T00:00:00.000Z')}, store})
		await expect(audit.recordMany([request(), request({target: {entityType: 'document', entityId: 'two'}})])).rejects.toThrow(/mismatched record/)
	})

	it('rejects a custom store that collapses distinct idempotency keys onto one record', async() => {
		const backing = createMemoryAuditStore()
		const store = {...backing, appendMany: vi.fn(async(records) => {
			const [first] = await backing.appendMany([records[0]!])
			return [first!, {record: first!.record, inserted: false}]
		})}
		const {audit} = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store})
		await expect(audit.recordMany([
			request({idempotencyKey: 'first-key'}),
			request({idempotencyKey: 'second-key'})
		])).rejects.toThrow(/invalid duplicate record/)
	})

	it('rejects a custom store that inserts one idempotency key more than once in a batch', async() => {
		const backing = createMemoryAuditStore()
		const store = {...backing, appendMany: vi.fn(async(records) => await backing.appendMany(records.map((record) => {
			const {idempotencyHash: _idempotencyHash, ...withoutIdempotency} = record
			return withoutIdempotency
		})))}
		const {audit} = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store})
		await expect(audit.recordMany([
			request({idempotencyKey: 'repeated-key'}),
			request({idempotencyKey: 'repeated-key'})
		])).rejects.toThrow(/inconsistent idempotency replay/)
	})

	it('captures store capabilities once and ignores late rewiring', async() => {
		const backing = createMemoryAuditStore()
		const originalAppend = vi.fn(backing.appendMany)
		const originalQuery = vi.fn(backing.query)
		const replacementAppend = vi.fn()
		const replacementQuery = vi.fn()
		const store = {...backing, appendMany: originalAppend, query: originalQuery}
		const {audit} = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store})
		store.appendMany = replacementAppend as never
		store.query = replacementQuery as never

		await audit.record(request())
		await audit.query({})

		expect(originalAppend).toHaveBeenCalledOnce()
		expect(originalQuery).toHaveBeenCalledOnce()
		expect(replacementAppend).not.toHaveBeenCalled()
		expect(replacementQuery).not.toHaveBeenCalled()
	})

	it('rejects forged hashes and non-idempotent replay responses from custom stores', async() => {
		const backing = createMemoryAuditStore()
		const writer = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store: backing})
		const stored = await writer.audit.record(request())
		const forged = {...stored, integrity: {...stored.integrity, hash: 'a'.repeat(64)}}
		const forgedRead = createAuditHandler({
			clock: {now: () => 1_704_067_200_000},
			store: {...backing, getById: () => forged}
		})
		await expect(forgedRead.audit.getById('stored')).rejects.toThrow(/unsafe|hash/)

		const replayStore = {...backing, appendMany: vi.fn(() => [{record: stored, inserted: false}])}
		const replayRuntime = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store: replayStore})
		await expect(replayRuntime.audit.record(request())).rejects.toThrow(/non-idempotent/)
	})

	it('rejects self-consistent custom-store records missing required fields', async() => {
		const backing = createMemoryAuditStore()
		const writer = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store: backing})
		const stored = await writer.audit.record(request())
		for (const [field, pattern] of [['eventType', /invalid eventType/], ['createdAt', /invalid createdAt/]] as const) {
			const {integrity: _integrity, ...body} = stored
			delete (body as unknown as Record<string, unknown>)[field]
			const integrity = buildAuditIntegrity({
				...body, partitionKey: stored.integrity.partitionKey
			} as never, {sequence: stored.integrity.sequence, prevHash: stored.integrity.prevHash})
			const forged = {...body, integrity}
			const runtime = createAuditHandler({
				clock: {now: () => 1_704_067_200_000},
				store: {...backing, getById: () => forged as never}
			})
			await expect(runtime.audit.getById(stored.id)).rejects.toThrow(pattern)
		}
	})

	it('rejects self-consistent hashes attached to the wrong structural partition', async() => {
		const backing = createMemoryAuditStore()
		const writer = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store: backing})
		const stored = await writer.audit.record(request({tenantId: 'tenant'}))
		const {integrity: _integrity, ...body} = stored
		const partitionKey = 'other:audit:2024-01-01'
		const integrity = buildAuditIntegrity({
			...body, partitionKey
		}, {sequence: stored.integrity.sequence, prevHash: stored.integrity.prevHash})
		const forged = {...body, integrity}
		const runtime = createAuditHandler({
			clock: {now: () => 1_704_067_200_000},
			store: {...backing, getById: () => forged}
		})
		await expect(runtime.audit.getById(stored.id)).rejects.toThrow(/unsafe|partition/)
	})

	it('continues to read and verify legacy unnamespaced SHA-256 partitions', async() => {
		const backing = createMemoryAuditStore()
		const writer = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store: backing})
		const stored = await writer.audit.record(request({tenantId: 'tenant'}))
		const {integrity: _integrity, ...body} = stored
		const partitionKey = 'tenant:content:2024-01-01'
		const integrity = buildAuditIntegrity({
			...body, partitionKey
		}, {sequence: 1, prevHash: null})
		const legacy = {...body, integrity}
		expect(matchesAuditPartitionKey({...body}, partitionKey)).toBe(true)
		expect(buildAuditIntegrity({...legacy, partitionKey}, {sequence: 1, prevHash: null}).hash).toBe(integrity.hash)
		const runtime = createAuditHandler({
			clock: {now: () => 1_704_067_200_000},
			store: {...backing, getById: () => legacy}, adminStore: {...backing, verifyIntegrity: () => ({
				ok: true, checkedCount: 1, partitionKey, affectedRecordIds: []
			})}
		})
		expect(verifyAuditRecords([legacy])).toMatchObject({ok: true, checkedCount: 1})
		await expect(runtime.audit.getById(stored.id)).resolves.toEqual(legacy)
		await expect(runtime.admin.verifyIntegrity({partitionKey})).resolves.toMatchObject({ok: true, checkedCount: 1})
	})

	it('bounds writes before mutation and validates custom limits', async() => {
		const appendMany = vi.fn()
		const store = {kind: 'custom', appendMany, getById: vi.fn(), query: vi.fn()}
		const {audit} = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store: store as never, limits: {maxBatchRecords: 1}})
		await expect(audit.recordMany([request(), request({target: {entityType: 'document', entityId: 'two'}})])).rejects.toThrow(/between 1 and 1/)
		await expect(audit.recordMany([])).rejects.toThrow(/between 1 and 1/)
		expect(appendMany).not.toHaveBeenCalled()
		expect(() => createAuditHandler({clock: {now: () => 0}, store: store as never, limits: {maxTargets: 101}})).toThrow(/maxTargets/)
		expect(() => createAuditHandler({clock: {now: () => 0}, store: store as never, shutdownTimeoutMs: 3_000_000_000})).toThrow(/2147483647/)
	})

	it('rejects string limits that cannot represent the audit integrity schema', () => {
		expect(() => createAuditHandler({
			clock: {now: () => 1_704_067_200_000}, store: createMemoryAuditStore(), limits: {maxStringLength: 511}
		})).toThrow(/maxStringLength must be between 512/)
	})

	it('flushes before close, surfaces lifecycle failures, and closes once', async() => {
		const order: string[] = []
		const store = {...createMemoryAuditStore(), flush: vi.fn(async() => { order.push('flush') }), shutdown: vi.fn(async() => { order.push('close') })}
		let flushHook: (() => Promise<void>) | undefined
		let shutdownHook: (() => Promise<void>) | undefined
		const lifecycle = {
			registerFlushHook: vi.fn((_name, hook) => { flushHook = hook }),
			registerShutdownHook: vi.fn((_group, hook) => { shutdownHook = hook; return vi.fn() })
		}
		const {audit} = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store, lifecycle: lifecycle as never})
		await audit.shutdown(); await audit.shutdown()
		expect(order).toEqual(['flush', 'close'])
		expect(audit.getStatus().state).toBe('closed')
		await expect(audit.record(request())).rejects.toThrow(/draining or closed/)
		expect(flushHook).toBeTypeOf('function'); expect(shutdownHook).toBeTypeOf('function')
	})

	it('disposes both lifecycle registrations after a successful shutdown', async() => {
		const disposeShutdown = vi.fn()
		const disposeFlush = vi.fn()
		const lifecycle = {
			registerShutdownHook: vi.fn(() => disposeShutdown),
			registerFlushHook: vi.fn(() => disposeFlush)
		}
		const {audit} = createAuditHandler({
			clock: {now: () => 1_704_067_200_000}, store: createMemoryAuditStore(), lifecycle: lifecycle as never
		})
		await audit.shutdown()
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledOnce()
	})

	it('keeps admission closed after a pre-close shutdown timeout and resumes the owned cleanup', async() => {
		let releaseFlush!: () => void
		let flushAttempts = 0
		const store = {...createMemoryAuditStore(), flush: vi.fn(async() => {
			flushAttempts += 1
			if (flushAttempts === 1) await new Promise<void>((resolve) => { releaseFlush = resolve })
		})}
		const runtime = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store, shutdownTimeoutMs: 10})
		await expect(runtime.audit.shutdown()).rejects.toThrow(/timed out/)
		expect(runtime.audit.getStatus().state).toBe('draining')
		await expect(runtime.audit.record(request())).rejects.toThrow(/draining or closed/)
		releaseFlush()
		await runtime.audit.shutdown()
		expect(store.flush).toHaveBeenCalledOnce()
		expect(runtime.audit.getStatus().state).toBe('closed')
	})

	it('retains physical close ownership after a timeout without reopening writes', async() => {
		let releaseClose!: () => void
		const store = {
			...createMemoryAuditStore(),
			shutdown: vi.fn(async() => await new Promise<void>((resolve) => { releaseClose = resolve }))
		}
		const runtime = createAuditHandler({
			clock: {now: () => 1_704_067_200_000}, store, shutdownTimeoutMs: 10
		})
		await expect(runtime.audit.shutdown()).rejects.toThrow(/timed out/)
		await expect(runtime.audit.record(request())).rejects.toThrow(/draining or closed/)
		await expect(runtime.audit.shutdown()).rejects.toThrow(/timed out/)
		expect(store.shutdown).toHaveBeenCalledOnce()
		releaseClose()
		await runtime.audit.shutdown()
		expect(store.shutdown).toHaveBeenCalledOnce()
		expect(runtime.audit.getStatus().state).toBe('closed')
	})

	it('makes flush follow the unresolved finalization barrier while draining', async() => {
		let releaseClose!: () => void
		const store = {
			...createMemoryAuditStore(),
			shutdown: vi.fn(async() => await new Promise<void>((resolve) => { releaseClose = resolve }))
		}
		const runtime = createAuditHandler({
			clock: {now: () => 1_704_067_200_000}, store, flushTimeoutMs: 100, shutdownTimeoutMs: 10
		})
		await expect(runtime.audit.shutdown()).rejects.toThrow(/timed out/)
		let settled = false
		const flush = runtime.audit.flush().then(() => { settled = true })
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect(settled).toBe(false)
		releaseClose()
		await flush
		expect(store.shutdown).toHaveBeenCalledOnce()
		expect(runtime.audit.getStatus().state).toBe('draining')
		await runtime.audit.shutdown()
		expect(runtime.audit.getStatus().state).toBe('closed')
	})

	it('retries only archive cleanup after the store has already closed', async() => {
		let archiveAttempts = 0
		const store = {...createMemoryAuditStore(), shutdown: vi.fn()}
		const archiveSink = {
			archive: vi.fn(async({records}) => records.length),
			shutdown: vi.fn(async() => {
				archiveAttempts += 1
				if (archiveAttempts === 1) throw new Error('archive close failed')
			})
		}
		const runtime = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store, archiveSink})
		await expect(runtime.audit.shutdown()).rejects.toThrow(/archive close failed/)
		await expect(runtime.audit.record(request())).rejects.toThrow(/draining or closed/)
		await expect(runtime.audit.shutdown()).resolves.toBeUndefined()
		expect(store.shutdown).toHaveBeenCalledOnce()
		expect(archiveSink.shutdown).toHaveBeenCalledTimes(2)
		expect(runtime.audit.getStatus().state).toBe('closed')
	})

	it('starts a fresh close only after the timed-out physical close rejects', async() => {
		let rejectFirst!: (error: Error) => void
		let attempts = 0
		const store = {
			...createMemoryAuditStore(),
			shutdown: vi.fn(async() => {
				attempts += 1
				if (attempts === 1) await new Promise<void>((_resolve, reject) => { rejectFirst = reject })
			})
		}
		const runtime = createAuditHandler({
			clock: {now: () => 1_704_067_200_000}, store, shutdownTimeoutMs: 10
		})
		await expect(runtime.audit.shutdown()).rejects.toThrow(/timed out/)
		rejectFirst(new Error('late close failure'))
		await new Promise((resolve) => setTimeout(resolve, 0))
		await runtime.audit.shutdown()
		expect(store.shutdown).toHaveBeenCalledTimes(2)
		expect(runtime.audit.getStatus().state).toBe('closed')
	})

	it('serializes explicit flush retries behind a timed-out physical flush', async() => {
		let releaseFirst!: () => void
		let attempts = 0
		const store = {
			...createMemoryAuditStore(),
			flush: vi.fn(async() => {
				attempts += 1
				if (attempts === 1) await new Promise<void>((resolve) => { releaseFirst = resolve })
			})
		}
		const runtime = createAuditHandler({
			clock: {now: () => 1_704_067_200_000}, store, flushTimeoutMs: 10
		})
		await expect(runtime.audit.flush()).rejects.toThrow(/timed out/)
		await expect(runtime.audit.flush()).rejects.toThrow(/timed out/)
		expect(store.flush).toHaveBeenCalledOnce()
		releaseFirst()
		await expect(runtime.audit.flush()).resolves.toBeUndefined()
		expect(store.flush).toHaveBeenCalledOnce()
	})

	it('flushes a stable admission barrier without chasing newer operations', async() => {
		const backing = createMemoryAuditStore()
		const releases: Array<() => void> = []
		const store = {
			...backing,
			appendMany: vi.fn(async(records) => {
				await new Promise<void>((resolve) => { releases.push(resolve) })
				return await backing.appendMany(records)
			}),
			flush: vi.fn()
		}
		const runtime = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store})
		const firstWrite = runtime.audit.record(request())
		await vi.waitFor(() => expect(releases).toHaveLength(1))
		const flush = runtime.audit.flush()
		const secondWrite = runtime.audit.record(request({target: {entityType: 'document', entityId: 'second'}}))
		await vi.waitFor(() => expect(releases).toHaveLength(2))
		releases[0]!()
		await expect(flush).resolves.toBeUndefined()
		expect(store.flush).toHaveBeenCalledOnce()
		releases[1]!()
		await Promise.all([firstWrite, secondWrite])
	})

	it('reflushes during shutdown when an earlier in-flight flush became stale', async() => {
		let releaseFirst!: () => void
		let flushAttempts = 0
		const store = {
			...createMemoryAuditStore(),
			flush: vi.fn(async() => {
				flushAttempts += 1
				if (flushAttempts === 1) await new Promise<void>((resolve) => { releaseFirst = resolve })
			}),
			shutdown: vi.fn()
		}
		const runtime = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store})
		const earlyFlush = runtime.audit.flush()
		await vi.waitFor(() => expect(store.flush).toHaveBeenCalledOnce())
		await runtime.audit.record(request())
		const shutdown = runtime.audit.shutdown()

		releaseFirst()
		await Promise.all([earlyFlush, shutdown])

		expect(store.flush).toHaveBeenCalledTimes(2)
		expect(store.shutdown).toHaveBeenCalledOnce()
		expect(runtime.audit.getStatus().state).toBe('closed')
	})

	it('keeps flush dirty when a store may have persisted before rejecting', async() => {
		const backing = createMemoryAuditStore()
		let failAfterMutation = false
		const store = {
			...backing,
			appendMany: vi.fn(async(records) => {
				const result = await backing.appendMany(records)
				if (failAfterMutation) throw new Error('append response lost')
				return result
			}),
			flush: vi.fn()
		}
		const runtime = createAuditHandler({clock: {now: () => 1_704_067_200_000}, store})
		await runtime.audit.flush()
		expect(store.flush).toHaveBeenCalledOnce()
		failAfterMutation = true

		await expect(runtime.audit.record(request())).rejects.toThrow(/response lost/)
		await runtime.audit.flush()

		expect(store.flush).toHaveBeenCalledTimes(2)
	})

	it('reports and rethrows lifecycle finalization failures', async() => {
		let flushHook!: () => Promise<void>
		const failure = new Error('flush token=secret')
		const store = {...createMemoryAuditStore(), flush: vi.fn(async() => { throw failure })}
		createAuditHandler({
			clock: {now: () => 1_704_067_200_000}, store,
			lifecycle: {registerFlushHook: (_name, hook) => { flushHook = hook }} as never
		})
		await expect(flushHook()).rejects.toBe(failure)
	})
})
