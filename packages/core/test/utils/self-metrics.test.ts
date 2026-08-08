import {describe, expect, it, vi} from 'vitest'

import {safeIncrement, safeRecord} from '../../src/utils/self-metrics'

describe('self-metrics recursion safety', () => {
	it('contains rejected promises supplied as metric ports and arguments', async() => {
		const port = Promise.reject(new Error('port rejected'))
		safeIncrement(port as never, 'test')
		const name = Promise.reject(new Error('name rejected'))
		const tag = Promise.reject(new Error('tag rejected'))
		safeRecord(undefined, name as never, 1, {tag: tag as never})
		await Promise.resolve()
	})

	it('suppresses synchronous increment re-entry without disabling later calls', () => {
		let calls = 0
		const metrics = {
			increment: vi.fn(() => {
				calls += 1
				safeIncrement(metrics as never, 'recursive')
			})
		}

		safeIncrement(metrics as never, 'first')
		safeIncrement(metrics as never, 'second')

		expect(calls).toBe(2)
		expect(metrics.increment).toHaveBeenCalledTimes(2)
	})

	it('suppresses asynchronous increment re-entry from the adapter continuation', async() => {
		let calls = 0
		const metrics = {
			async increment() {
				calls += 1
				if (calls !== 1) return
				await Promise.resolve()
				safeIncrement(metrics as never, 'recursive')
			}
		}

		safeIncrement(metrics as never, 'first')
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(calls).toBe(1)
	})

	it('scopes record recursion independently from increment', () => {
		const metrics = {
			increment: vi.fn(),
			record: vi.fn(() => {
				safeRecord(metrics as never, 'recursive', 2)
				safeIncrement(metrics as never, 'nested')
			})
		}

		safeRecord(metrics as never, 'gauge', 1)

		expect(metrics.record).toHaveBeenCalledOnce()
		expect(metrics.increment).toHaveBeenCalledOnce()
	})

	it('does not execute metric accessors', () => {
		const metrics = Object.defineProperties({}, {
			increment: {get: () => { throw new Error('increment getter executed') }},
			record: {get: () => { throw new Error('record getter executed') }}
		})

		expect(() => safeIncrement(metrics as never, 'counter')).not.toThrow()
		expect(() => safeRecord(metrics as never, 'gauge', 1)).not.toThrow()
	})

	it('rejects proxied metric ports before capability-inspection traps', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const getPrototypeOf = vi.fn(() => null)
		const metrics = new Proxy({increment: vi.fn(), record: vi.fn()}, {
			getOwnPropertyDescriptor,
			getPrototypeOf
		})

		expect(() => safeIncrement(metrics, 'counter')).not.toThrow()
		expect(() => safeRecord(metrics, 'gauge', 1)).not.toThrow()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('does not inspect metric tags through a proxied prototype chain', () => {
		const ownKeys = vi.fn(() => ['forged'])
		const getOwnPropertyDescriptor = vi.fn(() => ({
			configurable: true, enumerable: true, value: 'forged', writable: true
		}))
		const prototype = new Proxy({}, {ownKeys, getOwnPropertyDescriptor})
		const tags = Object.create(prototype) as Record<string, string>
		tags.safe = 'value'
		const metrics = {increment: vi.fn(), record: vi.fn()}

		expect(() => safeIncrement(metrics, 'counter', tags)).not.toThrow()
		expect(() => safeRecord(metrics, 'gauge', 1, tags)).not.toThrow()
		expect(ownKeys).not.toHaveBeenCalled()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})

	it('does not inherit forged metric capabilities from Object.prototype', () => {
		let calls = 0
		Object.defineProperties(Object.prototype, {
			increment: {configurable: true, writable: true, value: () => { calls += 1 }},
			record: {configurable: true, writable: true, value: () => { calls += 1 }}
		})
		try {
			safeIncrement({} as never, 'counter')
			safeRecord({} as never, 'gauge', 1)
		} finally {
			delete (Object.prototype as Record<string, unknown>).increment
			delete (Object.prototype as Record<string, unknown>).record
		}

		expect(calls).toBe(0)
	})

	it('captures stable metric capabilities and preserves their receiver', () => {
		const calls: string[] = []
		const metrics = {
			label: 'original',
			increment(this: {label: string}) { calls.push(this.label) }
		}
		safeIncrement(metrics, 'first')
		metrics.increment = function() { calls.push('replacement') }
		safeIncrement(metrics, 'second')

		expect(calls).toEqual(['original', 'original'])
	})

	it('preserves metric capabilities after an adapter replaces Function.prototype.call', () => {
		const callDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'call')!
		let calls = 0
		let replaced = false
		const metrics = {
			increment() {
				calls += 1
				if (replaced) return
				Object.defineProperty(Function.prototype, 'call', {
					configurable: true,
					writable: true,
					value: () => { throw new Error('poisoned Function.prototype.call') }
				})
				replaced = true
			}
		}

		try {
			safeIncrement(metrics, 'first')
			safeIncrement(metrics, 'second')
		} finally {
			Object.defineProperty(Function.prototype, 'call', callDescriptor)
		}

		expect(calls).toBe(2)
	})

	it('does not execute arbitrary thenables returned by metric ports', async() => {
		const then = vi.fn()
		const metrics = {
			increment: vi.fn(() => ({then}))
		}

		safeIncrement(metrics as never, 'counter')
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(then).not.toHaveBeenCalled()
	})

	it('observes rejected native promise metric results', async() => {
		const metrics = {increment: vi.fn(() => Promise.reject(new Error('async metric failure')))}

		safeIncrement(metrics as never, 'counter')
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(metrics.increment).toHaveBeenCalledOnce()
	})

	it('contains rejected native promises thrown by metric ports', async() => {
		const thrown = Promise.reject(new Error('thrown metric failure'))
		const metrics = {increment: vi.fn(() => { throw thrown })}

		safeIncrement(metrics as never, 'counter')
		await Promise.resolve()

		expect(metrics.increment).toHaveBeenCalledOnce()
	})

	it('isolates collection prototype poisoning by a metrics adapter', () => {
		const setDescriptors = Object.getOwnPropertyDescriptors(Set.prototype)
		const weakMapDescriptors = Object.getOwnPropertyDescriptors(WeakMap.prototype)
		let calls = 0
		const poison = (): never => { throw new Error('poisoned collection intrinsic') }
		const metrics = {
			increment: () => {
				calls += 1
				if (calls !== 1) return
				for (const method of ['add', 'delete', 'has'] as const) {
					Object.defineProperty(Set.prototype, method, {
						value: poison, configurable: true, writable: true
					})
				}
				Object.defineProperty(Set.prototype, 'size', {get: poison, configurable: true})
				for (const method of ['get', 'set', 'delete'] as const) {
					Object.defineProperty(WeakMap.prototype, method, {
						value: poison, configurable: true, writable: true
					})
				}
			}
		}

		try {
			safeIncrement(metrics as never, 'first')
			safeIncrement(metrics as never, 'second')
		} finally {
			Object.defineProperties(Set.prototype, setDescriptors)
			Object.defineProperties(WeakMap.prototype, weakMapDescriptors)
		}

		expect(calls).toBe(2)
	})

	it('contains tag failures and emits unpolluted defaults after inspection intrinsics are rewired', async() => {
		const defineProperty = Object.defineProperty
		const descriptor = Object.getOwnPropertyDescriptor
		const objectDescriptor = descriptor(Object, 'getOwnPropertyDescriptor')!
		const objectPrototype = descriptor(Object, 'getPrototypeOf')!
		let calls = 0
		let firstTags: unknown
		const metrics = {increment(_name: string, tags: unknown) {
			calls += 1
			if (calls === 1) firstTags = tags
		}}
		const failure = Promise.reject(new Error('tag rejected'))
		let thrown: unknown
		defineProperty(Object.prototype, 'tenantId', {configurable: true, value: 'forged'})
		try {
			defineProperty(Object, 'getOwnPropertyDescriptor', {
				configurable: true, value: () => { throw new Error('poisoned descriptor') }
			})
			defineProperty(Object, 'getPrototypeOf', {
				configurable: true, value: () => { throw new Error('poisoned prototype') }
			})
			try {
				safeIncrement(metrics as never, 'first')
				safeIncrement(metrics as never, 'second', {failure: failure as never})
			} catch(error) { thrown = error }
		} finally {
			defineProperty(Object, 'getOwnPropertyDescriptor', objectDescriptor)
			defineProperty(Object, 'getPrototypeOf', objectPrototype)
			delete (Object.prototype as Record<string, unknown>).tenantId
		}

		expect(thrown).toBeUndefined()
		expect(calls).toBe(2)
		expect(Object.getPrototypeOf(firstTags)).toBeNull()
		expect((firstTags as Record<string, unknown>).tenantId).toBeUndefined()
		await Promise.resolve()
	})
})
