import {runInNewContext} from 'node:vm'

import {describe, expect, it, vi} from 'vitest'

import {
	captureSyncMethod,
	captureNativePromise,
	createSafeAbortController,
	isolateUnexpectedThenable,
	snapshotBoundedDataGraph
} from '../../../src/runtime/async/safe-abort-controller'

describe('safe abort controller promise isolation', () => {
	it('contains rejected promises supplied as invalid listener metadata', async() => {
		const key = Promise.reject(new Error('key rejected'))
		expect(captureSyncMethod({}, key as never)).toBeUndefined()
		const type = Promise.reject(new Error('type rejected'))
		createSafeAbortController().signal.addEventListener(type as never, vi.fn())
		await Promise.resolve()
	})

	it('contains rejected native promises used as abort reasons', async() => {
		const reason = Promise.reject(new Error('abort reason rejected'))
		const controller = createSafeAbortController()

		controller.abort(reason)

		expect(controller.signal.reason).toBe(reason)
		await Promise.resolve()
	})

	it('preserves abort ownership after the global prototype is rewired', () => {
		const controller = createSafeAbortController()
		const listener = vi.fn()
		controller.signal.addEventListener('abort', listener)
		const abort = vi.spyOn(AbortController.prototype, 'abort').mockImplementation(() => {
			throw new Error('rewired abort')
		})
		try {
			expect(() => controller.abort(new Error('deadline'))).not.toThrow()
			expect(controller.signal.aborted).toBe(true)
			expect(listener).toHaveBeenCalledOnce()
		} finally { abort.mockRestore() }
	})

	it('preserves abort ownership after the global constructor is rewired', () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'AbortController')!
		let constructed = 0
		try {
			Object.defineProperty(globalThis, 'AbortController', {
				configurable: true,
				writable: true,
				value: class {
					constructor() { constructed += 1; throw new Error('rewired AbortController') }
				}
			})
			const controller = createSafeAbortController()
			controller.abort('owned')
			expect(controller.signal.aborted).toBe(true)
			expect(controller.signal.reason).toBe('owned')
			expect(constructed).toBe(0)
		} finally { Object.defineProperty(globalThis, 'AbortController', descriptor) }
	})

	it('preserves listener ownership after EventTarget methods are rewired', () => {
		const add = vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(() => {
			throw new Error('rewired addEventListener')
		})
		const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(() => {
			throw new Error('rewired removeEventListener')
		})
		try {
			const controller = createSafeAbortController()
			const listener = vi.fn()
			expect(() => controller.signal.addEventListener('abort', listener)).not.toThrow()
			controller.abort()
			expect(listener).toHaveBeenCalledOnce()
			expect(() => controller.signal.removeEventListener('abort', listener)).not.toThrow()
		} finally {
			add.mockRestore()
			remove.mockRestore()
		}
	})

	it('preserves listener registration after WeakMap methods are rewired', () => {
		let calls = 0
		let failure: unknown
		const get = vi.spyOn(WeakMap.prototype, 'get').mockImplementation(() => {
			throw new Error('rewired WeakMap.get')
		})
		const set = vi.spyOn(WeakMap.prototype, 'set').mockImplementation(() => {
			throw new Error('rewired WeakMap.set')
		})
		try {
			const controller = createSafeAbortController()
			const listener = () => { calls += 1 }
			try {
				controller.signal.addEventListener('abort', listener)
				controller.abort()
				controller.signal.removeEventListener('abort', listener)
			} catch(error) { failure = error }
		} finally {
			get.mockRestore()
			set.mockRestore()
		}
		expect(failure).toBeUndefined()
		expect(calls).toBe(1)
	})

	it('observes cross-realm native promise rejections', async() => {
		const failure = new Error('cross-realm rejection')
		const promise = runInNewContext('Promise.reject(error)', {error: failure}) as Promise<never>
		const rejected = vi.fn()
		const testDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, 'test')!
		let observed = false
		let captured: Promise<void> | undefined

		try {
			Object.defineProperty(RegExp.prototype, 'test', {
				configurable: true,
				writable: true,
				value: () => { throw new Error('rewired RegExp.test') }
			})
			observed = isolateUnexpectedThenable(promise, rejected)
			captured = captureNativePromise(promise)
		} finally {
			Object.defineProperty(RegExp.prototype, 'test', testDescriptor)
		}

		expect(observed).toBe(true)
		await Promise.resolve()
		expect(rejected).toHaveBeenCalledWith(failure)
		await expect(captured).rejects.toBe(failure)
	})

	it('does not execute a replaced cross-realm Promise species getter', () => {
		const species = vi.fn(() => { throw new Error('species getter executed') })
		const promise = runInNewContext(`
			Object.defineProperty(Promise, Symbol.species, {
				configurable: true,
				get: species
			})
			Promise.resolve('result')
		`, {species}) as Promise<string>

		expect(isolateUnexpectedThenable(promise)).toBe(false)
		expect(species).not.toHaveBeenCalled()
	})

	it('does not execute arbitrary thenable methods', () => {
		const then = vi.fn()
		const value = {then}

		expect(isolateUnexpectedThenable(value)).toBe(false)
		expect(captureNativePromise(value)).toBeUndefined()
		expect(then).not.toHaveBeenCalled()
	})

	it('rejects proxied promise and method candidates before descriptor or prototype traps', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const getPrototypeOf = vi.fn(() => Object.prototype)
		const candidate = new Proxy({}, {getOwnPropertyDescriptor, getPrototypeOf})

		expect(isolateUnexpectedThenable(candidate)).toBe(false)
		expect(captureNativePromise(candidate)).toBeUndefined()
		expect(captureSyncMethod(candidate, 'run')).toBeUndefined()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('rejects proxies hidden in prototype chains before their traps run', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const getPrototypeOf = vi.fn(() => null)
		const hostilePrototype = new Proxy({}, {getOwnPropertyDescriptor, getPrototypeOf})
		const candidate = Object.create(hostilePrototype) as object

		expect(isolateUnexpectedThenable(candidate)).toBe(false)
		expect(captureNativePromise(candidate)).toBeUndefined()
		expect(captureSyncMethod(candidate, 'run')).toBeUndefined()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('does not inherit synchronous capabilities from Object.prototype', () => {
		const forged = vi.fn()
		Object.defineProperty(Object.prototype, 'run', {
			configurable: true,
			writable: true,
			value: forged
		})
		try {
			expect(captureSyncMethod({}, 'run')).toBeUndefined()
			expect(forged).not.toHaveBeenCalled()
		} finally { delete (Object.prototype as Record<string, unknown>).run }
	})

	it('does not invoke Promise subclass species constructors while observing completions', () => {
		let constructions = 0
		class CallerPromise<T> extends Promise<T> {
			constructor(executor: ConstructorParameters<typeof Promise<T>>[0]) {
				constructions++
				super(executor)
			}
		}
		const completion = new CallerPromise<void>((resolve) => resolve())

		expect(isolateUnexpectedThenable(completion)).toBe(false)
		expect(captureNativePromise(completion)).toBeUndefined()
		expect(constructions).toBe(1)
	})

	it('does not create a second unhandled rejection from a failing observer', async() => {
		const throwing = vi.fn(() => { throw new Error('observer threw') })
		const rejecting = vi.fn(async() => { throw new Error('observer rejected') })

		expect(isolateUnexpectedThenable(Promise.reject(new Error('first')), throwing)).toBe(true)
		expect(isolateUnexpectedThenable(Promise.reject(new Error('second')), rejecting)).toBe(true)
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(throwing).toHaveBeenCalledOnce()
		expect(rejecting).toHaveBeenCalledOnce()
	})

	it('contains rejected promises thrown by hostile capability traps', async() => {
		const owner = new Proxy({}, {
			getOwnPropertyDescriptor() { throw Promise.reject(new Error('descriptor trap rejection')) }
		})
		expect(captureSyncMethod(owner, 'run')).toBeUndefined()
		expect(isolateUnexpectedThenable(owner)).toBe(false)
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('observes rejected promises stored in invalid method descriptors', async() => {
		const owner = {run: Promise.reject(new Error('invalid method rejection'))}
		expect(captureSyncMethod(owner, 'run')).toBeUndefined()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})
})

describe('bounded data graph snapshots', () => {
	it('copies nested data without reading accessors or retaining mutable containers', () => {
		const policy = {name: 'original', steps: [{timeoutMs: 25}]}
		const source = {policies: [policy]}

		const snapshot = snapshotBoundedDataGraph(source) as typeof source
		policy.name = 'mutated'
		policy.steps[0]!.timeoutMs = 50
		source.policies.length = 0

		expect(snapshot).toEqual({policies: [{name: 'original', steps: [{timeoutMs: 25}]}]})
	})

	it('preserves shared data identity without accepting cycles', () => {
		const shared = {handler: () => 'fallback'}
		const snapshot = snapshotBoundedDataGraph({first: shared, second: shared}) as {
			first: unknown
			second: unknown
		}

		expect(snapshot.first).toBe(snapshot.second)
	})

	it('rejects accessors, sparse arrays, cycles, and excessive array sizes', () => {
		const getter = vi.fn(() => 1)
		const accessor = Object.defineProperty({}, 'value', {enumerable: true, get: getter})
		const sparse = Array<unknown>(1)
		const cycle: {self?: unknown} = {}
		cycle.self = cycle

		expect(() => snapshotBoundedDataGraph(accessor)).toThrow(TypeError)
		expect(getter).not.toHaveBeenCalled()
		expect(() => snapshotBoundedDataGraph(sparse)).toThrow(TypeError)
		expect(() => snapshotBoundedDataGraph(cycle)).toThrow(TypeError)
		expect(() => snapshotBoundedDataGraph(Array.from({length: 257}))).toThrow(TypeError)
	})

	it('rejects wide objects without materializing their complete key list', () => {
		const wide = Object.fromEntries(Array.from({length: 10_000}, (_, index) => [`key-${index}`, index]))
		const ownKeys = vi.spyOn(Reflect, 'ownKeys')
		try {
			expect(() => snapshotBoundedDataGraph(wide)).toThrow(TypeError)
			expect(ownKeys).not.toHaveBeenCalled()
		} finally { ownKeys.mockRestore() }
	})

	it('preserves own snapshot data when Object.prototype is polluted', () => {
		const keys = Array.from({length: 65}, (_, index) => `__core_snapshot_pollution_${index}`)
		let snapshot: unknown
		try {
			for (const key of keys) Object.defineProperty(Object.prototype, key, {
				configurable: true, enumerable: true, value: key
			})
			snapshot = snapshotBoundedDataGraph({safe: true})
		} finally {
			for (const key of keys) delete (Object.prototype as Record<string, unknown>)[key]
		}

		expect(snapshot).toEqual({safe: true})
		expect(Object.getPrototypeOf(snapshot)).toBeNull()
	})

	it('preserves bounded snapshots after collection intrinsics are rewired', () => {
		const weakSetHas = vi.spyOn(WeakSet.prototype, 'has')
		const weakSetAdd = vi.spyOn(WeakSet.prototype, 'add')
		const weakSetDelete = vi.spyOn(WeakSet.prototype, 'delete')
		const weakMapHas = vi.spyOn(WeakMap.prototype, 'has')
		const weakMapGet = vi.spyOn(WeakMap.prototype, 'get')
		const weakMapSet = vi.spyOn(WeakMap.prototype, 'set')
		const mapGet = vi.spyOn(Map.prototype, 'get')
		const mapSet = vi.spyOn(Map.prototype, 'set')
		const arrayPush = vi.spyOn(Array.prototype, 'push')
		let snapshot: unknown
		let failure: unknown
		try {
			weakSetHas.mockImplementation(() => { throw new Error('rewired WeakSet.has') })
			weakSetAdd.mockImplementation(() => { throw new Error('rewired WeakSet.add') })
			weakSetDelete.mockImplementation(() => { throw new Error('rewired WeakSet.delete') })
			weakMapHas.mockImplementation(() => { throw new Error('rewired WeakMap.has') })
			weakMapGet.mockImplementation(() => { throw new Error('rewired WeakMap.get') })
			weakMapSet.mockImplementation(() => { throw new Error('rewired WeakMap.set') })
			mapGet.mockImplementation(() => { throw new Error('rewired Map.get') })
			mapSet.mockImplementation(() => { throw new Error('rewired Map.set') })
			arrayPush.mockImplementation(() => { throw new Error('rewired Array.push') })
			try { snapshot = snapshotBoundedDataGraph({nested: [1, {safe: true}]}) }
			catch(error) { failure = error }
		} finally {
			arrayPush.mockRestore()
			mapSet.mockRestore()
			mapGet.mockRestore()
			weakMapSet.mockRestore()
			weakMapGet.mockRestore()
			weakMapHas.mockRestore()
			weakSetDelete.mockRestore()
			weakSetAdd.mockRestore()
			weakSetHas.mockRestore()
		}

		expect(failure).toBeUndefined()
		expect(snapshot).toEqual({nested: [1, {safe: true}]})
	})

	it('preserves bounded snapshots after global constructors are rewired', () => {
		const defineProperty = Object.defineProperty
		const descriptor = Object.getOwnPropertyDescriptor
		const targets = ['Object', 'String', 'Map', 'Set', 'WeakMap', 'WeakSet'] as const
		const descriptors = targets.map((key) => descriptor(globalThis, key)!)
		const poison = function PoisonedConstructor(): never {
			throw new Error('poisoned global constructor')
		}
		let snapshot: unknown
		let failure: unknown
		try {
			for (const key of targets) defineProperty(globalThis, key, {
				configurable: true, writable: true, value: poison
			})
			try { snapshot = snapshotBoundedDataGraph({nested: [1, {safe: true}]}) }
			catch(error) { failure = error }
		} finally {
			for (let index = 0; index < targets.length; index += 1) {
				defineProperty(globalThis, targets[index]!, descriptors[index]!)
			}
		}

		expect(failure).toBeUndefined()
		expect(snapshot).toEqual({nested: [1, {safe: true}]})
	})

	it('rejects proxies without executing descriptor, prototype, or enumeration traps', () => {
		const ownKeys = vi.fn(() => ['value'])
		const getOwnPropertyDescriptor = vi.fn(() => ({value: 1, enumerable: true, configurable: true}))
		const getPrototypeOf = vi.fn(() => Object.prototype)
		const value = new Proxy({value: 1}, {ownKeys, getOwnPropertyDescriptor, getPrototypeOf})

		expect(() => snapshotBoundedDataGraph(value)).toThrow(TypeError)
		expect(ownKeys).not.toHaveBeenCalled()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('observes rejected native promises found in synchronous data graphs', async() => {
		expect(() => snapshotBoundedDataGraph({nested: {
			invalid: Promise.reject(new Error('nested rejection'))
		}})).toThrow(TypeError)
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('observes rejected promises across nested sibling branches before snapshot failure', async() => {
		expect(() => snapshotBoundedDataGraph({
			first: {invalid: Promise.reject(new Error('first branch rejection'))},
			second: {invalid: Promise.reject(new Error('second branch rejection'))}
		})).toThrow(TypeError)
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})
})
