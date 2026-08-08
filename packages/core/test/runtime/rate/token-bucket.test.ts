import {describe, expect, it, vi} from 'vitest'

import {createTokenBucket} from '../../../src/runtime/rate/token-bucket'

function controllableClock(initial = 0) {
	let now = initial
	return {
		clock: {now: () => now},
		set: (value: number) => {
			now = value
		}
	}
}

describe('createTokenBucket', () => {
	it('starts full and removes tokens up to its capacity', () => {
		const {clock} = controllableClock()
		const bucket = createTokenBucket(5, 1_000, 10, clock)

		expect(bucket.tryRemove(7)).toBe(true)
		expect(bucket.tryRemove(4)).toBe(false)
		expect(bucket.snapshot()).toEqual({tokens: 3, capacity: 10, lastRefillAt: 0})
	})

	it('refills proportionally without exceeding the burst capacity', () => {
		const {clock, set} = controllableClock(100)
		const bucket = createTokenBucket(4, 1_000, 6, clock)
		bucket.tryRemove(6)

		set(600)
		bucket.refill()
		expect(bucket.snapshot().tokens).toBe(2)

		set(10_000)
		bucket.refill()
		expect(bucket.snapshot().tokens).toBe(6)
	})

	it('ignores timestamps that move backwards', () => {
		const {clock} = controllableClock(50)
		const bucket = createTokenBucket(1, 100, 2, clock)
		bucket.tryRemove(1)

		bucket.refill(40)
		expect(bucket.snapshot()).toEqual({tokens: 1, capacity: 2, lastRefillAt: 50})
	})

	it.each([
		[0, 1, 1, 'tokensPerInterval'],
		[1, Number.NaN, 1, 'intervalMs'],
		[1, 1, Number.POSITIVE_INFINITY, 'burst']
	])('rejects invalid configuration', (rate, interval, burst, expected) => {
		const {clock} = controllableClock()
		expect(() => createTokenBucket(rate as number, interval as number, burst as number, clock)).toThrow(expected)
	})

	it('rejects invalid removal and refill values without changing state', () => {
		const {clock} = controllableClock()
		const bucket = createTokenBucket(1, 100, 2, clock)

		expect(() => bucket.tryRemove(0)).toThrow('tokens')
		expect(() => bucket.refill(Number.NaN)).toThrow('refill time')
		expect(bucket.snapshot()).toEqual({tokens: 2, capacity: 2, lastRefillAt: 0})
	})

	it('denies costs that cannot be represented at the current capacity', () => {
		const {clock} = controllableClock()
		const bucket = createTokenBucket(1, 100, Number.MAX_SAFE_INTEGER, clock)

		expect(bucket.tryRemove(Number.MIN_VALUE)).toBe(false)
		expect(bucket.snapshot().tokens).toBe(Number.MAX_SAFE_INTEGER)
		expect(bucket.tryRemove(1)).toBe(true)
		expect(bucket.snapshot().tokens).toBe(Number.MAX_SAFE_INTEGER - 1)
	})

	it('rejects configuration and costs beyond the safe numeric range', () => {
		const {clock} = controllableClock()
		expect(() => createTokenBucket(Number.MAX_VALUE, 100, 1, clock)).toThrow('MAX_SAFE_INTEGER')
		expect(() => createTokenBucket(1, 100, Number.MAX_VALUE, clock)).toThrow('MAX_SAFE_INTEGER')
		const bucket = createTokenBucket(1, 100, 1, clock)
		expect(() => bucket.tryRemove(Number.MAX_VALUE)).toThrow('MAX_SAFE_INTEGER')
	})

	it('captures the clock capability without invoking accessors or late rewiring', () => {
		let now = 0
		const original = vi.fn(() => now)
		const clock = {now: original}
		const bucket = createTokenBucket(1, 100, 2, clock)
		const replacement = vi.fn(() => 10_000)
		clock.now = replacement

		bucket.tryRemove(2)
		now = 100
		bucket.refill()

		expect(bucket.snapshot().tokens).toBe(1)
		expect(replacement).not.toHaveBeenCalled()
		expect(() => createTokenBucket(1, 100, 2, Object.defineProperty({}, 'now', {
			get: () => { throw new Error('accessor executed') }
		}) as never)).toThrow('stable function')
	})

	it('rejects proxied clocks before descriptor or prototype traps', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const getPrototypeOf = vi.fn(() => null)
		const clock = new Proxy({now: () => 0}, {getOwnPropertyDescriptor, getPrototypeOf})

		expect(() => createTokenBucket(1, 100, 2, clock)).toThrow('stable function')
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('does not inherit a forged clock capability from Object.prototype', () => {
		let calls = 0
		Object.defineProperty(Object.prototype, 'now', {
			configurable: true, writable: true, value: () => { calls += 1; return 0 }
		})
		let failure: unknown
		try { createTokenBucket(1, 100, 1, {} as never) }
		catch(error) { failure = error }
		finally { delete (Object.prototype as Record<string, unknown>).now }

		expect(failure).toBeInstanceOf(TypeError)
		expect(calls).toBe(0)
	})

	it('contains rejected native promises returned by a synchronous clock', async() => {
		expect(() => createTokenBucket(1, 100, 2, {
			now: () => Promise.reject(new Error('clock failed')) as never
		})).toThrow('synchronously')
		const thrown = Promise.reject(new Error('clock threw'))
		expect(() => createTokenBucket(1, 100, 2, {now: () => { throw thrown }})).toThrow()
		await Promise.resolve()
	})

	it('bounds synchronous clock re-entry', () => {
		let bucket: ReturnType<typeof createTokenBucket> | undefined
		let now = 0
		const clock = {
			now: vi.fn(() => {
				bucket?.refill()
				return now
			})
		}
		bucket = createTokenBucket(1, 100, 2, clock)
		bucket.tryRemove(2)
		now = 100

		expect(() => bucket?.refill()).not.toThrow()
		expect(bucket.snapshot().tokens).toBe(1)
		expect(clock.now).toHaveBeenCalledTimes(3)
	})

	it('does not allow a clock callback to forge future reads through Function.prototype.call', () => {
		const callDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'call')!
		let reads = 0
		const clock = {
			now: () => {
				reads += 1
				if (reads === 2) {
					Object.defineProperty(Function.prototype, 'call', {
						configurable: true,
						writable: true,
						value: () => 1_000_000
					})
				}
				return 0
			}
		}
		const bucket = createTokenBucket(1, 100, 1, clock)
		let firstRemoval: boolean
		let secondRemoval: boolean

		try {
			firstRemoval = bucket.tryRemove(1)
			secondRemoval = bucket.tryRemove(1)
		} finally {
			Object.defineProperty(Function.prototype, 'call', callDescriptor)
		}

		expect(firstRemoval!).toBe(true)
		expect(secondRemoval!).toBe(false)
		expect(reads).toBe(3)
	})

	it('does not allow a clock callback to poison numeric rate-limit decisions', () => {
		const finiteDescriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite')!
		const minDescriptor = Object.getOwnPropertyDescriptor(Math, 'min')!
		let reads = 0
		const clock = {
			now: () => {
				reads += 1
				if (reads === 2) {
					Object.defineProperty(Number, 'isFinite', {
						configurable: true, writable: true, value: () => true
					})
					Object.defineProperty(Math, 'min', {
						configurable: true, writable: true, value: () => Number.POSITIVE_INFINITY
					})
				}
				return reads >= 3 ? Number.POSITIVE_INFINITY : 0
			}
		}
		const bucket = createTokenBucket(1, 100, 1, clock)
		let firstRemoval = false
		let invalidCostError: unknown
		let invalidClockError: unknown

		try {
			firstRemoval = bucket.tryRemove(1)
			try { bucket.tryRemove(Number.NaN) } catch(error) { invalidCostError = error }
			try { bucket.refill() } catch(error) { invalidClockError = error }
		} finally {
			Object.defineProperty(Number, 'isFinite', finiteDescriptor)
			Object.defineProperty(Math, 'min', minDescriptor)
		}

		expect(firstRemoval).toBe(true)
		expect(invalidCostError).toBeInstanceOf(RangeError)
		expect(invalidClockError).toBeInstanceOf(RangeError)
		expect(bucket.snapshot().tokens).toBe(0)
	})
})
