import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it} from 'vitest'

import {MICROTOKENS_PER_TOKEN} from '../../src/rate-limit/core/engines/constants'
import {createFixedWindowEngine} from '../../src/rate-limit/core/engines/fixed-window'
import {createMemoryFixedWindowEngine} from '../../src/rate-limit/core/engines/fixed-window-memory'
import {createTokenBucketEngine} from '../../src/rate-limit/core/engines/token-bucket'

function randomSequence(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
		return state
	}
}

describe('rate-limit model soak', () => {
	it('keeps the development fixed-window engine in parity across clock rollback', async() => {
		const developmentClock = createFixedClock(100_000)
		const referenceClock = createFixedClock(100_000)
		const development = createMemoryFixedWindowEngine(developmentClock)
		const reference = createFixedWindowEngine({clock: referenceClock})
		const random = randomSequence(0xD3E10F)

		for (let step = 0; step < 2_000; step++) {
			const delta = (random() % 2_001) - 1_000
			const next = Math.max(0, developmentClock.now() + delta)
			developmentClock.set(next)
			referenceClock.set(next)
			const key = `key:${random() % 17}`
			const cost = (random() % 3) + 1
			const operation = random() % 4 === 0 ? 'peek' : 'checkAndConsume'
			const expected = await reference[operation](key, 7, 1_003, cost)
			const actual = await development[operation](key, 7, 1_003, cost)
			expect(actual, `${operation} step ${step}`).toEqual(expected)
		}
	})

	it.each([true, false])('matches an independent fixed-window model with alignToClock=%s', async(alignToClock) => {
		const clock = createFixedClock(1_000)
		const engine = createFixedWindowEngine({clock, alignToClock})
		const random = randomSequence(0xC0FFEE)
		const limit = 7
		const windowMs = 113
		const states = new Map<string, {count: number; start: number}>()

		for (let step = 0; step < 2_000; step++) {
			const delta = random() % 26
			clock.advanceBy(delta)
			const now = clock.now()
			const key = `key:${random() % 11}`
			const cost = random() % 4
			const consume = cost > 0 && random() % 3 !== 0
			const previous = states.get(key)
			let start: number
			if (!previous) start = alignToClock ? Math.floor(now / windowMs) * windowMs : now
			else if (now < previous.start) start = previous.start
			else if (!alignToClock && now < previous.start + windowMs) start = previous.start
			else start = alignToClock ? Math.floor(now / windowMs) * windowMs : now
			const count = !previous || previous.start !== start ? 0 : previous.count
			const allowed = count + cost <= limit
			const expected = {allowed, remaining: limit - count, resetAt: start + windowMs}

			if (consume) {
				const result = await engine.checkAndConsume(key, limit, windowMs, cost)
				const nextCount = allowed ? count + cost : count
				states.set(key, {count: nextCount, start})
				expect(result, `consume step ${step}`).toEqual({
					allowed,
					remaining: limit - nextCount,
					resetAt: start + windowMs
				})
			} else {
				const first = await engine.peek(key, limit, windowMs, cost)
				const second = await engine.peek(key, limit, windowMs, cost)
				expect(first, `peek step ${step}`).toEqual(expected)
				expect(second, `repeat peek step ${step}`).toEqual(expected)
			}
		}
	})

	it('matches an integer-microtoken model across refill, denial, peek, and clock rollback', async() => {
		const clock = createFixedClock(10_000)
		const capacity = 3
		const limit = 3
		const windowMs = 1_000
		const refillRate = 0.001
		const rateMicrotokensPerMs = refillRate * MICROTOKENS_PER_TOKEN
		const precisionEpsilonMicrotokens = 0.000_001
		const precisionEpsilonTokens = precisionEpsilonMicrotokens / MICROTOKENS_PER_TOKEN
		const engine = createTokenBucketEngine({clock, capacity, refillRate})
		const random = randomSequence(0xBAD5EED)
		let tokens = capacity * MICROTOKENS_PER_TOKEN
		let lastRefill = clock.now()

		const virtualState = (now: number) => {
			const elapsed = Math.max(0, now - lastRefill)
			const cappedElapsed = Math.min(elapsed, capacity / refillRate)
			return Math.min(capacity * MICROTOKENS_PER_TOKEN, tokens + cappedElapsed * rateMicrotokensPerMs)
		}
		const decision = (available: number, now: number, cost: number) => {
			const availableTokens = available / MICROTOKENS_PER_TOKEN
			const allowed = available + precisionEpsilonMicrotokens >= cost * MICROTOKENS_PER_TOKEN
			const resetAt = Math.max(now, lastRefill) + Math.ceil(
				Math.max(0, Math.min(limit, capacity) - availableTokens - precisionEpsilonTokens) / refillRate
			)
			return {
				allowed,
				remaining: Math.min(limit, Math.max(0, Math.floor(availableTokens))),
				resetAt,
				...(!allowed ? {
					retryAt: Math.max(now, lastRefill) + Math.ceil(Math.max(0, cost - availableTokens - precisionEpsilonTokens) / refillRate)
				} : {})
			}
		}

		for (let step = 0; step < 2_000; step++) {
			const delta = (random() % 41) - 10
			clock.set(Math.max(0, clock.now() + delta))
			const now = clock.now()
			const cost = (random() % 3) + 1
			const consume = random() % 3 !== 0
			const available = virtualState(now)
			const before = decision(available, now, cost)

			if (!consume) {
				expect(await engine.peek('bucket', limit, windowMs, cost), `peek step ${step}`).toEqual(before)
				expect(await engine.peek('bucket', limit, windowMs, cost), `repeat peek step ${step}`).toEqual(before)
				continue
			}

			let persisted = available
			if (before.allowed) persisted -= cost * MICROTOKENS_PER_TOKEN
			tokens = persisted
			lastRefill = Math.max(lastRefill, now)
			const expected = before.allowed ? decision(persisted, now, 0) : before
			expect(await engine.checkAndConsume('bucket', limit, windowMs, cost), `consume step ${step}`).toEqual(expected)
		}
	})
})
