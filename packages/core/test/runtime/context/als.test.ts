import {AsyncLocalStorage} from 'node:async_hooks'

import {describe, expect, it} from 'vitest'

import {createAsyncContextStore} from '../../../src/runtime/context/als'

describe('AsyncContextStore', () => {
	it('isolates overlapping asynchronous contexts from the first use', async() => {
		const store = createAsyncContextStore<string>()
		let releaseLeft!: () => void
		let releaseRight!: () => void
		const leftGate = new Promise<void>((resolve) => { releaseLeft = resolve })
		const rightGate = new Promise<void>((resolve) => { releaseRight = resolve })
		const observed: string[] = []

		const left = store.run('left', async() => {
			await leftGate
			observed.push(store.get() ?? 'missing')
		})
		const right = store.run('right', async() => {
			await rightGate
			observed.push(store.get() ?? 'missing')
		})
		releaseRight()
		await Promise.resolve()
		releaseLeft()
		await Promise.all([left, right])

		expect(observed).toEqual(['right', 'left'])
		expect(store.get()).toBeUndefined()
	})

	it('does not expose forged context after a callback rewires AsyncLocalStorage', () => {
		const descriptor = Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'getStore')!
		const store = createAsyncContextStore<string>()
		let observed: string | undefined

		try {
			store.run('safe', () => {
				Object.defineProperty(AsyncLocalStorage.prototype, 'getStore', {
					configurable: true,
					writable: true,
					value: () => 'forged'
				})
			})
			observed = store.get()
		} finally {
			Object.defineProperty(AsyncLocalStorage.prototype, 'getStore', descriptor)
		}

		expect(observed).toBeUndefined()
	})

	it('contains rejected native promises thrown as callback errors', async() => {
		const store = createAsyncContextStore<string>()
		const reason = Promise.reject(new Error('context callback rejection'))

		expect(() => store.run('value', () => { throw reason })).toThrow()
		await Promise.resolve()
	})

	it('contains a rejected promise supplied as an invalid callback', async() => {
		const store = createAsyncContextStore<string>()
		const callback = Promise.reject(new Error('callback rejected'))
		expect(() => store.run('value', callback as never)).toThrow(TypeError)
		await Promise.resolve()
	})

	it('contains a rejected native promise stored as an opaque context value', async() => {
		const store = createAsyncContextStore<Promise<never>>()
		const context = Promise.reject(new Error('context value rejected'))

		expect(store.run(context, () => store.get())).toBe(context)
		await Promise.resolve()
	})
})
