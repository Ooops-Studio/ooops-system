import {describe, it, expect, vi} from 'vitest'

import type {Clock} from '../../src/contracts/clock'
import {getNow, normalizeTimestamp} from '../../src/utils/clock'

describe('clock utils', () => {
	describe('getNow', () => {
		it('should return Date.now() when no clock is provided', () => {
			const before = Date.now()
			const result = getNow()
			const after = Date.now()

			expect(result).toBeGreaterThanOrEqual(before)
			expect(result).toBeLessThanOrEqual(after)
		})

		it('should use clock.now() when clock is provided', () => {
			const mockClock: Clock = {
				now: vi.fn().mockReturnValue(1234567890000)
			}

			const result = getNow(mockClock)

			expect(result).toBe(1234567890000)
			expect(mockClock.now).toHaveBeenCalledTimes(1)
		})

		it('should handle clock.now() returning different values', () => {
			let callCount = 0
			const mockClock: Clock = {
				now: vi.fn(() => {
					callCount++
					return 1000000000000 + callCount
				})
			}

			const result1 = getNow(mockClock)
			const result2 = getNow(mockClock)

			expect(result1).toBe(1000000000001)
			expect(result2).toBe(1000000000002)
		})

		it('preserves the captured fallback after Date.now is rewired', () => {
			const rewired = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('rewired') })
			try { expect(getNow()).toBeGreaterThan(0) } finally { rewired.mockRestore() }
		})

		it('contains rejected promises and rejects accessor-backed clock capabilities', async() => {
			expect(() => getNow({now: () => Promise.reject(new Error('clock failed')) as never}))
				.toThrow('synchronously')
			const getter = vi.fn(() => () => 1)
			expect(() => getNow(Object.defineProperty({}, 'now', {get: getter}) as Clock))
				.toThrow('stable data-method')
			expect(getter).not.toHaveBeenCalled()
			await Promise.resolve()
		})
	})

	describe('normalizeTimestamp', () => {
		it('should return provided timestamp when it is defined', () => {
			const clock: Clock = {
				now: vi.fn().mockReturnValue(1234567890000)
			}

			const result = normalizeTimestamp(999999999999, clock)

			expect(result).toBe(999999999999)
			expect(clock.now).not.toHaveBeenCalled()
		})

		it('should use clock.now() when timestamp is undefined', () => {
			const clock: Clock = {
				now: vi.fn().mockReturnValue(1234567890000)
			}

			const result = normalizeTimestamp(undefined, clock)

			expect(result).toBe(1234567890000)
			expect(clock.now).toHaveBeenCalledTimes(1)
		})

		it('should handle zero timestamp', () => {
			const clock: Clock = {
				now: vi.fn().mockReturnValue(1234567890000)
			}

			const result = normalizeTimestamp(0, clock)

			expect(result).toBe(0)
			expect(clock.now).not.toHaveBeenCalled()
		})
	})
})
