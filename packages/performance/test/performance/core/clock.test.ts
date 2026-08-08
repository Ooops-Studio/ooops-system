import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, it, expect, vi} from 'vitest'

import {createHighResClock, nsToMs} from '../../../src/performance/core/clock'

describe('createHighResClock', () => {

	describe('with hrtime.bigint() (Node.js)', () => {

		it('should create high-resolution clock using hrtime', () => {

			const baseClock = createFixedClock(1000)
			const clock = createHighResClock({clock: baseClock})

			expect(clock.now()).toBe(1000)
			expect(typeof clock.nowHr()).toBe('bigint')
			expect(clock.nowHr()).toBeGreaterThanOrEqual(0n)
		})

		it('should use base clock for now()', () => {

			const baseClock = createFixedClock(5000)
			const clock = createHighResClock({clock: baseClock})

			expect(clock.now()).toBe(5000)
		})

		it('preserves receiver binding for stateful Clock implementations', () => {
			const baseClock = {
				value: 7,
				now() { return this.value }
			}
			const clock = createHighResClock({clock: baseClock})
			expect(clock.now()).toBe(7)
			baseClock.value = 9
			expect(clock.now()).toBe(9)
		})

		it('uses an injected high-resolution clock and preserves its receiver', () => {
			const baseClock = {
				value: 5n,
				now: () => 1,
				nowHr() { return this.value }
			}
			const clock = createHighResClock({clock: baseClock})
			expect(clock.nowHr()).toBe(5n)
			baseClock.value = 9n
			expect(clock.nowHr()).toBe(9n)
		})

		it('keeps epoch timestamps nondecreasing when a wall clock regresses', () => {
			let value = 100
			const clock = createHighResClock({clock: {now: () => value}})
			expect(clock.now()).toBe(100)
			value = 90
			expect(clock.now()).toBe(100)
			value = 110
			expect(clock.now()).toBe(110)
		})

		it('contains throwing, non-finite, and regressing custom clock reads', () => {
			let wall: unknown = 100
			let highResolution: unknown = 10n
			const clock = createHighResClock({clock: {
				now: () => {
					if (wall instanceof Error) throw wall
					return wall as number
				},
				nowHr: () => {
					if (highResolution instanceof Error) throw highResolution
					return highResolution as bigint
				}
			}})
			expect(clock.now()).toBe(100)
			expect(clock.nowHr()).toBe(10n)
			wall = Number.NaN
			highResolution = -1n
			expect(clock.now()).toBe(100)
			expect(clock.nowHr()).toBe(10n)
			wall = new Error('wall failed')
			highResolution = new Error('high-resolution failed')
			expect(clock.now()).toBe(100)
			expect(clock.nowHr()).toBe(10n)
			wall = 120
			highResolution = 20n
			expect(clock.now()).toBe(120)
			expect(clock.nowHr()).toBe(20n)
		})

		it('observes and disables clock methods that return native Promises', async() => {
			const rejectedWall = Promise.reject(new Error('wall failed'))
			const rejectedHighResolution = Promise.reject(new Error('high-resolution failed'))
			const now = vi.fn(() => rejectedWall as never)
			const nowHr = vi.fn(() => rejectedHighResolution as never)
			try {
				const clock = createHighResClock({clock: {now, nowHr}})
				expect(Number.isFinite(clock.now())).toBe(true)
				expect(Number.isFinite(clock.now())).toBe(true)
				expect(clock.nowHr()).toBe(0n)
				expect(clock.nowHr()).toBe(0n)
				expect(now).toHaveBeenCalledOnce()
				expect(nowHr).toHaveBeenCalledOnce()
			} finally {
				await rejectedWall.catch(() => undefined)
				await rejectedHighResolution.catch(() => undefined)
			}
		})

		it('bounds synchronous re-entry from custom clock methods', () => {
			let clock!: ReturnType<typeof createHighResClock>
			const now = vi.fn(() => clock.now())
			const nowHr = vi.fn(() => clock.nowHr())
			clock = createHighResClock({clock: {now, nowHr}})

			expect(Number.isFinite(clock.now())).toBe(true)
			expect(clock.nowHr()).toBe(0n)
			expect(now).toHaveBeenCalledOnce()
			expect(nowHr).toHaveBeenCalledOnce()
		})

		it('does not regress after the first wall-clock read falls back', () => {
			let wall = Number.NaN
			const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
			try {
				const clock = createHighResClock({clock: {now: () => wall}})
				expect(clock.now()).toBe(1_000)
				wall = 50
				expect(clock.now()).toBe(1_000)
			} finally {
				dateNow.mockRestore()
			}
		})

		it('rejects malformed clock configuration', () => {
			expect(() => createHighResClock(null as never)).toThrow('options')
			expect(() => createHighResClock({clock: {} as never})).toThrow('now()')
			const readClock = vi.fn(() => ({now: () => 1}))
			const accessorOptions = Object.defineProperty({}, 'clock', {get: readClock})
			expect(() => createHighResClock(accessorOptions as never)).toThrow('data property')
			expect(readClock).not.toHaveBeenCalled()
			const getPrototypeOf = vi.fn(() => Object.prototype)
			const proxyClock = new Proxy({now: () => 1}, {getPrototypeOf})
			expect(() => createHighResClock({clock: proxyClock})).toThrow('now()')
			expect(getPrototypeOf).not.toHaveBeenCalled()
		})

		it('should return increasing high-res timestamps', () => {

			const clock = createHighResClock()
			const t1 = clock.nowHr()
			const t2 = clock.nowHr()

			expect(t2).toBeGreaterThanOrEqual(t1)
		})
	})

	describe('with performance.now() (browser fallback)', () => {

		it('should handle missing hrtime gracefully', () => {

			const originalHrtime = process.hrtime
			// @ts-expect-error - testing fallback
			delete process.hrtime

			try {
				const clock = createHighResClock()
				expect(typeof clock.now()).toBe('number')
				expect(typeof clock.nowHr()).toBe('bigint')
			} finally {
				process.hrtime = originalHrtime
			}
		})
	})

	describe('with Date.now() fallback', () => {

		it('should fallback to Date.now() when no high-res API available', () => {

			const originalHrtime = process.hrtime
			const originalPerformance = global.performance
			// @ts-expect-error - testing fallback
			delete process.hrtime
			// @ts-expect-error - testing fallback
			delete global.performance

			try {
				const clock = createHighResClock()

				expect(typeof clock.now()).toBe('number')
				expect(typeof clock.nowHr()).toBe('bigint')
			} finally {
				process.hrtime = originalHrtime
				global.performance = originalPerformance
			}
		})
	})

	describe('default clock', () => {

		it('should use Date.now() as default base clock', () => {

			const clock = createHighResClock()
			const before = Date.now()
			const now = clock.now()
			const after = Date.now()

			expect(now).toBeGreaterThanOrEqual(before)
			expect(now).toBeLessThanOrEqual(after)
		})
	})
})

describe('nsToMs', () => {

	it('should convert nanoseconds to milliseconds', () => {

		expect(nsToMs(1_000_000n)).toBe(1)
		expect(nsToMs(5_000_000n)).toBe(5)
		expect(nsToMs(1_500_000n)).toBe(1.5)
	})

	it('should handle zero', () => {

		expect(nsToMs(0n)).toBe(0)
	})

	it('should handle large values', () => {

		expect(nsToMs(1_000_000_000n)).toBe(1000)
		expect(nsToMs(1_000_000_000_000n)).toBe(1_000_000)
	})

	it('should handle fractional milliseconds', () => {

		expect(nsToMs(500_000n)).toBe(0.5)
		expect(nsToMs(250_000n)).toBe(0.25)
	})
})
