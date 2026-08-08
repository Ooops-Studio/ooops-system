import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import {createMonotonicClock, type MonotonicMillisClock} from '../../../src/runtime/time/monotonic-clock'

describe('monotonic-clock', () => {

	const originalPerformance = globalThis.performance
	const originalHrtime = Object.getOwnPropertyDescriptor(process, 'hrtime')

	beforeEach(() => {

		vi.clearAllMocks()
	})

	afterEach(() => {

		// Restore originals
		if (globalThis.performance !== originalPerformance) {
			Object.defineProperty(globalThis, 'performance', {
				value: originalPerformance,
				writable: true,
				configurable: true
			})
		}
		if (originalHrtime) Object.defineProperty(process, 'hrtime', originalHrtime)
	})

	describe('createMonotonicClock', () => {

		it('should create a clock instance', () => {

			const clock = createMonotonicClock()
			expect(clock).toBeDefined()
			expect(typeof clock.now).toBe('function')
		})

		it('should return MonotonicMillisClock interface', () => {

			const clock: MonotonicMillisClock = createMonotonicClock()
			expect(clock).toHaveProperty('now')
		})

		it('should use performance.now() when available', () => {

			const mockNow = vi.fn(() => 123.456)
			Object.defineProperty(globalThis, 'performance', {
				value: {now: mockNow},
				writable: true,
				configurable: true
			})

			const clock = createMonotonicClock()
			const time = clock.now()

			expect(time).toBe(123.456)
			expect(mockNow).toHaveBeenCalled()
		})

		it('should use hrtime.bigint() as fallback when performance.now() unavailable', () => {

			// Remove performance
			Object.defineProperty(globalThis, 'performance', {
				value: undefined,
				writable: true,
				configurable: true
			})

			const mockBigint = vi.fn(() => BigInt(1000000))
			const mockHrtime = {
				bigint: mockBigint
			}

			Object.defineProperty(process, 'hrtime', {
				value: mockHrtime,
				writable: true,
				configurable: true
			})

			const clock = createMonotonicClock()
			const time = clock.now()

			expect(mockBigint).toHaveBeenCalled()
			expect(time).toBeGreaterThanOrEqual(0)
		})

		it('should use Date.now() as last resort', () => {

			// Remove performance
			Object.defineProperty(globalThis, 'performance', {
				value: undefined,
				writable: true,
				configurable: true
			})

			// Remove hrtime
			Object.defineProperty(process, 'hrtime', {
				value: undefined,
				writable: true,
				configurable: true
			})

			const clock = createMonotonicClock()
			const time1 = clock.now()
			const time2 = clock.now()

			expect(time2).toBeGreaterThanOrEqual(time1)
		})

		it('should handle clock going backwards in fallback mode', () => {

			// Remove performance and hrtime to force fallback
			Object.defineProperty(globalThis, 'performance', {
				value: undefined,
				writable: true,
				configurable: true
			})

			Object.defineProperty(process, 'hrtime', {
				value: undefined,
				writable: true,
				configurable: true
			})

			const clock = createMonotonicClock()
			const time1 = clock.now()

			// Mock Date.now() to go backwards
			const originalDateNow = Date.now
			let callCount = 0
			Date.now = vi.fn(() => {
				callCount++
				// First call returns higher value, second returns lower
				return callCount === 1 ? time1 + 100 : time1 - 50
			})

			const time2 = clock.now()
			const time3 = clock.now()

			// Should never go backwards
			expect(time2).toBeGreaterThanOrEqual(time1)
			expect(time3).toBeGreaterThanOrEqual(time2)

			Date.now = originalDateNow
		})

		it('should return increasing values', () => {

			const clock = createMonotonicClock()
			const time1 = clock.now()

			// Small delay
			const start = Date.now()
			while (Date.now() - start < 1) {
				// Busy wait
			}

			const time2 = clock.now()
			expect(time2).toBeGreaterThanOrEqual(time1)
		})

		it('should never go backwards', () => {

			const clock = createMonotonicClock()
			const times: number[] = []

			for (let i = 0; i < 10; i++) {
				times.push(clock.now())
				// Small delay
				const start = Date.now()
				while (Date.now() - start < 1) {
					// Busy wait
				}
			}

			for (let i = 1; i < times.length; i++) {
				expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
			}
		})

		it('should return finite numbers', () => {

			const clock = createMonotonicClock()
			const time = clock.now()

			expect(Number.isFinite(time)).toBe(true)
			expect(time).toBeGreaterThanOrEqual(0)
		})

		it('should handle rapid calls', () => {

			const clock = createMonotonicClock()
			const times: number[] = []

			for (let i = 0; i < 100; i++) {
				times.push(clock.now())
			}

			// All should be finite and non-decreasing
			for (let i = 1; i < times.length; i++) {
				expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
			}
		})

		it('should handle performance.now() returning same value', () => {

			let callCount = 0
			const mockNow = vi.fn(() => {
				callCount++
				return 100 + (callCount > 1 ? 0 : 0) // Same value on subsequent calls
			})

			Object.defineProperty(globalThis, 'performance', {
				value: {now: mockNow},
				writable: true,
				configurable: true
			})

			const clock = createMonotonicClock()
			const time1 = clock.now()
			const time2 = clock.now()

			// Should still be monotonic (performance.now() is already monotonic)
			expect(time2).toBeGreaterThanOrEqual(time1)
		})

		it('contains regressed, invalid, and throwing host-clock observations', () => {
			const observations: Array<number | Error> = [100, 50, Number.POSITIVE_INFINITY, new Error('clock failed')]
			const mockNow = vi.fn(() => {
				const value = observations.shift()!
				if (value instanceof Error) throw value
				return value
			})
			Object.defineProperty(globalThis, 'performance', {
				value: {now: mockNow}, writable: true, configurable: true
			})
			const clock = createMonotonicClock()
			expect([clock.now(), clock.now(), clock.now(), clock.now()]).toEqual([100, 100, 100, 100])
		})

		it('contains rejected promises returned or thrown by host clocks', async() => {
			const returned = Promise.reject(new Error('clock returned rejection'))
			const thrown = Promise.reject(new Error('clock threw rejection'))
			const observations: unknown[] = [100, returned, thrown]
			const mockNow = vi.fn(() => {
				const value = observations.shift()
				if (value === thrown) throw value
				return value
			})
			Object.defineProperty(globalThis, 'performance', {
				value: {now: mockNow}, writable: true, configurable: true
			})
			const clock = createMonotonicClock()
			expect([clock.now(), clock.now(), clock.now()]).toEqual([100, 100, 100])
			await Promise.resolve()
		})

		it('falls through throwing host clock accessors to captured Date time', () => {
			Object.defineProperty(globalThis, 'performance', {
				configurable: true,
				value: Object.defineProperty({}, 'now', {get: () => { throw new Error('performance poisoned') }})
			})
			Object.defineProperty(process, 'hrtime', {
				configurable: true,
				get: () => { throw new Error('hrtime poisoned') }
			})
			const rewiredDate = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('date poisoned') })
			try {
				const clock = createMonotonicClock()
				expect(clock.now()).toBeGreaterThan(0)
			} finally { rewiredDate.mockRestore() }
		})

		it('should calculate hrtime difference correctly', () => {

			Object.defineProperty(globalThis, 'performance', {
				value: undefined,
				writable: true,
				configurable: true
			})

			let bigintCallCount = 0
			const origin = BigInt(1000000000) // 1 second in nanoseconds
			const mockBigint = vi.fn(() => {
				bigintCallCount++
				// Return increasing values
				return origin + BigInt(bigintCallCount * 1000000) // Add milliseconds in nanoseconds
			})

			Object.defineProperty(process, 'hrtime', {
				value: {bigint: mockBigint},
				writable: true,
				configurable: true
			})

			const clock = createMonotonicClock()
			const time1 = clock.now()
			const time2 = clock.now()

			expect(time1).toBeGreaterThanOrEqual(0)
			expect(time2).toBeGreaterThanOrEqual(time1)
		})
	})
})
