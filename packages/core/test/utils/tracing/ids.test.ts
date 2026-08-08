import {Buffer} from 'node:buffer'

import {describe, expect, it, vi} from 'vitest'

import {createIdGenerator} from '../../../src/utils/tracing/ids'

describe('tracing ID generation', () => {
	it('never emits all-zero deterministic W3C identifiers', () => {
		const ids = createIdGenerator({deterministic: true, seed: 0})
		expect(ids.nextTraceId()).toMatch(/^(?!0{32}$)[0-9a-f]{32}$/u)
		expect(ids.nextSpanId()).toMatch(/^(?!0{16}$)[0-9a-f]{16}$/u)
	})

	it('is deterministic for equal seeds and validates unsafe seeds', () => {
		const left = createIdGenerator({deterministic: true, seed: 7})
		const right = createIdGenerator({deterministic: true, seed: 7})
		expect(left.nextTraceId()).toBe(right.nextTraceId())
		expect(left.nextSpanId()).toBe(right.nextSpanId())
		expect(() => createIdGenerator({deterministic: true, seed: -1})).toThrow('seed')
		expect(() => createIdGenerator({deterministic: true, seed: 1.5})).toThrow('seed')
	})

	it('emits valid random W3C identifiers', () => {
		const ids = createIdGenerator()
		expect(ids.nextTraceId()).toMatch(/^(?!0{32}$)[0-9a-f]{32}$/u)
		expect(ids.nextSpanId()).toMatch(/^(?!0{16}$)[0-9a-f]{16}$/u)
	})

	it('continues generating IDs after RegExp, Buffer, and BigInt globals are rewired', () => {
		const testDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, 'test')!
		const toStringDescriptor = Object.getOwnPropertyDescriptor(Buffer.prototype, 'toString')!
		const bigintDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'BigInt')!
		const random = createIdGenerator()
		const deterministic = createIdGenerator({deterministic: true, seed: 7})
		let values: string[] = []

		try {
			Object.defineProperties(RegExp.prototype, {
				test: {configurable: true, writable: true, value: () => { throw new Error('rewired test') }}
			})
			Object.defineProperties(Buffer.prototype, {
				toString: {configurable: true, writable: true, value: () => { throw new Error('rewired toString') }}
			})
			Object.defineProperty(globalThis, 'BigInt', {
				configurable: true, writable: true, value: () => { throw new Error('rewired BigInt') }
			})
			values = [
				random.nextTraceId(), random.nextSpanId(),
				deterministic.nextTraceId(), deterministic.nextSpanId()
			]
		} finally {
			Object.defineProperty(globalThis, 'BigInt', bigintDescriptor)
			Object.defineProperty(RegExp.prototype, 'test', testDescriptor)
			Object.defineProperty(Buffer.prototype, 'toString', toStringDescriptor)
		}

		expect(values.map((value) => value.length)).toEqual([32, 16, 32, 16])
		expect(values.every((value) => value !== '0'.repeat(value.length))).toBe(true)
	})

	it('does not execute option accessors that could enable deterministic IDs', () => {
		const getter = vi.fn(() => true)
		const options = Object.defineProperty({}, 'deterministic', {enumerable: true, get: getter})

		expect(() => createIdGenerator(options)).toThrow('data properties')
		expect(getter).not.toHaveBeenCalled()
	})

	it('contains rejected promises supplied as synchronous configuration', async() => {
		const optionsFailure = Promise.reject(new Error('options rejected'))
		expect(() => createIdGenerator(optionsFailure as never)).toThrow('synchronous')
		const seedFailure = Promise.reject(new Error('seed rejected'))
		expect(() => createIdGenerator({deterministic: true, seed: seedFailure as never})).toThrow('seed')
		const ignoredSeedFailure = Promise.reject(new Error('ignored seed rejected'))
		expect(() => createIdGenerator({deterministic: false, seed: ignoredSeedFailure as never}))
			.not.toThrow()
		await Promise.resolve()
	})

	it('fails boundedly when the random source repeatedly returns all-zero bytes', async() => {
		vi.resetModules()
		const randomBytes = vi.fn((size: number) => Buffer.alloc(size))
		vi.doMock('node:crypto', () => ({randomBytes}))
		try {
			const {createIdGenerator: createWithMockedCrypto} = await import('../../../src/utils/tracing/ids')
			const ids = createWithMockedCrypto()
			expect(() => ids.nextTraceId()).toThrow('repeatedly returned')
			expect(randomBytes).toHaveBeenCalledTimes(8)
		} finally {
			vi.doUnmock('node:crypto')
			vi.resetModules()
		}
	})

	it('preserves option validation after descriptor and numeric intrinsics are rewired', () => {
		const defineProperty = Object.defineProperty
		const descriptor = Object.getOwnPropertyDescriptor
		const objectDescriptor = descriptor(Object, 'getOwnPropertyDescriptor')!
		const numberSafeInteger = descriptor(Number, 'isSafeInteger')!
		let ids: ReturnType<typeof createIdGenerator> | undefined
		let thrown: unknown
		try {
			defineProperty(Object, 'getOwnPropertyDescriptor', {configurable: true, value: () => { throw new Error('poisoned descriptor') }})
			defineProperty(Number, 'isSafeInteger', {configurable: true, value: () => false})
			try { ids = createIdGenerator({deterministic: true, seed: 7}) }
			catch(error) { thrown = error }
		} finally {
			defineProperty(Object, 'getOwnPropertyDescriptor', objectDescriptor)
			defineProperty(Number, 'isSafeInteger', numberSafeInteger)
		}

		expect(thrown).toBeUndefined()
		expect(ids?.nextSpanId()).toHaveLength(16)
	})
})
