import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CacheBackendPort} from '@ooopsstudio/core/ports/cache'
import {describe, expect, it, vi} from 'vitest'

import {createCacheHandler} from '../../../src/cache/core/handler'
import {createMemoryCacheBackend} from '../../../src/cache/features/backends/memory'

function setup(now = 0) {
	let time = now
	const clock: Clock = {now: () => time}
	const backend = createMemoryCacheBackend({clock})
	return {clock, backend, cache: createCacheHandler({clock, backend}), advanceBy: (ms: number) => { time += ms }}
}

describe('managed cache handler', () => {
	it('supports CRUD, batches, namespace scoping, versions and invalidation', async() => {
		const {cache} = setup()
		await cache.set('one', {value: 1})
		await cache.setMany([{key: 'two', value: 2}, {key: 'three', value: 3}])
		expect(await cache.get('one')).toEqual({value: 1})
		expect(await cache.getMany<number>(['two', 'three'])).toEqual(new Map([['two', 2], ['three', 3]]))

		const scoped = cache.namespace('tenant', {version: 'v2'})
		await scoped.set('one', 'scoped')
		expect(await scoped.get('one')).toBe('scoped')
		expect(await cache.get('one')).toEqual({value: 1})
		expect(await cache.invalidate({namespace: 'tenant', version: 'v2'})).toBe(1)
		expect(await scoped.get('one')).toBeUndefined()

		await cache.deleteMany(['two', 'three'])
		expect(await cache.getMany(['two', 'three'])).toEqual(new Map())
	})

	it('uses fixed TTL, negative caching and stale-if-error without renewal', async() => {
		const {cache, advanceBy} = setup()
		await cache.set('fixed', 'value', {ttlMs: 10, staleTtlMs: 20})
		advanceBy(11)
		expect(await cache.get('fixed')).toBeUndefined()
		await expect(cache.load('fixed', async() => { throw new Error('source unavailable') }, {
			ttlMs: 10, staleTtlMs: 20, staleIfError: true
		})).resolves.toBe('value')
		advanceBy(20)
		expect(await cache.get('fixed')).toBeUndefined()

		let loads = 0
		expect(await cache.load('missing', async() => { loads++; return undefined }, {negativeTtlMs: 10})).toBeUndefined()
		expect(await cache.load('missing', async() => { loads++; return 'late' }, {negativeTtlMs: 10})).toBeUndefined()
		expect(loads).toBe(1)
	})

	it('preserves null loader values and reserves undefined for negative cache misses', async() => {
		const {cache} = setup()
		const singleLoader = vi.fn(async() => null)
		await expect(cache.load<null>('single-null', singleLoader, {negativeTtlMs: 10})).resolves.toBeNull()
		await expect(cache.load<null>('single-null', async() => { throw new Error('must not reload') }))
			.resolves.toBeNull()
		expect(singleLoader).toHaveBeenCalledOnce()

		const batchLoader = vi.fn(async() => new Map<string, null | undefined>([
			['null', null],
			['missing', undefined]
		]))
		await expect(cache.loadMany<null | undefined>(['null', 'missing'], batchLoader, {negativeTtlMs: 10}))
			.resolves.toEqual(new Map([['null', null]]))
		await expect(cache.loadMany<null | undefined>(['null', 'missing'], async() => {
			throw new Error('must not reload')
		})).resolves.toEqual(new Map([['null', null]]))
		expect(batchLoader).toHaveBeenCalledOnce()
	})

	it('coalesces cache-aside loaders and isolates scoped lifecycle capability', async() => {
		const {cache} = setup()
		let resolve!: (value: string) => void
		const source = new Promise<string>((done) => { resolve = done })
		const loader = vi.fn(async() => source)
		const first = cache.load('shared', loader)
		const second = cache.load('shared', loader)
		resolve('value')
		await expect(Promise.all([first, second])).resolves.toEqual(['value', 'value'])
		expect(loader).toHaveBeenCalledOnce()

		const scoped = cache.namespace('scoped')
		expect(scoped).not.toHaveProperty('shutdown')
		expect(scoped).not.toHaveProperty('flush')
		expect(scoped).not.toHaveProperty('getStatus')
	})

	it('returns a frozen, synchronous and limited status snapshot', async() => {
		const {cache} = setup()
		const status = cache.getStatus()
		expect(status).toEqual({
			state: 'running', activeOperations: 0, activeLoads: 0,
			droppedTotal: 0, backendState: 'healthy'
		})
		expect(Object.isFrozen(status)).toBe(true)
		expect(status).not.toHaveProperty('backend')
		expect(status).not.toHaveProperty('stats')
		expect(status).not.toHaveProperty('lastError')
		await cache.shutdown()
		expect(cache.getStatus()).toEqual(expect.objectContaining({state: 'closed', backendState: 'closed'}))
	})

	it('closes admission synchronously and shares concurrent shutdown', async() => {
		let release!: () => void
		const closed = new Promise<void>((resolve) => { release = resolve })
		const shutdown = vi.fn(async() => closed)
		const {clock, backend} = setup()
		const cache = createCacheHandler({clock, backend: {...backend, shutdown}})
		const first = cache.shutdown()
		const second = cache.shutdown()
		expect(cache.getStatus().state).toBe('draining')
		await expect(cache.get('late')).rejects.toThrow('shutting down')
		release()
		await Promise.all([first, second])
		expect(shutdown).toHaveBeenCalledOnce()
		expect(cache.getStatus().state).toBe('closed')
	})

	it('keeps failed finalization retryable without reopening admission', async() => {
		const {clock, backend} = setup()
		const shutdown = vi.fn()
			.mockRejectedValueOnce(new Error('close failed'))
			.mockResolvedValueOnce(undefined)
		const cache = createCacheHandler({clock, backend: {...backend, shutdown}})
		await expect(cache.shutdown()).rejects.toThrow('close failed')
		expect(cache.getStatus()).toMatchObject({
			state: 'draining', backendState: 'unhealthy', lastFailureCode: 'CACHE_SHUTDOWN_FAILURE'
		})
		await expect(cache.set('late', 1)).rejects.toThrow('shutting down')
		await expect(cache.shutdown()).resolves.toBeUndefined()
		expect(shutdown).toHaveBeenCalledTimes(2)
		expect(cache.getStatus().state).toBe('closed')
	})

	it('flushes without closing admission and disposes both lifecycle hooks once', async() => {
		const flushDisposer = vi.fn()
		const shutdownDisposer = vi.fn()
		let flushHook: (() => Promise<void>) | undefined
		let shutdownHook: (() => Promise<void>) | undefined
		const lifecycle = {
			registerFlushHook: vi.fn((_name, hook) => { flushHook = hook; return flushDisposer }),
			registerShutdownHook: vi.fn((_group, hook) => { shutdownHook = hook; return shutdownDisposer })
		} as never
		const {clock, backend} = setup()
		const flush = vi.fn(async() => undefined)
		const cache = createCacheHandler({clock, backend: {...backend, flush}, lifecycle})
		await cache.set('before', 1)
		await flushHook?.()
		await cache.set('after', 2)
		await shutdownHook?.()
		await cache.shutdown()
		expect(flush).toHaveBeenCalled()
		expect(flushDisposer).toHaveBeenCalledOnce()
		expect(shutdownDisposer).toHaveBeenCalledOnce()
	})

	it('captures backend methods once and rejects incomplete backends', async() => {
		const {clock, backend} = setup()
		const originalGet = vi.fn(backend.get.bind(backend))
		const external = {...backend, get: originalGet}
		const cache = createCacheHandler({clock, backend: external})
		external.get = vi.fn(async() => { throw new Error('replacement') }) as CacheBackendPort['get']
		await expect(cache.get('key')).resolves.toBeUndefined()
		expect(originalGet).toHaveBeenCalledOnce()
		expect(() => createCacheHandler({clock, backend: {get: vi.fn()} as never})).toThrow('complete backend')
	})
})
