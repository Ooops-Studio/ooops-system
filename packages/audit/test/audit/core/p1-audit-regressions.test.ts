import type {AuditWriteRequest} from '@ooopsstudio/core/contracts/audit'
import {describe, expect, it, vi} from 'vitest'

import {
	AUDIT_MAX_ACTIVE_OPERATIONS,
	AUDIT_MAX_PENDING_FLUSH_ATTEMPTS,
	AUDIT_MAX_PENDING_SHUTDOWN_ATTEMPTS
} from '../../../src/audit/constants'
import {createAuditHandler} from '../../../src/audit/core/custom-handler'
import {createMemoryAuditStore} from '../../../src/audit/features/stores/memory-store'
import {attachAuditObservability} from '../../../src/audit/public/observability'

const now = Date.parse('2024-01-01T00:00:00.000Z')
const request = (overrides: Partial<AuditWriteRequest> = {}): AuditWriteRequest => ({
	eventType: 'document.updated', category: 'content', action: 'update',
	actor: {kind: 'user', id: 'user-1'}, target: {entityType: 'document', entityId: 'doc-1'},
	outcome: 'succeeded', sensitivity: 'moderate', ...overrides
})

describe('audit P1 regressions', () => {
	it('rejects asynchronous store flush re-entry without retaining a self-await cycle', async() => {
		const backing = createMemoryAuditStore()
		let runtime!: ReturnType<typeof createAuditHandler>
		let reenter = true
		const store = {...backing, flush: vi.fn(async() => {
			await Promise.resolve()
			if (reenter) await runtime.audit.flush()
		})}
		runtime = createAuditHandler({clock: {now: () => now}, store})

		await expect(runtime.audit.flush()).rejects.toThrow('AUDIT_FINALIZATION_REENTRY')
		reenter = false
		await expect(runtime.audit.flush()).resolves.toBeUndefined()
		await expect(runtime.audit.shutdown()).resolves.toBeUndefined()
	})

	it('rejects asynchronous store shutdown re-entry and permits a clean retry', async() => {
		const backing = createMemoryAuditStore()
		let runtime!: ReturnType<typeof createAuditHandler>
		let reenter = true
		const store = {...backing, shutdown: vi.fn(async() => {
			await Promise.resolve()
			if (reenter) await runtime.audit.shutdown()
		})}
		runtime = createAuditHandler({clock: {now: () => now}, store})

		await expect(runtime.audit.shutdown()).rejects.toThrow('AUDIT_FINALIZATION_REENTRY')
		expect(runtime.audit.getStatus()).toMatchObject({state: 'draining'})
		reenter = false
		await expect(runtime.audit.shutdown()).resolves.toBeUndefined()
		expect(runtime.audit.getStatus()).toMatchObject({state: 'closed'})
	})

	it('rejects shutdown re-entry from an active store operation without draining admission', async() => {
		const backing = createMemoryAuditStore()
		let runtime!: ReturnType<typeof createAuditHandler>
		let reenter = true
		const store = {...backing, appendMany: vi.fn(async(records) => {
			await Promise.resolve()
			if (reenter) await runtime.audit.shutdown()
			return backing.appendMany(records)
		})}
		runtime = createAuditHandler({clock: {now: () => now}, store})

		await expect(runtime.audit.record(request())).rejects.toThrow('AUDIT_FINALIZATION_REENTRY')
		expect(runtime.audit.getStatus()).toMatchObject({state: 'running'})
		reenter = false
		await expect(runtime.audit.record(request())).resolves.toBeDefined()
		await expect(runtime.audit.shutdown()).resolves.toBeUndefined()
	})

	it('fails closed for Unicode credential keys and common standalone credentials', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const awsKey = `AKIA${'A1'.repeat(8)}`
		const githubToken = `ghp_${'aB1'.repeat(8)}`
		const lowercaseToken = `opaque${'lower9'.repeat(6)}`
		const record = await runtime.audit.record(request({
			summary: `authorization Basic dXNlcjpwYXNz and ${awsKey} and ${lowercaseToken}`,
			metadata: {
				'ｐａｓｓｗｏｒｄ': 'fullwidth-secret',
				'раssword': 'homoglyph-secret',
				note: `delivery failed for ${githubToken}`
			}
		}))
		const serialized = JSON.stringify(await store.getById(record.id))

		expect(record.metadata['ｐａｓｓｗｏｒｄ']).toBe('[REDACTED]')
		expect(record.metadata['раssword']).toBe('[REDACTED]')
		expect(record.metadata.note).toContain('[REDACTED_TOKEN]')
		expect(record.summary).toContain('Basic [REDACTED]')
		expect(record.summary).toContain('[REDACTED_TOKEN]')
		expect(serialized).not.toMatch(/fullwidth-secret|homoglyph-secret|AKIA|ghp_|dXNlcjpwYXNz|opaquelower/u)
	})

	it('removes credentials carried in property names and complete quoted assignments', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const githubToken = `ghp_${'aB1'.repeat(8)}`
		const record = await runtime.audit.record(request({
			summary: 'failure token="secret value with spaces" after retry',
			metadata: {
				'password=hunter2': 'ignored',
				'password hunter3': 'ignored',
				[githubToken]: 'ignored',
				'__redacted_key_0__': 'safe'
			}
		}))
		const serialized = JSON.stringify(await store.getById(record.id))

		expect(record.summary).toBe('failure token=[REDACTED] after retry')
		expect(Object.keys(record.metadata)).not.toContain('password=hunter2')
		expect(Object.values(record.metadata)).toContain('[REDACTED]')
		expect(serialized).not.toMatch(/hunter2|hunter3|ghp_|secret value with spaces/u)
	})

	it('redacts short credentials assigned through compound identifier names', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const longCredentialKey = `${'prefix_'.repeat(40)}passwordHash`
		const record = await runtime.audit.record(request({
			summary: `access_token=short-a refreshToken="short b" password_hash=short-c apiKeyValue=short-d ${longCredentialKey}=short-g outer=accessToken=short-h`,
			metadata: {
				diagnostic: 'sessionToken:short-e recovery_code=short-f ordinary_field=retained outer=accessToken="short i" quoted="accessToken=short j with spaces"'
			}
		}))
		const serialized = JSON.stringify(await store.getById(record.id))

		expect(record.summary).toBe(
			`access_token=[REDACTED] refreshToken=[REDACTED] password_hash=[REDACTED] apiKeyValue=[REDACTED] ${longCredentialKey}=[REDACTED] outer=accessToken=[REDACTED]`
		)
		expect(record.metadata.diagnostic).toBe(
			'sessionToken=[REDACTED] recovery_code=[REDACTED] ordinary_field=retained outer=accessToken=[REDACTED] quoted="accessToken=[REDACTED]"'
		)
		expect(serialized).not.toMatch(/short-[a-h]|short b|short i|short j/u)
	})

	it('redacts free-form credential assignments with non-Latin field names', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const record = await runtime.audit.record(request({
			summary: 'αποτυχία κωδικός=μυστικό ordinary=retained outer=κωδικός=δεύτερο nested=κωδικός=τρίτο emoji=🔑=τέταρτο',
			metadata: {diagnostic: '認証情報="秘密 value" retry=allowed'}
		}))
		const serialized = JSON.stringify(await store.getById(record.id))

		expect(record.summary).toBe('αποτυχία κωδικός=[REDACTED] ordinary=retained outer=κωδικός=[REDACTED] nested=κωδικός=[REDACTED] emoji=🔑=[REDACTED]')
		expect(record.metadata.diagnostic).toBe('認証情報=[REDACTED] retry=allowed')
		expect(serialized).not.toMatch(/μυστικό|δεύτερο|τρίτο|τέταρτο|秘密 value/u)
	})

	it('redacts common passcodes, key credentials, and international contact data', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const record = await runtime.audit.record(request({
			summary: 'pwd=one passcode=two mfaCode=three accessKey=four sig=five ordinary=six',
			metadata: {
				diagnostic: 'contact δοκιμή@παράδειγμα.ελ or +30 (210) 123-4567',
				accountSigningKey: 'seven'
			}
		}))
		const serialized = JSON.stringify(await store.getById(record.id))

		expect(record.summary).toBe(
			'pwd=[REDACTED] passcode=[REDACTED] mfaCode=[REDACTED] accessKey=[REDACTED] sig=[REDACTED] ordinary=six'
		)
		expect(record.metadata.diagnostic).toBe('contact [REDACTED_EMAIL] or [REDACTED_PHONE]')
		expect(record.metadata.accountSigningKey).toBe('[REDACTED]')
		expect(serialized).not.toMatch(/one|two|three|four|five|seven|δοκιμή|210/u)
	})

	it('does not persist an idempotency oracle for redacted low-entropy secrets', async() => {
		const store = createMemoryAuditStore()
		const runtime = createAuditHandler({clock: {now: () => now}, store})
		const first = await runtime.audit.record(request({
			idempotencyKey: 'command-1', metadata: {password: 'guess-one', operation: 'same'}
		}))
		const replay = await runtime.audit.record(request({
			idempotencyKey: 'command-1', metadata: {password: 'guess-two', operation: 'same'}
		}))

		expect(replay.id).toBe(first.id)
		expect(first.metadata.password).toBe('[REDACTED]')
		expect(JSON.stringify(await store.getById(first.id))).not.toMatch(/guess-one|guess-two/u)
	})

	it('bounds unresolved store operations and recovers capacity after settlement', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const backing = createMemoryAuditStore()
		const getById = vi.fn(async() => { await gate; return undefined })
		const runtime = createAuditHandler({clock: {now: () => now}, store: {...backing, getById}})
		const pending = Array.from({length: AUDIT_MAX_ACTIVE_OPERATIONS}, (_, index) =>
			runtime.audit.getById(`record-${index}`))

		await expect(runtime.audit.getById('overflow')).rejects.toThrow('AUDIT_OPERATION_CAPACITY')
		expect(getById).toHaveBeenCalledTimes(AUDIT_MAX_ACTIVE_OPERATIONS)
		release()
		await Promise.all(pending)
		await expect(runtime.audit.getById('recovered')).resolves.toBeUndefined()
	})

	it('bounds callers retained behind one unresolved physical flush', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const backing = createMemoryAuditStore()
		const flush = vi.fn(async() => await gate)
		const runtime = createAuditHandler({
			clock: {now: () => now}, store: {...backing, flush}, flushTimeoutMs: 60_000
		})
		const pending = Array.from({length: AUDIT_MAX_PENDING_FLUSH_ATTEMPTS}, () => runtime.audit.flush())

		await expect(runtime.audit.flush()).rejects.toThrow('AUDIT_FLUSH_CAPACITY')
		expect(flush).toHaveBeenCalledOnce()
		release()
		await Promise.all(pending)
		await expect(runtime.audit.flush()).resolves.toBeUndefined()
	})

	it('bounds callers retained behind one unresolved physical shutdown', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const backing = createMemoryAuditStore()
		const shutdown = vi.fn(async() => await gate)
		const runtime = createAuditHandler({
			clock: {now: () => now}, store: {...backing, shutdown}, shutdownTimeoutMs: 60_000
		})
		const pending = Array.from(
			{length: AUDIT_MAX_PENDING_SHUTDOWN_ATTEMPTS},
			() => runtime.audit.shutdown()
		)

		await expect(runtime.audit.shutdown()).rejects.toThrow('AUDIT_SHUTDOWN_CAPACITY')
		await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
		release()
		await Promise.all(pending)
		await expect(runtime.audit.shutdown()).resolves.toBeUndefined()
	})

	it('contains audit-operation re-entry from synchronous telemetry listeners', async() => {
		const backing = createMemoryAuditStore()
		const appendMany = vi.fn(backing.appendMany)
		const runtime = createAuditHandler({clock: {now: () => now}, store: {...backing, appendMany}})
		const reentryErrors: unknown[] = []
		const detach = attachAuditObservability(runtime.audit, () => {
			void runtime.audit.record(request()).catch((error) => reentryErrors.push(error))
		})

		await runtime.audit.record(request())
		await Promise.resolve()
		detach()

		expect(appendMany).toHaveBeenCalledOnce()
		expect(reentryErrors.length).toBeGreaterThan(0)
		expect(reentryErrors).toEqual(expect.arrayContaining([
			expect.objectContaining({message: 'AUDIT_FINALIZATION_REENTRY'})
		]))
	})

	it('contains runtime re-entry from the captured clock during record preparation', async() => {
		const reentryErrors: unknown[] = []
		let runtime!: ReturnType<typeof createAuditHandler>
		let reenter = true
		const clock = {now: () => {
			if (reenter) void runtime.audit.record(request()).catch((error) => reentryErrors.push(error))
			return now
		}}
		runtime = createAuditHandler({clock, store: createMemoryAuditStore()})

		await expect(runtime.audit.record(request())).resolves.toBeDefined()
		await Promise.resolve()
		reenter = false

		expect(reentryErrors).toEqual([
			expect.objectContaining({message: 'AUDIT_FINALIZATION_REENTRY'})
		])
	})

	it('contains query re-entry from hostile validation traps before store admission', async() => {
		const reentryErrors: unknown[] = []
		let runtime!: ReturnType<typeof createAuditHandler>
		const query = new Proxy({}, {
			getPrototypeOf() {
				void runtime.audit.query({}).catch((error) => reentryErrors.push(error))
				return Object.prototype
			}
		})
		runtime = createAuditHandler({clock: {now: () => now}, store: createMemoryAuditStore()})

		await expect(runtime.audit.query(query)).resolves.toEqual({items: []})
		await Promise.resolve()
		expect(reentryErrors).toEqual([
			expect.objectContaining({message: 'AUDIT_FINALIZATION_REENTRY'})
		])
	})
})
