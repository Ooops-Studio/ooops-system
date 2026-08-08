import {describe, expect, it, vi} from 'vitest'

import {createStableHasher, hash32Hex} from '../../../src/utils/hashing/stable-hash'

describe('createStableHasher', () => {
	it('contains rejected promises supplied as hasher configuration', async() => {
		const options = Promise.reject(new Error('options rejected'))
		expect(() => createStableHasher(options as never)).toThrow('synchronous')
		const encoder = Promise.reject(new Error('encoder rejected'))
		expect(() => createStableHasher({textEncoder: encoder as never})).toThrow('synchronous')
		await Promise.resolve()
	})

	it('handles cyclic arrays without recursion failure', () => {
		const value: unknown[] = []
		value.push(value)
		const hasher = createStableHasher()

		expect(hasher.stringify(value)).toContain('[Circular]')
		expect(hasher.hash(value)).toMatch(/^[a-f0-9]{8}$/u)
	})

	it('does not invoke accessor-backed values', () => {
		const getter = vi.fn(() => 'private')
		const value = Object.defineProperty({}, 'secret', {enumerable: true, get: getter})

		const serialized = createStableHasher().stringify(value)

		expect(serialized).toBe('{}')
		expect(getter).not.toHaveBeenCalled()
	})

	it('rejects proxies before executing enumeration traps', () => {
		const ownKeys = vi.fn(() => ['value'])
		const shared = new Proxy({value: 'safe'}, {ownKeys})
		const root = Array.from({length: 1_000}, () => shared)

		const serialized = createStableHasher().stringify(root)

		expect(ownKeys).not.toHaveBeenCalled()
		expect(serialized).toContain('[Uninspectable]')
		expect(serialized.length).toBeLessThan(100_000)
	})

	it('rejects proxies hidden in hashed prototype chains before enumeration traps', () => {
		const ownKeys = vi.fn(() => ['inherited'])
		const getOwnPropertyDescriptor = vi.fn(() => ({
			value: 'unsafe', enumerable: true, configurable: true, writable: true
		}))
		const prototype = new Proxy({}, {ownKeys, getOwnPropertyDescriptor})
		const value = Object.create(prototype) as Record<string, unknown>
		Object.defineProperty(value, 'safe', {value: 'visible', enumerable: true})

		expect(createStableHasher().stringify(value)).toBe('"[Uninspectable]"')
		expect(ownKeys).not.toHaveBeenCalled()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})

	it('bounds sparse arrays and aggregate output size', () => {
		const sparse: unknown[] = []
		sparse.length = 1_000_000
		const large = Array.from({length: 1_000}, () => 'x'.repeat(10_000))
		const hasher = createStableHasher()

		expect(hasher.stringify(sparse)).toContain('[Truncated]')
		expect(hasher.stringify(large).length).toBeLessThanOrEqual(1_000_020)
		expect(hasher.hash(large)).toMatch(/^[a-f0-9]{8}$/u)
		expect(hasher.hash(large)).toBe(hasher.hash(large))
	})

	it('bounds wide objects before materializing their complete key list', () => {
		const wide = Object.fromEntries(Array.from({length: 10_000}, (_, index) => [`key-${index}`, index]))
		const ownKeys = vi.spyOn(Reflect, 'ownKeys')
		try {
			const serialized = createStableHasher().stringify(wide)
			expect(serialized).toContain('"[truncated]":true')
			expect(ownKeys.mock.calls.some(([value]) => value === wide)).toBe(false)
		} finally { ownKeys.mockRestore() }
	})

	it('remains deterministic when object keys have different insertion order', () => {
		const hasher = createStableHasher()
		expect(hasher.stringify({b: 2, a: 1})).toBe(hasher.stringify({a: 1, b: 2}))
		expect(hasher.hash({b: 2, a: 1})).toBe(hasher.hash({a: 1, b: 2}))
	})

	it('snapshots validated options without executing accessors', () => {
		const getter = vi.fn(() => 1)
		const accessor = Object.defineProperty({}, 'seed', {get: getter})
		expect(() => createStableHasher(accessor)).toThrow('data properties')
		expect(getter).not.toHaveBeenCalled()

		const options = {seed: 1, encode: 'hex' as const}
		const hasher = createStableHasher(options)
		options.seed = 2
		expect(hasher.hashString('stable')).toBe(createStableHasher({seed: 1}).hashString('stable'))
	})

	it('rejects proxied encoder output before prototype traps', () => {
		const getPrototypeOf = vi.fn(() => Uint8Array.prototype)
		const bytes = new Proxy(new Uint8Array([1]), {getPrototypeOf})
		const hasher = createStableHasher({textEncoder: {encode: () => bytes}})

		expect(() => hasher.hashString('safe')).toThrow('must return Uint8Array')
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('does not inherit a forged encoder capability from Object.prototype', () => {
		let calls = 0
		Object.defineProperty(Object.prototype, 'encode', {
			configurable: true, writable: true,
			value: () => { calls += 1; return new Uint8Array([1]) }
		})
		let failure: unknown
		try { createStableHasher({textEncoder: {} as never}) }
		catch(error) { failure = error }
		finally { delete (Object.prototype as Record<string, unknown>).encode }

		expect(failure).toBeInstanceOf(TypeError)
		expect(calls).toBe(0)
	})

	it('contains rejected native promises returned by a synchronous encoder', async() => {
		const hasher = createStableHasher({
			textEncoder: {encode: () => Promise.reject(new Error('encoder failed')) as never}
		})
		expect(() => hasher.hashString('safe')).toThrow('synchronously')
		const thrown = Promise.reject(new Error('encoder threw'))
		const throwingHasher = createStableHasher({textEncoder: {encode: () => { throw thrown }}})
		expect(() => throwingHasher.hashString('safe')).toThrow()
		await Promise.resolve()
	})

	it('preserves digest encoding when a custom encoder rewires formatting intrinsics', () => {
		const expectedHex = createStableHasher().hashString('safe')
		const expectedBase64 = createStableHasher({encode: 'base64'}).hashString('safe')
		const numberToString = Object.getOwnPropertyDescriptor(Number.prototype, 'toString')!
		const padStart = Object.getOwnPropertyDescriptor(String.prototype, 'padStart')!
		const setUint32 = Object.getOwnPropertyDescriptor(DataView.prototype, 'setUint32')!
		const bufferFrom = Object.getOwnPropertyDescriptor(Buffer, 'from')!
		const bufferToString = Object.getOwnPropertyDescriptor(Buffer.prototype, 'toString')!
		const poison = (): never => { throw new Error('poisoned formatting intrinsic') }
		const encoder = {encode: (input: string) => {
			Object.defineProperties(Number.prototype, {toString: {configurable: true, value: poison}})
			Object.defineProperties(String.prototype, {padStart: {configurable: true, value: poison}})
			Object.defineProperties(DataView.prototype, {setUint32: {configurable: true, value: poison}})
			Object.defineProperties(Buffer, {from: {configurable: true, value: poison}})
			Object.defineProperties(Buffer.prototype, {toString: {configurable: true, value: poison}})
			return new TextEncoder().encode(input)
		}}

		try {
			expect(createStableHasher({textEncoder: encoder}).hashString('safe')).toBe(expectedHex)
			expect(createStableHasher({textEncoder: encoder, encode: 'base64'}).hashString('safe')).toBe(expectedBase64)
		} finally {
			Object.defineProperty(Number.prototype, 'toString', numberToString)
			Object.defineProperty(String.prototype, 'padStart', padStart)
			Object.defineProperty(DataView.prototype, 'setUint32', setUint32)
			Object.defineProperty(Buffer, 'from', bufferFrom)
			Object.defineProperty(Buffer.prototype, 'toString', bufferToString)
		}
	})

	it('preserves stable serialization after collection intrinsics are rewired', () => {
		const hasher = createStableHasher()
		const targets = [
			[Array, 'isArray'], [Array.prototype, 'push'], [Array.prototype, 'sort'],
			[Array.prototype, 'join'], [Array.prototype, Symbol.iterator],
			[WeakSet.prototype, 'add'], [WeakSet.prototype, 'has'],
			[Object, 'getOwnPropertyDescriptor']
		] as const
		const descriptors = targets.map((entry) => Object.getOwnPropertyDescriptor(entry[0], entry[1])!)
		const poison = (): never => { throw new Error('poisoned collection intrinsic') }
		let serialized = ''
		try {
			for (let index = 0; index < targets.length; index += 1) {
				const entry = targets[index]!
				Object.defineProperty(entry[0], entry[1], {
					configurable: true, writable: true, value: poison
				})
			}
			serialized = hasher.stringify({b: [2], a: {value: 1}})
		} finally {
			for (let index = 0; index < targets.length; index += 1) {
				const entry = targets[index]!
				Object.defineProperty(entry[0], entry[1], descriptors[index]!)
			}
		}

		expect(serialized).toBe('{"a":{"value":1},"b":[2]}')
	})

	it('preserves primitive serialization after the global String function is rewired', () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'String')!
		const hasher = createStableHasher()
		let serialized: string | undefined
		let failure: unknown
		try {
			Object.defineProperty(globalThis, 'String', {
				configurable: true, writable: true, value: () => 'forged'
			})
			try { serialized = hasher.stringify({enabled: true, retries: 3, values: [1]}) }
			catch(error) { failure = error }
		} finally { Object.defineProperty(globalThis, 'String', descriptor) }

		expect(failure).toBeUndefined()
		expect(serialized).toBe('{"enabled":true,"retries":3,"values":[1]}')
	})

	it('preserves convenience hashing after configuration and encoder globals are rewired', () => {
		const expected = hash32Hex('safe')
		const targets = [
			[Object, 'getOwnPropertyDescriptor'], [Object, 'getPrototypeOf'],
			[Number, 'isSafeInteger'], [Math, 'min'], [globalThis, 'TextEncoder']
		] as const
		const descriptors = targets.map((entry) => Object.getOwnPropertyDescriptor(entry[0], entry[1])!)
		const poison = (): never => { throw new Error('poisoned configuration intrinsic') }
		let actual: string | undefined
		let failure: unknown
		try {
			for (let index = 0; index < targets.length; index += 1) {
				const entry = targets[index]!
				Object.defineProperty(entry[0], entry[1], {
					configurable: true, writable: true, value: poison
				})
			}
			try { actual = hash32Hex('safe') } catch(error) { failure = error }
		} finally {
			for (let index = 0; index < targets.length; index += 1) {
				const entry = targets[index]!
				Object.defineProperty(entry[0], entry[1], descriptors[index]!)
			}
		}

		expect(failure).toBeUndefined()
		expect(actual).toBe(expected)
	})

	it('validates encoder internal slots without walking hostile prototypes or reading length accessors', () => {
		const getPrototypeOf = vi.fn(() => Uint8Array.prototype)
		const fake = Object.create(new Proxy({}, {getPrototypeOf})) as Uint8Array
		const fakeHasher = createStableHasher({textEncoder: {encode: () => fake}})
		expect(() => fakeHasher.hashString('safe')).toThrow('must return Uint8Array')
		expect(getPrototypeOf).not.toHaveBeenCalled()

		const length = vi.fn(() => Number.MAX_SAFE_INTEGER)
		const bytes = new Uint8Array([1, 2, 3])
		Object.defineProperty(bytes, 'length', {get: length})
		const realHasher = createStableHasher({textEncoder: {encode: () => bytes}})
		expect(realHasher.hashString('safe')).toMatch(/^[a-f0-9]{8}$/u)
		expect(length).not.toHaveBeenCalled()
	})

	it('rejects oversized raw and encoded inputs before unbounded hashing work', () => {
		const encode = vi.fn(() => new Uint8Array([1]))
		const hasher = createStableHasher({textEncoder: {encode}})
		expect(() => hasher.hashString('x'.repeat(1_000_001))).toThrow('at most 1000000')
		expect(encode).not.toHaveBeenCalled()

		const oversized = createStableHasher({
			textEncoder: {encode: () => new Uint8Array(4_000_001)}
		})
		expect(() => oversized.hashString('safe')).toThrow('bounded UTF-8 size')
	})
})
