import {describe, expect, it} from 'vitest'

import {createFixedClock, type FixedClock} from '../../../src/runtime/time/fixed-clock'

describe('fixed-clock', () => {
	it('starts at the requested time', () => {
		const clock = createFixedClock(1_000)
		expect(clock.now()).toBe(1_000)
	})

	it('sets and advances deterministically', () => {
		const clock: FixedClock = createFixedClock(1_000)
		clock.advanceBy(250)
		expect(clock.now()).toBe(1_250)
		clock.set(-50)
		expect(clock.now()).toBe(-50)
	})

	it('accepts negative and zero deltas', () => {
		const clock = createFixedClock(0)
		clock.advanceBy(0)
		expect(clock.now()).toBe(0)
		clock.advanceBy(-10)
		expect(clock.now()).toBe(-10)
	})

	it('rejects invalid timestamps atomically', () => {
		expect(() => createFixedClock(Infinity)).toThrow('finite')
		const clock = createFixedClock(Number.MAX_SAFE_INTEGER)
		expect(() => clock.advanceBy(1)).toThrow('safe numeric')
		expect(clock.now()).toBe(Number.MAX_SAFE_INTEGER)
		expect(() => clock.set(Number.NaN)).toThrow('finite')
		expect(clock.now()).toBe(Number.MAX_SAFE_INTEGER)
	})

	it('contains rejected promises supplied as timestamps', async() => {
		const initial = Promise.reject(new Error('initial rejected'))
		expect(() => createFixedClock(initial as never)).toThrow('finite')
		const clock = createFixedClock(0)
		const delta = Promise.reject(new Error('delta rejected'))
		expect(() => clock.advanceBy(delta as never)).toThrow('finite')
		await Promise.resolve()
	})
})
