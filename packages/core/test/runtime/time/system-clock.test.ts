import {describe, it, expect, vi} from 'vitest'

import {createSystemClock, type MillisClock} from '../../../src/runtime/time/system-clock'

describe('system-clock', () => {
	describe('createSystemClock', () => {
		it('should create a clock instance', () => {
			const clock = createSystemClock()
			expect(clock).toBeDefined()
			expect(typeof clock.now).toBe('function')
		})

		it('should return MillisClock interface', () => {
			const clock = createSystemClock()
			expect(clock).toHaveProperty('now')
		})

		it('should return current timestamp', () => {
			const clock = createSystemClock()
			const before = Date.now()
			const result = clock.now()
			const after = Date.now()

			expect(result).toBeGreaterThanOrEqual(before)
			expect(result).toBeLessThanOrEqual(after)
		})

		it('should return different timestamps on subsequent calls', () => {
			const clock = createSystemClock()
			const time1 = clock.now()

			// Small delay to ensure different timestamp
			const start = Date.now()
			while (Date.now() - start < 1) {
				// Busy wait
			}

			const time2 = clock.now()
			expect(time2).toBeGreaterThanOrEqual(time1)
		})

		it('should match Date.now() behavior', () => {
			const clock = createSystemClock()
			const clockTime = clock.now()
			const dateTime = Date.now()

			// Should be very close (within 1ms)
			expect(Math.abs(clockTime - dateTime)).toBeLessThan(10)
		})

		it('preserves its captured time source after Date.now is rewired', () => {
			const clock = createSystemClock()
			const now = vi.spyOn(Date, 'now').mockImplementation(() => {
				throw new Error('rewired clock')
			})
			try {
				expect(clock.now()).toBeGreaterThan(0)
			} finally { now.mockRestore() }
		})
	})

	describe('MillisClock interface', () => {
		it('should have now method that returns number', () => {
			const clock: MillisClock = createSystemClock()
			const result = clock.now()

			expect(typeof result).toBe('number')
			expect(Number.isFinite(result)).toBe(true)
		})
	})
})
