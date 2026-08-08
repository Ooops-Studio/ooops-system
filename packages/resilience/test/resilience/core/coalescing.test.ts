import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createCoalescingEngine} from '../../../src/resilience/core/coalescing'

describe('coalescing-engine', () => {
	it('validates configuration eagerly', () => {

		const clock = createFixedClock(100)
		expect(() => createCoalescingEngine({
			clock,
			config: {
				maxKeys: 0,
				evictionPolicy: 'TTL',
				ttlMs: 10
			}
		})).toThrow(/maxKeys/i)

		expect(() => createCoalescingEngine({
			clock,
			config: {
				maxKeys: 1,
				evictionPolicy: 'TTL',
				ttlMs: 0
			}
		})).toThrow(/ttlMs/i)

		expect(() => createCoalescingEngine({
			clock,
			config: {maxKeys: 1, evictionPolicy: 'invalid' as never, ttlMs: 10}
		})).toThrow(/evictionPolicy/i)

		const coerce = vi.fn(() => 1)
		expect(() => createCoalescingEngine({
			clock,
			config: {maxKeys: {[Symbol.toPrimitive]: coerce}, evictionPolicy: 'TTL', ttlMs: 10} as never
		})).toThrow(/maxKeys/u)
		expect(coerce).not.toHaveBeenCalled()

	})

	it('shares only in-flight work for the same key and removes settled entries', async() => {

		const clock = createFixedClock(100)
		const engine = createCoalescingEngine<string>({
			clock,
			config: {
				maxKeys: 10,
				evictionPolicy: 'TTL',
				ttlMs: 1000
			}
		})

		let calls = 0
		let release!: () => void
		const promise = engine.getOrCreate('search', 'tenant', 't-1', async() => {
			calls++
			await new Promise<void>((resolve) => {
				release = resolve
			})
			return 'value'
		})
		const second = engine.getOrCreate('search', 'tenant', 't-1', async() => {
			calls++
			return 'other'
		})

		await vi.waitFor(() => expect(typeof release).toBe('function'))
		release()
		await expect(promise).resolves.toEqual({value: 'value', shared: false})
		await expect(second).resolves.toEqual({value: 'value', shared: true})
		expect(calls).toBe(1)

		await expect(engine.getOrCreate('search', 'tenant', 't-2', async() => {
			throw new Error('fail')
		})).rejects.toThrow('fail')

		const next = await engine.getOrCreate('search', 'tenant', 't-2', async() => 'fresh')
		expect(next).toEqual({value: 'fresh', shared: false})

	})

	it('supports destroy for in-flight entries', async() => {

		const clock = createFixedClock(1_000)
		const engine = createCoalescingEngine<string>({
			clock,
			config: {
				maxKeys: 3,
				evictionPolicy: 'TTL',
				ttlMs: 50
			}
		})

		let releaseA!: () => void
		let releaseB!: () => void
		const pendingA = engine.getOrCreate('cache', 'resource', 'a', async() => {
			await new Promise<void>((resolve) => {
				releaseA = resolve
			})
			return 'A'
		})
		const pendingB = engine.getOrCreate('cache', 'resource', 'b', async() => {
			await new Promise<void>((resolve) => {
				releaseB = resolve
			})
			return 'B'
		})
		await vi.waitFor(() => {
			expect(typeof releaseA).toBe('function')
			expect(typeof releaseB).toBe('function')
		})
		releaseA()
		releaseB()
		await expect(pendingA).resolves.toEqual({value: 'A', shared: false})
		await expect(pendingB).resolves.toEqual({value: 'B', shared: false})

		let releaseC!: () => void
		const pendingC = engine.getOrCreate('cache', 'resource', 'c', async() => {
			await new Promise<void>((resolve) => {
				releaseC = resolve
			})
			return 'C'
		})
		await vi.waitFor(() => expect(typeof releaseC).toBe('function'))
		engine.destroy()
		releaseC()
		await expect(pendingC).resolves.toEqual({value: 'C', shared: false})
		await expect(engine.getOrCreate('cache', 'resource', 'c', async() => 'after-destroy')).rejects.toThrow('Coalescing destroyed')

	})

	it('does not start a deferred factory after immediate destroy', async() => {
		const engine = createCoalescingEngine<string>({
			clock: createFixedClock(0),
			config: {maxKeys: 1, evictionPolicy: 'TTL', ttlMs: 100}
		})
		const factory = vi.fn(async() => 'side effect')
		const pending = engine.getOrCreate('write', 'resource', 'same', factory)
		const destroyed = expect(pending).rejects.toThrow('Coalescing destroyed')
		engine.destroy()

		await destroyed
		expect(factory).not.toHaveBeenCalled()
	})

	it('publishes ownership before invoking a reentrant factory', async() => {
		const engine = createCoalescingEngine<string>({
			clock: createFixedClock(0),
			config: {maxKeys: 2, evictionPolicy: 'TTL', ttlMs: 100}
		})
		const duplicate = vi.fn(async() => 'duplicate')
		let nested: Promise<{value: string; shared: boolean}> | undefined
		const ownerFactory = vi.fn(async() => {
			nested = engine.getOrCreate('write', 'resource', 'same', duplicate)
			return 'owner'
		})

		await expect(engine.getOrCreate('write', 'resource', 'same', ownerFactory))
			.resolves.toEqual({value: 'owner', shared: false})
		await expect(nested).resolves.toEqual({value: 'owner', shared: true})
		expect(ownerFactory).toHaveBeenCalledTimes(1)
		expect(duplicate).not.toHaveBeenCalled()
	})

	it('rejects a same-key ownership cycle instead of hanging forever', async() => {
		const engine = createCoalescingEngine<string>({
			clock: createFixedClock(0),
			config: {maxKeys: 2, evictionPolicy: 'TTL', ttlMs: 100}
		})
		const duplicate = vi.fn(async() => 'duplicate')

		await expect(engine.getOrCreate('write', 'resource', 'same', async() => {
			const nested = await engine.getOrCreate('write', 'resource', 'same', duplicate)
			return nested.value
		})).rejects.toThrow('Coalescing ownership cycle detected')
		expect(duplicate).not.toHaveBeenCalled()

		await expect(engine.getOrCreate('write', 'resource', 'same', async() => 'recovered'))
			.resolves.toEqual({value: 'recovered', shared: false})
	})

	it('rejects a multi-key ownership cycle and releases every claim', async() => {
		const engine = createCoalescingEngine<string>({
			clock: createFixedClock(0),
			config: {maxKeys: 2, evictionPolicy: 'TTL', ttlMs: 100}
		})

		await expect(engine.getOrCreate('write', 'resource', 'a', async() => {
			const nested = await engine.getOrCreate('write', 'resource', 'b', async() => {
				const cycle = await engine.getOrCreate('write', 'resource', 'a', async() => 'duplicate')
				return cycle.value
			})
			return nested.value
		})).rejects.toThrow('Coalescing ownership cycle detected')

		await expect(engine.getOrCreate('write', 'resource', 'a', async() => 'A'))
			.resolves.toEqual({value: 'A', shared: false})
		await expect(engine.getOrCreate('write', 'resource', 'b', async() => 'B'))
			.resolves.toEqual({value: 'B', shared: false})
	})

	it('supports deep acyclic ownership chains without copying every ancestor set', async() => {
		const depth = 1_000
		const engine = createCoalescingEngine<number>({
			clock: createFixedClock(0),
			config: {maxKeys: depth, evictionPolicy: 'TTL', ttlMs: 100}
		})
		let factories = 0
		const visit = async(index: number): Promise<number> => {
			const result = await engine.getOrCreate('chain', 'resource', String(index), async() => {
				factories++
				return index + 1 < depth ? await visit(index + 1) : index
			})
			return result.value
		}

		await expect(visit(0)).resolves.toBe(depth - 1)
		expect(factories).toBe(depth)
		await expect(engine.getOrCreate('chain', 'resource', 'fresh', async() => depth))
			.resolves.toEqual({value: depth, shared: false})
	})

	it('snapshots capacity so later config mutation cannot widen the active map', async() => {
		const mutableConfig = {maxKeys: 1, evictionPolicy: 'TTL' as const, ttlMs: 100}
		const engine = createCoalescingEngine<string>({clock: createFixedClock(0), config: mutableConfig})
		;(mutableConfig as {maxKeys: number}).maxKeys = 10_000
		let release!: () => void
		const owner = engine.getOrCreate('owner', 'resource', 'one', async() => {
			await new Promise<void>((resolve) => { release = resolve })
			return 'owner'
		})
		const overflow = engine.getOrCreate('owner', 'resource', 'two', async() => 'overflow')
		const overflowFailure = expect(overflow).rejects.toThrow('Coalescing capacity reached')

		await vi.waitFor(() => expect(typeof release).toBe('function'))
		release()
		await expect(owner).resolves.toEqual({value: 'owner', shared: false})
		await overflowFailure
	})

	it('preserves active single-flight entries when the coalescing map reaches capacity', async() => {

		const clock = createFixedClock(10)
		const engine = createCoalescingEngine<string>({
			clock,
			config: {
				maxKeys: 2,
				evictionPolicy: 'LRU',
				ttlMs: 10_000
			}
		})

		let releaseA!: () => void
		const releaseB: Array<() => void> = []
		const factoryA = vi.fn(async() => {
			await new Promise<void>((resolve) => {
				releaseA = resolve
			})
			return 'A'
		})
		const factoryB = vi.fn(async() => {
			await new Promise<void>((resolve) => {
				releaseB.push(resolve)
			})
			return 'B'
		})
		const factoryC = vi.fn(async() => 'C')

		const pendingA = engine.getOrCreate('asset', 'resource', 'a', factoryA)
		clock.advanceBy(1)
		const pendingB = engine.getOrCreate('asset', 'resource', 'b', factoryB)
		clock.advanceBy(1)
		const sharedA = engine.getOrCreate('asset', 'resource', 'a', factoryA)
		clock.advanceBy(1)
		const pendingC = engine.getOrCreate('asset', 'resource', 'c', factoryC)
		const pendingCFailure = expect(pendingC).rejects.toThrow('Coalescing capacity reached')

		const sharedB = engine.getOrCreate('asset', 'resource', 'b', factoryB)
		await vi.waitFor(() => {
			expect(typeof releaseA).toBe('function')
			expect(releaseB).toHaveLength(1)
		})
		expect(factoryB).toHaveBeenCalledTimes(1)
		releaseA()
		for (const release of releaseB) {
			release()
		}
		await expect(pendingA).resolves.toEqual({value: 'A', shared: false})
		await expect(sharedA).resolves.toEqual({value: 'A', shared: true})
		await expect(pendingB).resolves.toEqual({value: 'B', shared: false})
		await pendingCFailure
		expect(factoryC).not.toHaveBeenCalled()
		await expect(sharedB).resolves.toEqual({value: 'B', shared: true})

	})

	it('does not expire active single-flight ownership under the TTL policy', async() => {
		const clock = createFixedClock(1_000)
		const engine = createCoalescingEngine<string>({
			clock,
			config: {maxKeys: 2, evictionPolicy: 'TTL', ttlMs: 10}
		})
		let releaseFirst!: () => void
		const replacement = vi.fn(async() => 'second')

		const first = engine.getOrCreate('report', 'resource', 'r-1', async() => {
			await new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			return 'first'
		})
		clock.advanceBy(11)
		const second = engine.getOrCreate('report', 'resource', 'r-1', replacement)

		await vi.waitFor(() => expect(typeof releaseFirst).toBe('function'))
		releaseFirst()
		await expect(first).resolves.toEqual({value: 'first', shared: false})
		await expect(second).resolves.toEqual({value: 'first', shared: true})
		expect(replacement).not.toHaveBeenCalled()
	})

})
