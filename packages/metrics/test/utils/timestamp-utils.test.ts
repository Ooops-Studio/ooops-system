import {describe, it, expect} from 'vitest'

import {normalizeTimestamp} from '../../src/utils/timestamp-utils'
import {createFixedClock} from '../support/fixed-clock'

describe('timestamp-utils', () => {

	describe('normalizeTimestamp', () => {

		it('should return provided timestamp', () => {

			const clock = createFixedClock(1000)

			expect(normalizeTimestamp(2000, clock)).toBe(2000)
		})

		it('should use clock.now() when timestamp is undefined', () => {

			const clock = createFixedClock(1000)

			expect(normalizeTimestamp(undefined, clock)).toBe(1000)
		})

		it('should use current clock time', () => {

			const clock = createFixedClock(5000)

			expect(normalizeTimestamp(undefined, clock)).toBe(5000)
		})
	})
})
