import type {AuditWriteRequest} from '@ooopsstudio/core/contracts/audit'
import {describe, expect, it, vi} from 'vitest'

import {createAuditHandler} from '../../../src/audit/core/custom-handler'
import {buildAuditIntegrity, buildAuditPartitionKey, sha256Stable, verifyAuditRecords} from '../../../src/audit/core/integrity'
import {createMemoryAuditStore} from '../../../src/audit/features/stores/memory-store'
import {createCustomAudit} from '../../../src/audit/public/custom'
import {sanitizeAuditValue} from '../../../src/audit/utils/redaction'
import {compareAuditText} from '../../../src/audit/utils/validation'

const now = Date.parse('2024-01-01T00:00:00.000Z')
const request = (overrides: Partial<AuditWriteRequest> = {}): AuditWriteRequest => ({
	eventType: 'document.updated', category: 'content', action: 'update',
	actor: {kind: 'user', id: 'user-1'}, target: {entityType: 'document', entityId: 'doc-1'},
	outcome: 'succeeded', sensitivity: 'moderate', ...overrides
})

describe('audit adversarial boundaries', () => {
	it('rejects accessors without executing them', async() => {
		const getter = vi.fn(() => 'document.updated')
		const hostile = request()
		Object.defineProperty(hostile, 'eventType', {enumerable: true, get: getter})
		const runtime = createAuditHandler({clock: {now: () => now}, store: createMemoryAuditStore()})
		await expect(runtime.audit.record(hostile)).rejects.toThrow(/readable plain object/)
		expect(getter).not.toHaveBeenCalled()

		const nestedGetter = vi.fn(() => 'secret')
		const nested = {}
		Object.defineProperty(nested, 'value', {enumerable: true, get: nestedGetter})
		expect(() => sanitizeAuditValue({credential: nested}, [{key: 'credential', action: 'hash'}]))
			.toThrow(/readable plain object/)
		expect(nestedGetter).not.toHaveBeenCalled()
	})

	it('rejects terminal and bidi control sequences before they become evidence', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})

		await expect(runtime.audit.record(request({summary: 'safe\u001B]52;c;YXR0YWNr\u0007'})))
			.rejects.toThrow(/unsupported characters/)
		await expect(runtime.audit.record(request({summary: 'approved\u202Edenied'})))
			.rejects.toThrow(/unsupported characters/)
		await expect(runtime.audit.query({})).resolves.toEqual({items: []})
	})

	it('stops batch normalization as soon as the cumulative byte limit is exceeded', async() => {
		const now = vi.fn(() => Date.parse('2024-01-01T00:00:00.000Z'))
		const runtime = createAuditHandler({
			clock: {now}, store: createMemoryAuditStore(),
			limits: {maxBatchBytes: 4096, maxRecordBytes: 2048, maxStringLength: 1024}
		})
		const requests = Array.from({length: 100}, (_, index) => request({
			target: {entityType: 'document', entityId: `doc-${index}`}, metadata: {payload: 'x'.repeat(900)}
		}))

		await expect(runtime.audit.recordMany(requests)).rejects.toThrow(/batch exceeds.*bytes/i)
		expect(now.mock.calls.length).toBeLessThan(10)
	})

	it('redacts deeply nested assignment chains within the bounded string budget', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const nested = `outer=${'accessToken='.repeat(1_000)}terminal-secret`

		const record = await runtime.audit.record(request({summary: nested}))

		expect(record.summary).toBe('outer=accessToken=[REDACTED]')
		expect(JSON.stringify(await store.getById(record.id))).not.toContain('terminal-secret')
	})

	it('rejects caller-controlled integrity and legacy projection fields', async() => {
		const runtime = createAuditHandler({clock: {now: () => now}, store: createMemoryAuditStore()})
		for (const field of ['id', 'occurredAt', 'stream', 'context']) {
			await expect(runtime.audit.record({...request(), [field]: field === 'context' ? {} : 'caller'} as never))
				.rejects.toThrow(/readable plain object/)
		}
		await expect(runtime.audit.record({...request(), actor: {...request().actor, email: 'a@b.com'}} as never))
			.rejects.toThrow(/actor.email/)
		await expect(runtime.audit.record({...request(), correlation: {hostKind: 'server'}} as never))
			.rejects.toThrow(/runtime-owned fields/)
	})

	it('clones stateful regular expressions at bootstrap', async() => {
		const expression = /^secret$/g
		const runtime = await createCustomAudit({
			clock: {now: () => now}, store: createMemoryAuditStore(),
			redaction: {additionalRules: [{key: expression, action: 'mask'}]}
		})
		expression.lastIndex = 5
		const first = await runtime.audit.record(request({metadata: {secret: 'one'}}))
		const second = await runtime.audit.record(request({metadata: {secret: 'two'}, target: {entityType: 'document', entityId: 'two'}}))
		expect(first.metadata.secret).toBe('[REDACTED]')
		expect(second.metadata.secret).toBe('[REDACTED]')
	})

	it('redacts credential markers embedded in qualified metadata keys before storage', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const credentialMetadata = {
			passwordHash: 'password-hash-plaintext',
			accessTokenValue: 'access-token-plaintext',
			clientSecretEncrypted: 'client-secret-plaintext',
			apiKeyMaterial: 'api-key-plaintext',
			credentialCiphertext: 'credential-plaintext',
			userEmailAddress: 'person@example.test',
			phoneNumber: '+30-123456789',
			userIdValue: 'user-sensitive',
			otpCode: '123456',
			recoveryCode: 'recover-me',
			walletMnemonic: 'word one two three'
		}

		const record = await runtime.audit.record(request({metadata: credentialMetadata}))
		const stored = await store.getById(record.id)

		expect(record.metadata).toEqual({
			passwordHash: '[REDACTED]',
			accessTokenValue: '[REDACTED]',
			clientSecretEncrypted: '[REDACTED]',
			apiKeyMaterial: '[REDACTED]',
			credentialCiphertext: '[REDACTED]',
			userEmailAddress: '[REDACTED]',
			phoneNumber: '[REDACTED]',
			userIdValue: '[REDACTED]',
			otpCode: '[REDACTED]',
			recoveryCode: '[REDACTED]',
			walletMnemonic: '[REDACTED]'
		})
		expect(stored?.metadata).toEqual(record.metadata)
		expect(JSON.stringify(stored)).not.toContain('plaintext')
	})

	it('removes credentials from non-HTTP connection URIs before storage', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const record = await runtime.audit.record(request({
			summary: 'failed postgres://db-user:db-password@db.internal/audit?sslmode=require',
			metadata: {
				primary: 'redis://cache-user:cache-password@cache.internal/0#private',
				secondary: 'mongodb+srv://mongo-user:mongo-password@cluster.internal/audit?retryWrites=true'
			}
		}))
		const stored = await store.getById(record.id)
		const serialized = JSON.stringify(stored)

		expect(record.summary).toBe('failed postgres://db.internal/audit')
		expect(record.metadata).toEqual({
			primary: 'redis://cache.internal/0',
			secondary: 'mongodb+srv://cluster.internal/audit'
		})
		expect(serialized).not.toMatch(/db-user|db-password|cache-user|cache-password|mongo-user|mongo-password|sslmode|retryWrites|private/)
	})

	it('redacts short Basic authorization credentials in free-form evidence', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const record = await runtime.audit.record(request({
			summary: 'upstream rejected Basic dXNlcjpwYXNz otp=123456',
			metadata: {diagnostic: 'proxy sent basic YTpi PIN=9876'}
		}))

		expect(record.summary).toBe('upstream rejected Basic [REDACTED] otp=[REDACTED]')
		expect(record.metadata.diagnostic).toBe('proxy sent basic [REDACTED] PIN=[REDACTED]')
		expect(JSON.stringify(await store.getById(record.id))).not.toMatch(/dXNlcjpwYXNz|YTpi|123456|9876/)
	})

	it('rejects a store response that injects a qualified credential field with a valid hash', async() => {
		const backing = createMemoryAuditStore()
		const trusted = createAuditHandler({clock: {now: () => now}, store: backing})
		const stored = await trusted.audit.record(request())
		const {integrity, ...body} = stored
		const injectedBody = {...body, metadata: {passwordHash: 'injected-plaintext'}}
		const forged = {
			...injectedBody,
			integrity: buildAuditIntegrity(
				{...injectedBody, partitionKey: integrity.partitionKey},
				{sequence: integrity.sequence, prevHash: integrity.prevHash}
			)
		}
		const hostile = createAuditHandler({
			clock: {now: () => now},
			store: {...backing, getById: () => forged}
		})

		await expect(hostile.audit.getById(stored.id)).rejects.toThrow(/unsafe record/)
	})

	it('rejects future-dated store evidence even when attacker-controlled timestamps and integrity agree', async() => {
		const backing = createMemoryAuditStore()
		const trusted = createAuditHandler({clock: {now: () => now}, store: backing})
		const stored = await trusted.audit.record(request())
		const {integrity, ...body} = stored
		const futureBody = {...body, occurredAt: '2025-01-01T00:00:00.000Z'}
		const futurePartitionKey = buildAuditPartitionKey({
			category: futureBody.category, occurredAt: futureBody.occurredAt,
			...(futureBody.stream ? {stream: futureBody.stream} : {}),
			...(futureBody.workspaceId ? {workspaceId: futureBody.workspaceId} : {}),
			...(futureBody.tenantId ? {tenantId: futureBody.tenantId} : {})
		})
		const forged = {
			...futureBody,
			integrity: buildAuditIntegrity(
				{...futureBody, partitionKey: futurePartitionKey},
				{sequence: integrity.sequence, prevHash: integrity.prevHash}
			)
		}
		const hostile = createAuditHandler({
			clock: {now: () => now},
			store: {...backing, getById: () => forged}
		})

		expect(verifyAuditRecords([forged])).toMatchObject({
			ok: false, brokenAtRecordId: stored.id, brokenAtSequence: integrity.sequence
		})
		await expect(hostile.audit.getById(stored.id)).rejects.toThrow(/future occurredAt/)

		const coordinatedFutureBody = {
			...body,
			occurredAt: '2025-01-01T00:00:00.000Z',
			createdAt: '2025-01-01T00:00:00.000Z'
		}
		const coordinatedPartitionKey = buildAuditPartitionKey({
			category: coordinatedFutureBody.category, occurredAt: coordinatedFutureBody.occurredAt,
			...(coordinatedFutureBody.stream ? {stream: coordinatedFutureBody.stream} : {}),
			...(coordinatedFutureBody.workspaceId ? {workspaceId: coordinatedFutureBody.workspaceId} : {}),
			...(coordinatedFutureBody.tenantId ? {tenantId: coordinatedFutureBody.tenantId} : {})
		})
		const coordinatedForgery = {
			...coordinatedFutureBody,
			integrity: buildAuditIntegrity(
				{...coordinatedFutureBody, partitionKey: coordinatedPartitionKey},
				{sequence: integrity.sequence, prevHash: integrity.prevHash}
			)
		}
		const coordinatedHostile = createAuditHandler({
			clock: {now: () => now},
			store: {
				...backing,
				getById: () => coordinatedForgery,
				query: () => ({items: [coordinatedForgery]})
			}
		})

		expect(verifyAuditRecords([coordinatedForgery])).toMatchObject({ok: true, checkedCount: 1})
		await expect(coordinatedHostile.audit.getById(stored.id)).rejects.toThrow(/future createdAt/)
		await expect(coordinatedHostile.audit.query({})).rejects.toThrow(/future createdAt/)
	})

	it('rejects redaction regular expressions with unbounded backtracking shapes', async() => {
		await expect(createCustomAudit({
			clock: {now: () => now}, store: createMemoryAuditStore(),
			redaction: {additionalRules: [{key: /^(a+)+$/u, action: 'mask'}]}
		})).rejects.toThrow(/redaction rule 0 is invalid/)
		await expect(createCustomAudit({
			clock: {now: () => now}, store: createMemoryAuditStore(),
			redaction: {additionalRules: [{key: /^(secret|token)$/u, action: 'mask'}]}
		})).resolves.toBeDefined()
	})

	it('rejects accessor-backed redaction paths without executing their segments', async() => {
		const getter = vi.fn(() => 'private')
		const path = ['metadata', 'private']
		Object.defineProperty(path, '1', {enumerable: true, get: getter})

		await expect(createCustomAudit({
			clock: {now: () => now}, store: createMemoryAuditStore(),
			redaction: {additionalRules: [{path, action: 'mask'}]}
		})).rejects.toThrow(/redaction rule 0 is invalid/)
		expect(getter).not.toHaveBeenCalled()
	})

	it('redacts indexed target paths before evidence reaches the store', async() => {
		const store = createMemoryAuditStore()
		const runtime = await createCustomAudit({
			clock: {now: () => now}, store,
			redaction: {additionalRules: [{path: ['targets', 0, 'metadata', 'private'], action: 'mask'}]}
		})
		const record = await runtime.audit.record(request({
			target: {entityType: 'document', entityId: 'one', metadata: {private: 'plaintext'}}
		}))

		expect(record.targets[0]?.metadata?.private).toBe('[REDACTED]')
		expect((await store.getById(record.id))?.targets[0]?.metadata?.private).toBe('[REDACTED]')
	})

	it('preserves dotted JSON keys as exact redaction path segments', async() => {
		const store = createMemoryAuditStore()
		const runtime = await createCustomAudit({
			clock: {now: () => now}, store,
			redaction: {additionalRules: [{path: ['metadata', 'confidential.value'], action: 'mask'}]}
		})
		const record = await runtime.audit.record(request({
			metadata: {'confidential.value': 'plaintext'}
		}))

		expect(record.metadata['confidential.value']).toBe('[REDACTED]')
		expect((await store.getById(record.id))?.metadata['confidential.value']).toBe('[REDACTED]')
	})

	it('applies indexed target redaction to the deterministic persisted order', async() => {
		const store = createMemoryAuditStore()
		const runtime = await createCustomAudit({
			clock: {now: () => now}, store,
			redaction: {additionalRules: [{path: ['targets', 0, 'metadata', 'private'], action: 'mask'}]}
		})
		const targets = ['alpha', 'beta'].map((entityId) => ({
			entityType: 'document', entityId, metadata: {private: `plaintext-${entityId}`}
		}))
		const persistedOrder = [...targets].sort((left, right) => compareAuditText(
			sha256Stable([left.entityType, left.entityId, undefined, undefined]),
			sha256Stable([right.entityType, right.entityId, undefined, undefined])
		))
		const inputOrder = [...persistedOrder].reverse()
		const record = await runtime.audit.record(request({target: undefined, targets: inputOrder}))

		expect(record.targets.map((target) => target.entityId)).toEqual(persistedOrder.map((target) => target.entityId))
		expect(record.targets[0]?.metadata?.private).toBe('[REDACTED]')
		expect(record.targets[1]?.metadata?.private).toBe(`plaintext-${persistedOrder[1]!.entityId}`)
		expect((await store.getById(record.id))?.targets[0]?.metadata?.private).toBe('[REDACTED]')
	})

	it('captures store methods once and isolates later rewiring', async() => {
		const backing = createMemoryAuditStore()
		const appendMany = vi.fn(backing.appendMany)
		const replacement = vi.fn()
		const store = {...backing, appendMany}
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		store.appendMany = replacement as never
		await runtime.audit.record(request())
		expect(appendMany).toHaveBeenCalledOnce()
		expect(replacement).not.toHaveBeenCalled()
	})

	it('rejects partial optional capabilities during bootstrap', async() => {
		await expect(createCustomAudit({
			clock: {now: () => now}, store: createMemoryAuditStore(),
			adminStore: {verifyIntegrity: vi.fn()} as never
		})).rejects.toThrow(/all admin capabilities/)
		await expect(createCustomAudit({
			clock: {now: () => now}, store: createMemoryAuditStore(),
			archiveSink: {archive: vi.fn()}
		})).rejects.toThrow(/requires adminStore/)
	})

	it('returns deeply frozen records, query pages, and status snapshots', async() => {
		const runtime = createAuditHandler({clock: {now: () => now}, store: createMemoryAuditStore()})
		const record = await runtime.audit.record(request({metadata: {nested: {safe: true}}}))
		const page = await runtime.audit.query({})
		const status = runtime.audit.getStatus()
		expect(Object.isFrozen(record)).toBe(true)
		expect(Object.isFrozen(record.metadata)).toBe(true)
		expect(Object.isFrozen((record.metadata.nested as object))).toBe(true)
		expect(Object.isFrozen(page)).toBe(true)
		expect(Object.isFrozen(page.items)).toBe(true)
		expect(Object.isFrozen(status)).toBe(true)
		expect(status).toEqual({state: 'running', activeOperations: 0})
	})
})
