import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createCacheHandler} from '../../../src/cache/core/handler'
import {createMemoryCacheBackend} from '../../../src/cache/features/backends/memory'
import {
	attachCacheObservability,
	type CacheObservabilityEvent
} from '../../../src/cache/public/observability'

afterEach(() => vi.useRealTimers())

describe('cache P1 audit regressions', () => {
	it('does not let a cache-aside result overwrite a newer explicit write', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		const cache = createCacheHandler({clock, backend})
		let releaseLoader!: (value: string) => void
		let loaderStarted!: () => void
		const source = new Promise<string>((resolve) => { releaseLoader = resolve })
		const started = new Promise<void>((resolve) => { loaderStarted = resolve })

		const loading = cache.load('key', async() => { loaderStarted(); return await source })
		await started
		await cache.set('key', 'newer')
		releaseLoader('loaded')

		await expect(loading).resolves.toBe('loaded')
		await expect(cache.get('key')).resolves.toBe('newer')
	})

	it('serializes a newer explicit write behind an already-started loader write', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		const originalSet = backend.set.bind(backend)
		let releaseLoaderWrite!: () => void
		let loaderWriteStarted!: () => void
		const gate = new Promise<void>((resolve) => { releaseLoaderWrite = resolve })
		const started = new Promise<void>((resolve) => { loaderWriteStarted = resolve })
		let calls = 0
		backend.set = vi.fn(async(...arguments_) => {
			if (++calls === 1) { loaderWriteStarted(); await gate }
			await originalSet(...arguments_)
		})
		const cache = createCacheHandler({clock, backend})

		const loading = cache.load('key', async() => 'loaded')
		await started
		const writing = cache.set('key', 'newer')
		await Promise.resolve()
		expect(backend.set).toHaveBeenCalledOnce()
		releaseLoaderWrite()

		await Promise.all([loading, writing])
		await expect(cache.get('key')).resolves.toBe('newer')
	})

	it('orders broad invalidation after an accepted loader write', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		const originalSet = backend.set.bind(backend)
		let releaseLoaderWrite!: () => void
		let loaderWriteStarted!: () => void
		const gate = new Promise<void>((resolve) => { releaseLoaderWrite = resolve })
		const started = new Promise<void>((resolve) => { loaderWriteStarted = resolve })
		backend.set = vi.fn(async(...arguments_) => {
			loaderWriteStarted()
			await gate
			await originalSet(...arguments_)
		})
		const invalidate = vi.spyOn(backend, 'invalidate')
		const cache = createCacheHandler({clock, backend})

		const loading = cache.load('key', async() => 'loaded')
		await started
		const invalidating = cache.invalidate({namespace: 'default'})
		await Promise.resolve()
		expect(invalidate).not.toHaveBeenCalled()
		releaseLoaderWrite()

		await Promise.all([loading, invalidating])
		await expect(cache.get('key')).resolves.toBeUndefined()
	})

	it('does not close the backend while timed-out physical work remains unresolved', async() => {
		vi.useFakeTimers()
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		const originalSet = backend.set.bind(backend)
		const originalShutdown = backend.shutdown!.bind(backend)
		let releaseWrite!: () => void
		backend.set = vi.fn(async(...arguments_) => {
			await new Promise<void>((resolve) => { releaseWrite = resolve })
			await originalSet(...arguments_)
		})
		backend.shutdown = vi.fn(originalShutdown)
		const cache = createCacheHandler({clock, backend})

		const writing = cache.set('key', 'value')
		const timedOut = expect(writing).rejects.toThrow('timed out')
		await vi.advanceTimersByTimeAsync(2_000)
		await timedOut
		const shuttingDown = cache.shutdown()
		await vi.advanceTimersByTimeAsync(1_000)
		expect(backend.shutdown).not.toHaveBeenCalled()
		releaseWrite()
		await vi.advanceTimersByTimeAsync(0)

		await shuttingDown
		expect(backend.shutdown).toHaveBeenCalledOnce()
	})

	it('recovers health when timed-out physical work later succeeds', async() => {
		vi.useFakeTimers()
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		let releaseRead!: () => void
		backend.get = vi.fn(async() => await new Promise<undefined>((resolve) => {
			releaseRead = () => resolve(undefined)
		}))
		const cache = createCacheHandler({clock, backend})

		const reading = cache.get('key')
		const timedOut = expect(reading).rejects.toThrow('timed out')
		await vi.advanceTimersByTimeAsync(2_000)
		await timedOut
		expect(cache.getStatus()).toMatchObject({
			backendState: 'degraded', lastFailureCode: 'CACHE_BACKEND_TIMEOUT'
		})

		releaseRead()
		await vi.advanceTimersByTimeAsync(0)
		expect(cache.getStatus()).toMatchObject({backendState: 'healthy'})
	})

	it('recovers from a timed-out flush when the physical flush later succeeds', async() => {
		vi.useFakeTimers()
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		let releaseFlush!: () => void
		backend.flush = vi.fn(async() => await new Promise<void>((resolve) => {
			releaseFlush = resolve
		}))
		const cache = createCacheHandler({clock, backend})

		const flushing = cache.flush()
		const timedOut = expect(flushing).rejects.toThrow('flush timed out')
		await vi.advanceTimersByTimeAsync(5_000)
		await timedOut
		expect(cache.getStatus()).toMatchObject({
			backendState: 'degraded', lastFailureCode: 'CACHE_BACKEND_TIMEOUT'
		})

		releaseFlush()
		await vi.advanceTimersByTimeAsync(0)
		expect(cache.getStatus()).toMatchObject({backendState: 'healthy'})
	})

	it('recovers health after a failed flush is retried successfully', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		backend.flush = vi.fn()
			.mockRejectedValueOnce(new Error('flush failed'))
			.mockResolvedValueOnce(undefined)
		const cache = createCacheHandler({clock, backend})

		await expect(cache.flush()).rejects.toThrow('flush failed')
		expect(cache.getStatus()).toMatchObject({
			backendState: 'unhealthy', lastFailureCode: 'CACHE_FLUSH_FAILURE'
		})
		await expect(cache.flush()).resolves.toBeUndefined()
		expect(cache.getStatus()).toMatchObject({backendState: 'healthy'})
	})

	it('does not report persistent corrupt backend data as repeated recoveries', async() => {
		const clock = createFixedClock(0)
		const memory = createMemoryCacheBackend({clock})
		const value = new TextEncoder().encode('"value"')
		const backend = {
			...memory,
			get: vi.fn(async() => ({
				value,
				metadata: {
					key: 'wrong-key', namespace: 'default', version: 'v1', createdAt: 0,
					negative: false, sizeBytes: value.byteLength
				}
			}))
		}
		const cache = createCacheHandler({clock, backend})
		const events: CacheObservabilityEvent[] = []
		attachCacheObservability(cache, (event) => events.push(event))

		await expect(cache.get('key')).resolves.toBeUndefined()
		await expect(cache.get('key')).resolves.toBeUndefined()
		expect(events.filter((event) => event.kind === 'backend_failed')).toHaveLength(2)
		expect(events.filter((event) => event.kind === 'recovered')).toHaveLength(0)
		expect(cache.getStatus()).toMatchObject({
			backendState: 'unhealthy', lastFailureCode: 'CACHE_CORRUPT_ENTRY'
		})
	})

	it('recovers corrupt-data health only after a semantically valid read', async() => {
		const clock = createFixedClock(0)
		const memory = createMemoryCacheBackend({clock})
		const value = new TextEncoder().encode('"value"')
		const get = vi.fn()
			.mockResolvedValueOnce({
				value,
				metadata: {
					key: 'wrong-key', namespace: 'default', version: 'v1', createdAt: 0,
					negative: false, sizeBytes: value.byteLength
				}
			})
			.mockResolvedValueOnce(undefined)
		const cache = createCacheHandler({clock, backend: {...memory, get}})

		await cache.get('key')
		expect(cache.getStatus()).toMatchObject({backendState: 'unhealthy'})
		await cache.get('key')
		expect(cache.getStatus()).toMatchObject({backendState: 'healthy'})
	})

	it('does not treat malformed mutation results as successful recovery', async() => {
		const clock = createFixedClock(0)
		const memory = createMemoryCacheBackend({clock})
		const cache = createCacheHandler({clock, backend: {...memory, delete: vi.fn(async() => 2)}})
		const events: CacheObservabilityEvent[] = []
		attachCacheObservability(cache, (event) => events.push(event))

		await expect(cache.delete('key')).rejects.toThrow('invalid delete result')
		await expect(cache.delete('key')).rejects.toThrow('invalid delete result')
		expect(events.filter((event) => event.kind === 'backend_failed')).toHaveLength(2)
		expect(events.filter((event) => event.kind === 'recovered')).toHaveLength(0)
	})

	it('does not serve stale fallback while an accepted delete remains pending', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		const originalDelete = backend.delete.bind(backend)
		let releaseDelete!: () => void
		let deleteStarted!: () => void
		const gate = new Promise<void>((resolve) => { releaseDelete = resolve })
		const started = new Promise<void>((resolve) => { deleteStarted = resolve })
		backend.delete = vi.fn(async(...arguments_) => {
			deleteStarted()
			await gate
			return await originalDelete(...arguments_)
		})
		const cache = createCacheHandler({clock, backend})
		await cache.set('key', 'old', {ttlMs: 10, staleTtlMs: 100})
		clock.advanceBy(11)

		const deleting = cache.delete('key')
		await started
		const loading = expect(cache.load('key', async() => {
			throw new Error('source unavailable')
		}, {ttlMs: 10, staleTtlMs: 100, staleIfError: true}))
			.rejects.toThrow('source unavailable')
		await Promise.resolve()
		releaseDelete()
		await Promise.all([deleting, loading])
	})

	it('does not return a fresh value after an overlapping delete was accepted', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		const originalDelete = backend.delete.bind(backend)
		let releaseDelete!: () => void
		let deleteStarted!: () => void
		const gate = new Promise<void>((resolve) => { releaseDelete = resolve })
		const started = new Promise<void>((resolve) => { deleteStarted = resolve })
		backend.delete = vi.fn(async(...arguments_) => {
			deleteStarted()
			await gate
			return await originalDelete(...arguments_)
		})
		const cache = createCacheHandler({clock, backend})
		await cache.set('key', 'old')

		const deleting = cache.delete('key')
		await started
		const reading = cache.get('key')
		await Promise.resolve()
		releaseDelete()

		await deleting
		await expect(reading).resolves.toBeUndefined()
	})

	it('does not serve batch stale fallback during a pending broad invalidation', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		const originalInvalidate = backend.invalidate.bind(backend)
		let releaseInvalidate!: () => void
		let invalidateStarted!: () => void
		const gate = new Promise<void>((resolve) => { releaseInvalidate = resolve })
		const started = new Promise<void>((resolve) => { invalidateStarted = resolve })
		backend.invalidate = vi.fn(async(...arguments_) => {
			invalidateStarted()
			await gate
			return await originalInvalidate(...arguments_)
		})
		const cache = createCacheHandler({clock, backend})
		await cache.setMany([{key: 'a', value: 'old-a'}, {key: 'b', value: 'old-b'}], {
			ttlMs: 10, staleTtlMs: 100
		})
		clock.advanceBy(11)

		const invalidating = cache.invalidate({namespace: 'default'})
		await started
		const loading = expect(cache.loadMany(['a', 'b'], async() => {
			throw new Error('source unavailable')
		}, {ttlMs: 10, staleTtlMs: 100, staleIfError: true}))
			.rejects.toThrow('source unavailable')
		await Promise.resolve()
		releaseInvalidate()
		await Promise.all([invalidating, loading])
	})

	it('flushes accepted writes before backend shutdown', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		let releaseWrite!: () => void
		const gate = new Promise<void>((resolve) => { releaseWrite = resolve })
		const originalSet = backend.set.bind(backend)
		const order: string[] = []
		backend.set = vi.fn(async(...arguments_) => { await gate; await originalSet(...arguments_) })
		backend.flush = vi.fn(async() => { order.push('flush') })
		backend.shutdown = vi.fn(async() => { order.push('shutdown') })
		const cache = createCacheHandler({clock, backend})

		const writing = cache.set('key', 'value')
		const flushing = cache.flush()
		await Promise.resolve()
		expect(backend.flush).not.toHaveBeenCalled()
		releaseWrite()
		await Promise.all([writing, flushing])
		await cache.shutdown()

		expect(order.at(-1)).toBe('shutdown')
		expect(order.slice(0, 2)).toEqual(['flush', 'shutdown'])
	})

	it('rejects backend flush re-entry without retaining a self-await cycle', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		let cache!: ReturnType<typeof createCacheHandler>
		let reenter = true
		backend.flush = vi.fn(async() => {
			await Promise.resolve()
			if (reenter) await cache.flush()
		})
		cache = createCacheHandler({clock, backend})

		await expect(cache.flush()).rejects.toThrow('CACHE_FINALIZATION_REENTRY')
		reenter = false
		await expect(cache.flush()).resolves.toBeUndefined()
		await expect(cache.shutdown()).resolves.toBeUndefined()
	})

	it('rejects backend shutdown re-entry and permits a clean retry', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		let cache!: ReturnType<typeof createCacheHandler>
		let reenter = true
		backend.shutdown = vi.fn(async() => {
			await Promise.resolve()
			if (reenter) await cache.shutdown()
		})
		cache = createCacheHandler({clock, backend})

		await expect(cache.shutdown()).rejects.toThrow('CACHE_FINALIZATION_REENTRY')
		expect(cache.getStatus()).toMatchObject({state: 'draining', backendState: 'unhealthy'})
		reenter = false
		await expect(cache.shutdown()).resolves.toBeUndefined()
		expect(cache.getStatus()).toMatchObject({state: 'closed', backendState: 'closed'})
	})
})
