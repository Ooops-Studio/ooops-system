import {createContainer} from '@ooopsstudio/core/runtime/container'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerAudit} from '../../../src/audit'
import {AUDIT_SHUTDOWN_TIMEOUT_MS} from '../../../src/audit/constants'
import {createMemoryAuditStore} from '../../../src/audit/features/stores/memory-store'
import {createCustomAudit} from '../../../src/audit/public/custom'
import {createDevelopmentAudit} from '../../../src/audit/public/development'
import {createProductionAudit} from '../../../src/audit/public/production'

describe('audit presets', () => {
	it('uses asynchronous factories and strict hostile-safe options', async() => {
		await expect(createDevelopmentAudit({unknown: true} as never)).rejects.toThrow(/known fields/)
		await expect(createProductionAudit({postgres: undefined, typo: true} as never)).rejects.toThrow(/known fields/)
		const getter = vi.fn(() => ({now: () => 0}))
		const options = {store: createMemoryAuditStore()}
		Object.defineProperty(options, 'clock', {enumerable: true, get: getter})
		await expect(createCustomAudit(options as never)).rejects.toThrow(/known fields/)
		expect(getter).not.toHaveBeenCalled()
	})

	it('exposes the documented capability matrix', async() => {
		const development = await createDevelopmentAudit({clock: {now: () => 0}})
		expect(development.audit).toBeDefined()
		expect(development.admin).toBeDefined()
		expect(development.transactional).toBeUndefined()

		const store = createMemoryAuditStore()
		const core = await createCustomAudit({clock: {now: () => 0}, store})
		expect(core).toEqual({audit: core.audit})
		const complete = await createCustomAudit({
			clock: {now: () => 0}, store,
			transactionalStore: {appendTransactional: (_transaction, records) => store.appendMany(records)},
			adminStore: store
		})
		expect(complete.transactional).toBeDefined()
		expect(complete.admin).toBeDefined()
	})

	it('requires PostgreSQL in production and performs compatibility validation without fallback', async() => {
		await expect(createProductionAudit({} as never)).rejects.toThrow(/PostgreSQL/)
		const query = vi.fn(async() => ({rows: []}))
		await expect(createProductionAudit({postgres: {client: {query}}} as never)).rejects.toMatchObject({
			code: 'AUDIT_SCHEMA_INCOMPATIBLE'
		})
		expect(query).toHaveBeenCalled()
	})

	it('atomically binds only capabilities present in the runtime', async() => {
		const development = createContainer()
		development.bind(TOK.Clock, {now: () => 0})
		await registerAudit(development, {preset: 'development'})
		expect(development.has(TOK.Audit)).toBe(true)
		expect(development.has(TOK.AuditAdmin)).toBe(true)
		expect(development.has(TOK.AuditTransactional)).toBe(false)

		const custom = createContainer()
		custom.bind(TOK.Clock, {now: () => 0})
		await registerAudit(custom, {preset: 'custom', options: {store: createMemoryAuditStore()}})
		expect(custom.has(TOK.Audit)).toBe(true)
		expect(custom.has(TOK.AuditAdmin)).toBe(false)
		expect(custom.has(TOK.AuditTransactional)).toBe(false)
	})

	it('rejects duplicate and concurrent registration', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, {now: () => 0})
		const results = await Promise.allSettled([
			registerAudit(container, {preset: 'development'}),
			registerAudit(container, {preset: 'development'})
		])
		expect(results.filter(({status}) => status === 'fulfilled')).toHaveLength(1)
		expect(results.filter(({status}) => status === 'rejected')).toHaveLength(1)
		await expect(registerAudit(container, {preset: 'development'})).rejects.toThrow(/already registered/)
	})

	it('does not let registration options replace the container lifecycle or clock', async() => {
		const registerShutdownHook = vi.fn()
		const registerFlushHook = vi.fn()
		const container = createContainer()
		container.bind(TOK.Clock, {now: () => 0})
		container.bind(TOK.Lifecycle, {registerShutdownHook, registerFlushHook})

		await expect(registerAudit(container, {
			preset: 'development',
			options: {lifecycle: {registerShutdownHook: vi.fn()}} as never
		})).rejects.toThrow(/known fields/)
		await expect(registerAudit(container, {
			preset: 'development',
			options: {clock: {now: () => 1}} as never
		})).rejects.toThrow(/known fields/)

		expect(container.has(TOK.Audit)).toBe(false)
		expect(registerShutdownHook).not.toHaveBeenCalled()
		expect(registerFlushHook).not.toHaveBeenCalled()
	})

	it('rolls back all tokens and awaits runtime shutdown after a binding failure', async() => {
		const store = createMemoryAuditStore()
		const shutdown = vi.fn(async() => store.shutdown?.())
		const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
		const container = {
			bind: vi.fn((token: symbol, value: unknown) => {
				values.set(token, value)
				if (token === TOK.AuditTransactional) throw new Error('bind failed')
			}),
			unbind: vi.fn((token: symbol) => values.delete(token)),
			get: (token: symbol) => values.get(token), tryGet: (token: symbol) => values.get(token),
			has: (token: symbol) => values.has(token)
		}
		await expect(registerAudit(container as never, {
			preset: 'custom', options: {
				store: {...store, shutdown},
				transactionalStore: {appendTransactional: (_transaction, records) => store.appendMany(records)},
				adminStore: store
			}
		})).rejects.toThrow('bind failed')
		expect(values.has(TOK.Audit)).toBe(false)
		expect(values.has(TOK.AuditTransactional)).toBe(false)
		expect(values.has(TOK.AuditAdmin)).toBe(false)
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('bounds registration rollback independently from a custom runtime timeout', async() => {
		vi.useFakeTimers()
		try {
			const shutdown = vi.fn(async() => await new Promise<void>(() => undefined))
			const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
			const container = {
				bind: vi.fn((token: symbol, value: unknown) => {
					values.set(token, value)
					if (token === TOK.Audit) throw new Error('bind failed')
				}),
				unbind: vi.fn((token: symbol) => values.delete(token)),
				get: (token: symbol) => values.get(token), tryGet: (token: symbol) => values.get(token),
				has: (token: symbol) => values.has(token)
			}
			const registration = registerAudit(container as never, {
				preset: 'custom',
				options: {
					store: {...createMemoryAuditStore(), shutdown},
					finalization: {shutdownTimeoutMs: 2_147_483_647}
				}
			})
			const rejected = expect(registration).rejects.toThrow(/registration and rollback failed/i)

			await vi.advanceTimersByTimeAsync(AUDIT_SHUTDOWN_TIMEOUT_MS)
			await rejected
			expect(values.has(TOK.Audit)).toBe(false)
			expect(shutdown).toHaveBeenCalledOnce()
		} finally { vi.useRealTimers() }
	})

	it('awaits construction rollback for owned custom resources', async() => {
		const shutdown = vi.fn(async() => undefined)
		await expect(createCustomAudit({
			clock: {now: () => 0},
			store: {...createMemoryAuditStore(), shutdown},
			lifecycle: {registerShutdownHook: vi.fn(() => { throw new Error('registration failed') })} as never
		})).rejects.toThrow('registration failed')
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('rolls back a bound store when later custom option validation fails', async() => {
		const shutdown = vi.fn(async() => undefined)
		await expect(createCustomAudit({
			clock: {now: () => 0},
			store: {...createMemoryAuditStore(), shutdown},
			redaction: {additionalRules: [{key: /^(a+)+$/u, action: 'mask'}]}
		})).rejects.toThrow(/redaction rule 0 is invalid/)
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('disposes an earlier lifecycle hook when later hook registration fails', async() => {
		const shutdown = vi.fn(async() => undefined)
		const disposeShutdownHook = vi.fn()
		await expect(createCustomAudit({
			clock: {now: () => 0},
			store: {...createMemoryAuditStore(), shutdown},
			lifecycle: {
				registerShutdownHook: vi.fn(() => disposeShutdownHook),
				registerFlushHook: vi.fn(() => { throw new Error('flush registration failed') })
			}
		})).rejects.toThrow('flush registration failed')

		expect(disposeShutdownHook).toHaveBeenCalledOnce()
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('bounds construction rollback when an owned custom resource never settles', async() => {
		vi.useFakeTimers()
		try {
			const shutdown = vi.fn(async() => await new Promise<void>(() => undefined))
			const construction = createCustomAudit({
				clock: {now: () => 0},
				store: {...createMemoryAuditStore(), shutdown},
				lifecycle: {registerShutdownHook: vi.fn(() => { throw new Error('registration failed') })} as never
			})
			const rejected = expect(construction).rejects.toThrow('registration failed')

			await vi.advanceTimersByTimeAsync(AUDIT_SHUTDOWN_TIMEOUT_MS)
			await rejected
			expect(shutdown).toHaveBeenCalledOnce()
		} finally { vi.useRealTimers() }
	})

	it('flushes and closes a distinct custom admin store it owns', async() => {
		const storeFlush = vi.fn()
		const storeShutdown = vi.fn()
		const adminFlush = vi.fn()
		const adminShutdown = vi.fn()
		const store = {...createMemoryAuditStore(), flush: storeFlush, shutdown: storeShutdown}
		const adminStore = {...createMemoryAuditStore(), flush: adminFlush, shutdown: adminShutdown}
		const runtime = await createCustomAudit({clock: {now: () => 0}, store, adminStore})

		await runtime.audit.flush()
		await runtime.audit.shutdown()

		expect(storeFlush).toHaveBeenCalledOnce()
		expect(adminFlush).toHaveBeenCalledOnce()
		expect(adminShutdown).toHaveBeenCalledOnce()
		expect(storeShutdown).toHaveBeenCalledOnce()
	})

	it('finalizes one physical adapter only once when store, admin, and archive capabilities alias', async() => {
		const backing = createMemoryAuditStore()
		const flush = vi.fn(async() => undefined)
		const shutdown = vi.fn(async() => undefined)
		const archive = vi.fn(async({records}) => records.length)
		const adapter = {...backing, archive, flush, shutdown}
		const runtime = await createCustomAudit({
			clock: {now: () => 0}, store: adapter, adminStore: adapter, archiveSink: adapter
		})

		await runtime.audit.flush()
		await runtime.audit.shutdown()

		expect(flush).toHaveBeenCalledOnce()
		expect(shutdown).toHaveBeenCalledOnce()
	})
})
