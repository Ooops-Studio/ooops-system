import {describe, it, expect, beforeEach, vi} from 'vitest'

import {createCardinalityGuard, fingerprintLabels} from '../../../src/performance/core/cardinality-guard'

describe('createCardinalityGuard', () => {

	describe('with finite limit', () => {

		let guard: ReturnType<typeof createCardinalityGuard>

		beforeEach(() => {

			guard = createCardinalityGuard({maxCombinations: 3})
		})

		it('should allow events within limit', () => {

			const result1 = guard.check('metric1', {env: 'test'})
			expect(result1.allowed).toBe(true)

			const result2 = guard.check('metric1', {env: 'prod'})
			expect(result2.allowed).toBe(true)

			const result3 = guard.check('metric1', {env: 'dev'})
			expect(result3.allowed).toBe(true)
		})

		it('should reject events exceeding limit', () => {

			// Add 3 combinations
			guard.check('metric1', {env: 'test'})
			guard.check('metric1', {env: 'prod'})
			guard.check('metric1', {env: 'dev'})

			// 4th should be rejected
			const result = guard.check('metric1', {env: 'staging'})
			expect(result.allowed).toBe(false)
			expect(result.reason).toBe('limit-exceeded')
		})

		it('should track combinations per metric independently', () => {

			// Fill metric1
			guard.check('metric1', {env: 'test'})
			guard.check('metric1', {env: 'prod'})
			guard.check('metric1', {env: 'dev'})

			// metric2 should still have capacity
			const result = guard.check('metric2', {env: 'test'})
			expect(result.allowed).toBe(true)
		})

		it('should allow duplicate combinations', () => {

			guard.check('metric1', {env: 'test'})
			const result = guard.check('metric1', {env: 'test'})
			expect(result.allowed).toBe(true)
		})

		it('should handle events without labels', () => {

			const result = guard.check('metric1')
			expect(result.allowed).toBe(true)
		})

		it('should handle empty labels object', () => {

			const result = guard.check('metric1', {})
			expect(result.allowed).toBe(true)
		})

		it('should serialize labels consistently', () => {

			guard.check('metric1', {a: '1', b: '2'})
			const result = guard.check('metric1', {b: '2', a: '1'}) // Different order
			expect(result.allowed).toBe(true) // Should be treated as same
		})

		it('does not collide label values containing serialization delimiters', () => {
			const limited = createCardinalityGuard({maxCombinations: 1})
			expect(limited.check('metric1', {a: 'b,c=d'})).toEqual({allowed: true})
			expect(limited.check('metric1', {a: 'b', c: 'd'})).toEqual({
				allowed: false,
				reason: 'limit-exceeded'
			})
		})

		it('should reject invalid label values', () => {

			const result = guard.check('metric1', {
				// @ts-expect-error - testing invalid input
				invalid: 123
			})
			expect(result.allowed).toBe(false)
			expect(result.reason).toBe('invalid-labels')
			const throwing = new Proxy({}, {ownKeys: () => { throw new Error('labels failed') }}) as Record<string, string>
			expect(guard.check('metric1', throwing)).toEqual({allowed: false, reason: 'invalid-labels'})
		})

		it('should reset all tracked combinations', () => {

			// Fill to limit
			guard.check('metric1', {env: 'test'})
			guard.check('metric1', {env: 'prod'})
			guard.check('metric1', {env: 'dev'})

			// Should be at limit
			expect(guard.check('metric1', {env: 'staging'}).allowed).toBe(false)

			// Reset
			guard.reset()

			// Should allow again
			expect(guard.check('metric1', {env: 'staging'}).allowed).toBe(true)
		})
	})

	describe('with Infinity limit (disabled)', () => {

		let guard: ReturnType<typeof createCardinalityGuard>

		beforeEach(() => {

			guard = createCardinalityGuard({maxCombinations: Number.POSITIVE_INFINITY})
		})

		it('should always allow events', () => {

			for (let i = 0; i < 100; i++) {
				const result = guard.check('metric1', {index: String(i)})
				expect(result.allowed).toBe(true)
			}
		})
	})

	describe('warn mode', () => {
		it('allows over-limit combinations without requiring an observer', () => {
			const guard = createCardinalityGuard({maxCombinations: 1, mode: 'warn'})
			expect(guard.check('metric1', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric1', {env: 'prod'}).allowed).toBe(true)
		})

		it('should allow events but call onExceeded callback', () => {

			const onExceeded = vi.fn()
			const guard = createCardinalityGuard({
				maxCombinations: 2,
				mode: 'warn',
				onExceeded
			})

			guard.check('metric1', {env: 'test'})
			guard.check('metric1', {env: 'prod'})

			// Should exceed limit but still allow
			const result = guard.check('metric1', {env: 'dev'})
			expect(result).toEqual({allowed: true, reason: 'limit-exceeded'})
			expect(onExceeded).toHaveBeenCalledWith('metric1', 'limit-exceeded')
		})

		it('should not grow past the limit in warn mode', () => {

			const onExceeded = vi.fn()
			const guard = createCardinalityGuard({
				maxCombinations: 1,
				mode: 'warn',
				onExceeded
			})

			expect(guard.check('metric1', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric1', {env: 'prod'}).allowed).toBe(true)
			expect(guard.check('metric1', {env: 'dev'}).allowed).toBe(true)

			expect(onExceeded).toHaveBeenCalledTimes(2)
			expect(guard.check('metric1', {env: 'prod'})).toEqual({
				allowed: true,
				reason: 'limit-exceeded'
			})
			expect(onExceeded).toHaveBeenCalledTimes(3)
		})
	})

	describe('drop mode (default)', () => {

		it('should reject events exceeding limit', () => {

			const guard = createCardinalityGuard({
				maxCombinations: 2,
				mode: 'drop'
			})

			guard.check('metric1', {env: 'test'})
			guard.check('metric1', {env: 'prod'})

			const result = guard.check('metric1', {env: 'dev'})
			expect(result.allowed).toBe(false)
			expect(result.reason).toBe('limit-exceeded')
		})
	})

	describe('default options', () => {

		it('should default to Infinity limit', () => {

			const guard = createCardinalityGuard()
			const result = guard.check('metric1', {env: 'test'})
			expect(result.allowed).toBe(true)
		})

		it('should default to drop mode', () => {

			const guard = createCardinalityGuard({maxCombinations: 1})
			guard.check('metric1', {env: 'test'})

			const result = guard.check('metric1', {env: 'prod'})
			expect(result.allowed).toBe(false)
		})
	})

	describe('configuration validation', () => {
		it('rejects impossible cardinality limits', () => {
			expect(() => createCardinalityGuard({maxCombinations: -1})).toThrow('maxCombinations')
			expect(() => createCardinalityGuard({maxMetrics: 1.5})).toThrow('maxMetrics')
			expect(() => createCardinalityGuard({maxMetrics: 0})).toThrow('maxMetrics')
			expect(() => createCardinalityGuard({ttlMs: -1})).toThrow('ttlMs')
			expect(() => createCardinalityGuard({mode: 'invalid' as never})).toThrow('mode')
		})
	})

	describe('bounded memory', () => {

		it('fingerprints hostile label payloads into fixed-size retained keys', () => {
			const large = {['k'.repeat(4_096)]: 'v'.repeat(1_000_000)}
			expect(fingerprintLabels(large)).toHaveLength(43)
			expect(fingerprintLabels({a: '1', b: '2'})).toBe(fingerprintLabels({b: '2', a: '1'}))
			expect(fingerprintLabels({a: 'b,c=d'})).not.toBe(fingerprintLabels({a: 'b', c: 'd'}))
			expect(fingerprintLabels({a: '\uD800'})).not.toBe(fingerprintLabels({a: '\uD801'}))
		})

		it('should evict stale metric state by ttl', () => {

			let now = 0
			const guard = createCardinalityGuard({
				maxCombinations: 1,
				maxMetrics: 2,
				ttlMs: 10,
				now: () => now
			})

			expect(guard.check('metric1', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric1', {env: 'prod'}).allowed).toBe(false)

			now = 20
			expect(guard.check('metric2', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric1', {env: 'prod'}).allowed).toBe(true)
		})

		it('evicts stale state even when the metric-count limit is disabled', () => {
			let now = 0
			const guard = createCardinalityGuard({
				maxCombinations: 1,
				maxMetrics: Number.POSITIVE_INFINITY,
				ttlMs: 10,
				now: () => now
			})
			expect(guard.check('metric1', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric1', {env: 'prod'}).allowed).toBe(false)

			now = 20
			expect(guard.check('metric2', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric1', {env: 'prod'}).allowed).toBe(true)
		})

		it('rejects new metric names instead of forgetting protected metrics', () => {

			const guard = createCardinalityGuard({
				maxCombinations: 1,
				maxMetrics: 1
			})

			expect(guard.check('metric1', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric2', {env: 'test'})).toEqual({allowed: false, reason: 'limit-exceeded'})
			expect(guard.check('metric1', {env: 'prod'})).toEqual({allowed: false, reason: 'limit-exceeded'})
		})

		it('keeps all admitted metric state when the name bound is reached', () => {

			const guard = createCardinalityGuard({
				maxCombinations: 1,
				maxMetrics: 2
			})

			expect(guard.check('metric1', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric2', {env: 'test'}).allowed).toBe(true)
			expect(guard.check('metric3', {env: 'test'})).toEqual({allowed: false, reason: 'limit-exceeded'})

			expect(guard.check('metric2', {env: 'prod'})).toEqual({
				allowed: false,
				reason: 'limit-exceeded'
			})
		})
	})
})
