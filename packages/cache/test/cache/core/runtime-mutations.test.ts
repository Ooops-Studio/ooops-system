import {describe, expect, it, vi} from 'vitest'

import {createCacheMutationCoordinator} from '../../../src/cache/core/runtime-mutations'

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return {promise, resolve}
}

describe('cache mutation coordinator', () => {
	it('serializes overlapping keys while allowing unrelated keys to proceed', async() => {
		const coordinator = createCacheMutationCoordinator()
		const gate = deferred()
		const first = coordinator.run(['a'], async() => { await gate.promise })
		const sameKey = vi.fn(async() => undefined)
		const otherKey = vi.fn(async() => undefined)
		const second = coordinator.run(['a'], sameKey)
		const unrelated = coordinator.run(['b'], otherKey)
		await unrelated
		expect(otherKey).toHaveBeenCalledOnce()
		expect(sameKey).not.toHaveBeenCalled()
		gate.resolve()
		await Promise.all([first, second])
		expect(sameKey).toHaveBeenCalledOnce()
	})

	it('orders broad mutations between earlier and later key mutations', async() => {
		const coordinator = createCacheMutationCoordinator()
		const gate = deferred()
		const order: string[] = []
		const first = coordinator.run(['a'], async() => { await gate.promise; order.push('first') })
		const broad = coordinator.run(undefined, async() => { order.push('broad') })
		const later = coordinator.run(['b'], async() => { order.push('later') })
		await Promise.resolve()
		expect(order).toEqual([])
		gate.resolve()
		await Promise.all([first, broad, later])
		expect(order).toEqual(['first', 'broad', 'later'])
	})

	it('releases a key after rejected work', async() => {
		const coordinator = createCacheMutationCoordinator()
		await expect(coordinator.run(['a'], async() => { throw new Error('failed') })).rejects.toThrow('failed')
		await expect(coordinator.run(['a'], async() => 'recovered')).resolves.toBe('recovered')
	})

	it('reports pending key and broad mutations until their work settles', async() => {
		const coordinator = createCacheMutationCoordinator()
		const keyGate = deferred()
		const keyWork = coordinator.run(['a'], async() => { await keyGate.promise })
		expect(coordinator.isPending('a')).toBe(true)
		expect(coordinator.isPending('b')).toBe(false)
		keyGate.resolve()
		await keyWork
		await Promise.resolve()
		expect(coordinator.isPending('a')).toBe(false)

		const broadGate = deferred()
		const broadWork = coordinator.run(undefined, async() => { await broadGate.promise })
		expect(coordinator.isPending('a')).toBe(true)
		broadGate.resolve()
		await broadWork
		await Promise.resolve()
		expect(coordinator.isPending('a')).toBe(false)
	})

	it('waits for earlier overlapping mutations without blocking unrelated keys', async() => {
		const coordinator = createCacheMutationCoordinator()
		const gate = deferred()
		const mutation = coordinator.run(['a'], async() => { await gate.promise })
		let overlappingSettled = false
		const overlapping = coordinator.wait(['a']).then(() => { overlappingSettled = true })
		await coordinator.wait(['b'])
		expect(overlappingSettled).toBe(false)
		gate.resolve()
		await Promise.all([mutation, overlapping])
		expect(overlappingSettled).toBe(true)
	})
})
