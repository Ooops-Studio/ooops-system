import {describe, expect, it, vi} from 'vitest'

import {exponentialBackoff} from '../../../src/utils/async/backoff'

const config = {baseDelayMs: 100, multiplier: 2, maxDelayMs: 1_000, jitter: 0}

describe('exponentialBackoff', () => {
	it('grows exponentially and respects the maximum delay', () => {
		expect(exponentialBackoff(1, config)).toBe(100)
		expect(exponentialBackoff(3, config)).toBe(400)
		expect(exponentialBackoff(100_000, config)).toBe(1_000)
	})

	it('bounds jitter and unsafe random results', () => {
		const jittered = {...config, jitter: 0.5}
		expect(exponentialBackoff(2, jittered, () => -10)).toBe(100)
		expect(exponentialBackoff(2, jittered, () => 10)).toBe(300)
		expect(exponentialBackoff(2, jittered, () => Number.NaN)).toBe(200)
		expect(exponentialBackoff(2, jittered, () => { throw new Error('entropy unavailable') })).toBe(200)
	})

	it('contains rejected native promises returned by the synchronous random source', async() => {
		const failure = new Error('async entropy failure')
		expect(exponentialBackoff(2, {...config, jitter: 0.5}, () => Promise.reject(failure) as never)).toBe(200)
		const thrown = Promise.reject(new Error('thrown entropy failure'))
		expect(exponentialBackoff(2, {...config, jitter: 0.5}, () => { throw thrown })).toBe(200)
		await Promise.resolve()
	})

	it('preserves default jitter after Math.random is rewired', () => {
		const rewired = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('rewired') })
		try { expect(exponentialBackoff(2, {...config, jitter: 0.5})).toBeGreaterThanOrEqual(100) }
		finally { rewired.mockRestore() }
	})

	it('rejects unsafe attempts before scheduling can be affected', () => {
		expect(() => exponentialBackoff(0, config)).toThrow('attempt')
	})

	it('normalizes legacy zero multipliers and out-of-range jitter', () => {
		expect(exponentialBackoff(2, {...config, multiplier: 0})).toBe(0)
		expect(exponentialBackoff(1, {...config, jitter: -1}, () => 1)).toBe(100)
		expect(exponentialBackoff(1, {...config, jitter: 2}, () => 1)).toBe(200)
	})

	it('caps caller-provided delay ceilings at the platform timer maximum', () => {
		expect(exponentialBackoff(2, {
			baseDelayMs: Number.MAX_SAFE_INTEGER,
			multiplier: 2,
			maxDelayMs: Number.MAX_SAFE_INTEGER,
			jitter: 0
		})).toBe(2_147_483_647)
	})

	it('keeps zero-delay policies finite at extreme attempts', () => {
		expect(exponentialBackoff(Number.MAX_SAFE_INTEGER, {
			baseDelayMs: 0,
			multiplier: 2,
			maxDelayMs: 1_000,
			jitter: 1
		})).toBe(0)
	})

	it('does not invoke config accessors', () => {
		const getter = vi.fn(() => 100)
		const hostile = Object.defineProperty({...config}, 'baseDelayMs', {get: getter})

		expect(() => exponentialBackoff(1, hostile)).toThrow('data property')
		expect(getter).not.toHaveBeenCalled()
	})

	it('rejects proxied configs before descriptor traps', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const hostile = new Proxy(config, {getOwnPropertyDescriptor})

		expect(() => exponentialBackoff(1, hostile)).toThrow('Proxy')
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})

	it('contains rejected promises in synchronous policy inputs', async() => {
		const attempt = Promise.reject(new Error('attempt rejected'))
		expect(() => exponentialBackoff(attempt as never, config)).toThrow('attempt')
		const field = Promise.reject(new Error('delay rejected'))
		expect(() => exponentialBackoff(1, {...config, baseDelayMs: field as never})).toThrow('baseDelayMs')
		await Promise.resolve()
	})

	it('preserves bounded decisions when the random source poisons numeric intrinsics', () => {
		const finiteDescriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite')!
		const maxDescriptor = Object.getOwnPropertyDescriptor(Math, 'max')!
		const minDescriptor = Object.getOwnPropertyDescriptor(Math, 'min')!
		let delay: number
		try {
			delay = exponentialBackoff(1, {
				baseDelayMs: 100, multiplier: 2, maxDelayMs: 1_000, jitter: 1
			}, () => {
				Object.defineProperty(Number, 'isFinite', {
					configurable: true, writable: true, value: () => true
				})
				Object.defineProperty(Math, 'max', {
					configurable: true, writable: true, value: () => 1_000_000_000
				})
				Object.defineProperty(Math, 'min', {
					configurable: true, writable: true, value: () => 1_000_000_000
				})
				return Number.NaN
			})
		} finally {
			Object.defineProperty(Number, 'isFinite', finiteDescriptor)
			Object.defineProperty(Math, 'max', maxDescriptor)
			Object.defineProperty(Math, 'min', minDescriptor)
		}

		expect(delay!).toBe(100)
	})
})
