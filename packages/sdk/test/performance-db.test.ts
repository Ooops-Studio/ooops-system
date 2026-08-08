import {describe, expect, it, vi} from 'vitest'

import {
	measureDrizzleQuery,
	measureKyselyQuery,
	measurePgQuery,
	measurePrismaQuery
} from '../src/performance-db'

describe('performance DB helpers', () => {
	it('normalizes pg metadata without exposing raw SQL', async() => {
		const calls: Array<unknown[]> = []

		const result = await measurePgQuery(
			async() => ({rowCount: 2}),
			{
				text: 'select * from projects where id = $1',
				labels: {driver: 'spoofed', key: 'private', bearer: 'private'},
				performance: {
					measureDBQuery: async(name, fn, metadata, labels) => {
						calls.push([name, metadata, labels])
						return await fn()
					}
				}
			}
		)

		expect(result.rowCount).toBe(2)
		expect(calls[0]?.[1]).toMatchObject({
			operation: 'select',
			table: 'projects',
			collection: 'projects',
			success: true
		})
		expect((calls[0]?.[1] as {query?: string}).query).toBeUndefined()
		expect((calls[0]?.[2] as Record<string, string>).driver).toBe('pg')
		expect(JSON.stringify(calls)).not.toContain('private')
	})

	it('supports drizzle, prisma, and kysely wrappers', async() => {
		const calls: Array<unknown[]> = []
		const performance = {
			measureDBQuery: async(name: string, fn: () => Promise<unknown>, metadata?: unknown, labels?: unknown) => {
				calls.push([name, metadata, labels])
				return await fn()
			}
		}

		await measureDrizzleQuery(async() => ([{id: 1}]), {
			sql: 'select * from tasks',
			performance
		})
		await measurePrismaQuery(async() => ([{id: 1}, {id: 2}]), {
			model: 'User',
			action: 'findMany',
			performance
		})
		await measureKyselyQuery(async() => ({rows: [{id: 1}]}), {
			sql: 'update projects set name = $1 where id = $2',
			performance
		})

		expect(calls[0]?.[1]).toMatchObject({table: 'tasks'})
		expect(calls[1]?.[1]).toMatchObject({collection: 'User', operation: 'findMany'})
		expect(calls[2]?.[1]).toMatchObject({operation: 'update', table: 'projects'})
	})

	it('falls back without a performance port and records failed query metadata', async() => {
		await expect(measurePgQuery(async() => 'plain', {})).resolves.toBe('plain')
		const metadata: Array<Record<string, unknown>> = []
		await expect(measurePgQuery(async() => { throw new Error('db offline') }, {
			query: 'delete from sessions',
			performance: {
				measureDBQuery: async(_name, fn, nextMetadata) => {
					metadata.push(nextMetadata ?? {})
					return await fn()
				}
			}
		})).rejects.toThrow('db offline')
		expect(metadata[0]).toMatchObject({
			operation: 'delete', table: 'sessions', success: false, failureCode: 'query_failed'
		})
	})

	it('does not derive query fingerprints from SQL literals', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const performance = {measureDBQuery: async(_name: string, operation: () => Promise<unknown>, current: Record<string, unknown>) => {
			metadata.push(current)
			return await operation()
		}}
		for (const password of ['alpha-private', 'beta-private']) {
			await measurePgQuery(async() => [], {
				text: `select * from users where password = '${password}'`, performance
			})
		}

		expect(metadata[0]?.queryHash).toBe(metadata[1]?.queryHash)
		expect(JSON.stringify(metadata)).not.toContain('private')
	})

	it('derives metadata from explicit table, collection, rows, and result shapes', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const performance = {measureDBQuery: async(_name: string, fn: () => Promise<unknown>, next: Record<string, unknown>) => {
			metadata.push(next)
			return await fn()
		}}
		await measureKyselyQuery(async() => ({count: 3}), {operation: 'create', table: 'projects', collection: 'projects', rows: 2, performance})
		await measureDrizzleQuery(async() => [{id: 1}], {sql: 'merge into audit', performance})
		expect(metadata[0]).toMatchObject({method: 'create', table: 'projects', collection: 'projects', rows: 2})
		expect(metadata[1]).toMatchObject({operation: 'merge', method: 'get', rows: 1})
	})

	it('isolates measurement-port failures without double-running DB operations', async() => {
		const operation = vi.fn(async() => 'ok')
		await expect(measurePgQuery(operation, {
			query: 'select * from users',
			performance: {measureDBQuery: async() => { throw new Error('start failed') }}
		})).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledOnce()

		await expect(measurePgQuery(operation, {
			query: 'select * from users',
			performance: {measureDBQuery: async(_name, fn) => {
				await fn()
				throw new Error('finish failed')
			}}
		})).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(2)

		const original = new Error('query failed')
		await expect(measurePgQuery(async() => { throw original }, {
			performance: {measureDBQuery: async(_name, fn) => await fn()}
		})).rejects.toBe(original)
		await expect(measurePgQuery(operation, {
			performance: {measureDBQuery: async() => undefined as never}
		})).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(3)

		await expect(measurePgQuery(async() => 'authoritative', {
			performance: {measureDBQuery: async(_name, fn) => { await fn(); return 'replacement' }}
		})).resolves.toBe('authoritative')
		const swallowedFailure = new Error('must propagate')
		await expect(measurePgQuery(async() => { throw swallowedFailure }, {
			performance: {measureDBQuery: async(_name, fn) => {
				try { await fn() } catch { return 'swallowed' }
				return 'swallowed'
			}}
		})).rejects.toBe(swallowedFailure)
		const duplicated = vi.fn(async() => 'once')
		await expect(measurePgQuery(duplicated, {
			performance: {measureDBQuery: async(_name, fn) => { await fn(); return await fn() }}
		})).resolves.toBe('once')
		expect(duplicated).toHaveBeenCalledOnce()

		let release!: (value: string) => void
		const detachedOperation = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
		const detached = measurePgQuery(detachedOperation, {
			performance: {measureDBQuery: async(_name, fn) => { void fn() }}
		})
		await Promise.resolve()
		let settled = false
		void detached.then(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		release('completed')
		await expect(detached).resolves.toBe('completed')
		expect(detachedOperation).toHaveBeenCalledOnce()

		const hangingPortOperation = vi.fn(async() => 'not-blocked')
		await expect(measurePgQuery(hangingPortOperation, {
			performance: {measureDBQuery: async(_name, fn) => {
				await fn()
				return await new Promise<never>(() => {})
			}}
		})).resolves.toBe('not-blocked')
		expect(hangingPortOperation).toHaveBeenCalledOnce()

		const readThen = vi.fn(() => { throw new Error('must not assimilate') })
		const thenableOperation = vi.fn(async() => 'thenable-safe')
		await expect(measurePgQuery(thenableOperation, {
			performance: {measureDBQuery: ((_name, fn) => {
				void fn()
				return Object.defineProperty({}, 'then', {get: readThen})
			}) as never}
		})).resolves.toBe('thenable-safe')
		expect(thenableOperation).toHaveBeenCalledOnce()
		expect(readThen).not.toHaveBeenCalled()
	})

	it('does not let result-shape getters turn successful queries into failures', async() => {
		const readRowCount = vi.fn(() => { throw new Error('row count failed') })
		const result = Object.defineProperty({}, 'rowCount', {enumerable: true, get: readRowCount})
		await expect(measurePgQuery(async() => result, {
			performance: {measureDBQuery: async(_name, fn) => await fn()}
		})).resolves.toBe(result)
		expect(readRowCount).not.toHaveBeenCalled()

		const has = vi.fn(() => true)
		const descriptor = vi.fn(() => ({configurable: true, enumerable: true, value: 2}))
		const proxy = new Proxy({}, {has, getOwnPropertyDescriptor: descriptor})
		await expect(measurePgQuery(async() => proxy, {
			performance: {measureDBQuery: async(_name, fn) => await fn()}
		})).resolves.toBe(proxy)
		expect(has).not.toHaveBeenCalled()
		expect(descriptor).not.toHaveBeenCalled()
	})

	it('falls back exactly once when adapter options have hostile getters', async() => {
		const operation = vi.fn(async() => 'ok')
		const queryOptions = {
			get query(): string { throw new Error('query failed') }
		}
		await expect(measurePgQuery(operation, queryOptions)).resolves.toBe('ok')

		const performanceOptions = {
			get performance(): never { throw new Error('performance failed') }
		}
		await expect(measurePgQuery(operation, performanceOptions)).resolves.toBe('ok')
		const methodAccessor = Object.defineProperty({}, 'measureDBQuery', {
			get: () => { throw new Error('measureDBQuery failed') }
		})
		await expect(measurePgQuery(operation, {performance: methodAccessor})).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(3)
	})

	it('rejects proxy adapter options before invoking ownKeys', async() => {
		const ownKeys = vi.fn(() => ['query'])
		const options = new Proxy({}, {ownKeys})
		const operation = vi.fn(async() => 'ok')
		await expect(measurePgQuery(operation, options as never)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledOnce()
		expect(ownKeys).not.toHaveBeenCalled()
	})

	it('does not inspect Proxy prototypes or label accessors', async() => {
		const operation = vi.fn(async() => 'ok')
		const prototypeDescriptor = vi.fn(() => { throw new Error('must not inspect') })
		const performance = Object.create(new Proxy({}, {getOwnPropertyDescriptor: prototypeDescriptor}))
		await expect(measurePgQuery(operation, {performance})).resolves.toBe('ok')
		expect(prototypeDescriptor).not.toHaveBeenCalled()

		const readLabel = vi.fn(() => 'secret')
		const labels = Object.defineProperty({}, 'tenant', {enumerable: true, get: readLabel})
		const measureDBQuery = vi.fn(async(_name, fn) => await fn())
		await expect(measurePgQuery(operation, {
			performance: {measureDBQuery}, labels: labels as never
		})).resolves.toBe('ok')
		expect(measureDBQuery).toHaveBeenCalledOnce()
		expect(readLabel).not.toHaveBeenCalled()
	})
})
