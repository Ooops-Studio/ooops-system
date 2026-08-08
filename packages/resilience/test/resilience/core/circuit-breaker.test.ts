/**
 * @file Tests for circuit breaker engine (L1 pure logic).
 */

import type {CircuitBreakerConfig} from '@ooopsstudio/core/contracts/resilience'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, it, expect, beforeEach, vi} from 'vitest'

import {createCircuitBreakerEngine} from '../../../src/resilience/core/circuit-breaker'

describe('circuit-breaker', () => {

	let clock: ReturnType<typeof createFixedClock>
	let breaker: ReturnType<typeof createCircuitBreakerEngine>
	const resource = 'test-resource'
	const scope = 'resource' as const
	const id = 'test-id'

	beforeEach(() => {

		clock = createFixedClock(1000)
		const config: CircuitBreakerConfig = {
			failureRatioThreshold: 0.5,
			failureCountThreshold: 5,
			timeWindow: 60000,
			halfOpenTimeout: 30000,
			halfOpenMaxAttempts: 3
		}
		breaker = createCircuitBreakerEngine({
			clock,
			config
		})

	})

	it('should start in CLOSED state', () => {

		const result = breaker.canAttempt(resource, scope, id)
		expect(result.allowed).toBe(true)
		expect(result.state).toBe('CLOSED')

	})

	it('snapshots breaker thresholds so later config mutation cannot disable protection', () => {
		const mutableConfig: CircuitBreakerConfig = {
			failureRatioThreshold: 1,
			failureCountThreshold: 1,
			timeWindow: 60_000,
			halfOpenTimeout: 30_000,
			halfOpenMaxAttempts: 1
		}
		const bounded = createCircuitBreakerEngine({clock, config: mutableConfig})
		;(mutableConfig as {failureCountThreshold: number}).failureCountThreshold = 10_000

		bounded.recordFailure(resource, scope, id)
		expect(bounded.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
	})

	it('does not coerce invalid config values while rejecting them', () => {
		const coerce = vi.fn(() => 0)
		const hostile = {[Symbol.toPrimitive]: coerce}
		expect(() => createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: hostile,
				failureCountThreshold: 1,
				timeWindow: 1,
				halfOpenTimeout: 1,
				halfOpenMaxAttempts: 1
			} as never
		})).toThrow(/failureRatioThreshold/u)
		expect(coerce).not.toHaveBeenCalled()
	})

	it('captures the clock method so rewiring cannot force an early half-open probe', () => {
		const mutableClock = {now: () => 0}
		const bounded = createCircuitBreakerEngine({
			clock: mutableClock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 1
			}
		})
		bounded.recordFailure(resource, scope, id)
		expect(bounded.canAttempt(resource, scope, id).state).toBe('OPEN')
		mutableClock.now = () => 1_000_000

		expect(bounded.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
	})

	it('fails closed when the clock fails during a half-open probe failure', () => {
		let now = 0
		let clockFails = false
		const bounded = createCircuitBreakerEngine({
			clock: {now: () => { if (clockFails) throw new Error('clock failed'); return now }},
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 1
			}
		})
		const closed = bounded.canAttempt(resource, scope, id)
		bounded.recordFailure(resource, scope, id, closed.state, closed.generation, closed.admission)
		expect(bounded.canAttempt(resource, scope, id).state).toBe('OPEN')
		now = 10
		const probe = bounded.canAttempt(resource, scope, id)
		expect(probe).toMatchObject({allowed: true, state: 'HALF_OPEN'})
		clockFails = true
		expect(() => bounded.recordFailure(resource, scope, id, probe.state, probe.generation, probe.admission)).not.toThrow()
		clockFails = false
		expect(bounded.peek(resource, scope, id)).toMatchObject({state: 'OPEN', lastTransitionTime: Number.MAX_SAFE_INTEGER})
		expect(bounded.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
	})

	it('transitions atomically and fails closed when the clock fails while opening', () => {
		let now = 0
		let calls = 0
		let failOnCall: number | undefined
		const bounded = createCircuitBreakerEngine({
			clock: {now: () => {
				calls++
				if (calls === failOnCall) throw new Error('clock failed')
				return now
			}},
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 1
			}
		})
		bounded.recordFailure(resource, scope, id)
		// Opening reads the clock once while evaluating the rolling window and once
		// for the transition timestamp. Fail only the latter read.
		failOnCall = calls + 2
		expect(bounded.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
		expect(bounded.peek(resource, scope, id)).toMatchObject({
			state: 'OPEN',
			lastTransitionTime: Number.MAX_SAFE_INTEGER
		})

		now = 9_007_197_107_257_344
		failOnCall = undefined
		expect(bounded.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
	})

	it('does not lose an admitted failure when closed-window clock accounting fails', () => {
		let fail = false
		const bounded = createCircuitBreakerEngine({
			clock: {now: () => { if (fail) throw new Error('clock failed'); return 0 }},
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 10,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 1
			}
		})
		const admission = bounded.canAttempt(resource, scope, id)
		fail = true
		expect(() => bounded.recordFailure(
			resource, scope, id, admission.state, admission.generation, admission.admission
		)).not.toThrow()
		fail = false

		expect(bounded.peek(resource, scope, id)).toMatchObject({
			state: 'OPEN',
			lastTransitionTime: Number.MAX_SAFE_INTEGER
		})
		expect(bounded.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
	})

	it('should open after failure threshold', () => {

		// Record failures up to threshold
		for (let i = 0; i < 5; i++) {
			breaker.recordFailure(resource, scope, id)
		}

		const result = breaker.canAttempt(resource, scope, id)
		expect(result.allowed).toBe(false)
		expect(result.state).toBe('OPEN')

	})

	it('does not open on successful traffic when the failure ratio threshold is zero', () => {
		const zeroRatioBreaker = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 0,
				failureCountThreshold: 2,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 1
			}
		})

		zeroRatioBreaker.recordSuccess(resource, scope, id)
		zeroRatioBreaker.recordSuccess(resource, scope, id)
		const admitted = zeroRatioBreaker.canAttempt(resource, scope, id)
		expect(admitted).toMatchObject({
			allowed: true,
			state: 'CLOSED'
		})

		zeroRatioBreaker.recordFailure(
			resource, scope, id, admitted.state, admitted.generation, admitted.admission
		)
		expect(zeroRatioBreaker.canAttempt(resource, scope, id)).toMatchObject({
			allowed: false,
			state: 'OPEN'
		})
	})

	it('should transition to HALF_OPEN after timeout', () => {

		// Open the breaker
		for (let i = 0; i < 5; i++) {
			breaker.recordFailure(resource, scope, id)
		}

		let result = breaker.canAttempt(resource, scope, id)
		expect(result.state).toBe('OPEN')

		// Transition to HALF_OPEN
		clock.set(clock.now() + 31000)

		// Check state (should transition to HALF_OPEN on next canAttempt call)
		result = breaker.canAttempt(resource, scope, id)
		expect(result.state).toBe('HALF_OPEN')

	})

	it('should close after successful attempts in HALF_OPEN', () => {

		// Open the breaker
		for (let i = 0; i < 5; i++) {
			breaker.recordFailure(resource, scope, id)
		}

		expect(breaker.canAttempt(resource, scope, id).state).toBe('OPEN')

		// Transition to HALF_OPEN
		clock.advanceBy(31000)
		const probes = [
			breaker.canAttempt(resource, scope, id),
			breaker.canAttempt(resource, scope, id),
			breaker.canAttempt(resource, scope, id)
		]

		// Record successes
		for (const probe of probes) {
			breaker.recordSuccess(resource, scope, id, probe.state, probe.generation, probe.admission)
		}

		const result = breaker.canAttempt(resource, scope, id)
		expect(result.state).toBe('CLOSED')
		expect(result.allowed).toBe(true)

	})

	it('should destroy and clean up resources', () => {

		breaker.destroy()
		// Should not throw
		expect(() => breaker.destroy()).not.toThrow()

	})

	it('reopens immediately when a HALF_OPEN attempt fails', () => {
		for (let i = 0; i < 5; i++) {
			breaker.recordFailure(resource, scope, id)
		}

		expect(breaker.canAttempt(resource, scope, id).state).toBe('OPEN')
		clock.advanceBy(31000)
		const probe = breaker.canAttempt(resource, scope, id)
		expect(probe.state).toBe('HALF_OPEN')

		breaker.recordFailure(resource, scope, id, probe.state, probe.generation, probe.admission)

		const result = breaker.canAttempt(resource, scope, id)
		expect(result.state).toBe('OPEN')
		expect(result.allowed).toBe(false)
	})

	it('supports inspect and reset for operability', () => {
		for (let i = 0; i < 2; i++) {
			breaker.recordFailure(resource, scope, id)
		}
		breaker.recordSuccess(resource, scope, id)

		const inspection = breaker.inspect(resource, scope, id)
		expect(inspection.failures).toBe(2)
		expect(inspection.successes).toBe(1)
		expect(inspection.state).toBe('CLOSED')

		breaker.reset(resource, scope, id)

		const resetInspection = breaker.inspect(resource, scope, id)
		expect(resetInspection.failures).toBe(0)
		expect(resetInspection.successes).toBe(0)
		expect(resetInspection.state).toBe('CLOSED')
	})

	it('expires closed-window samples before evaluating the next decision', () => {
		breaker.recordFailure(resource, scope, id)
		breaker.recordSuccess(resource, scope, id)
		clock.advanceBy(60_001)

		expect(breaker.inspect(resource, scope, id)).toMatchObject({
			state: 'CLOSED', failures: 0, successes: 0, windowStart: clock.now()
		})
	})

	it('validates config edges and handles half-open attempt exhaustion', () => {

		expect(() => createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 2,
				failureCountThreshold: 1,
				timeWindow: 1000,
				halfOpenTimeout: 1000,
				halfOpenMaxAttempts: 1
			}
		})).toThrow(/failureRatioThreshold/i)

		expect(() => createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 0,
				timeWindow: 1000,
				halfOpenTimeout: 1000,
				halfOpenMaxAttempts: 1
			}
		})).toThrow(/failureCountThreshold/i)

		expect(() => createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 1,
				timeWindow: 0,
				halfOpenTimeout: 1000,
				halfOpenMaxAttempts: 1
			}
		})).toThrow(/timeWindow/i)

		expect(() => createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 1,
				timeWindow: 1000,
				halfOpenTimeout: 0,
				halfOpenMaxAttempts: 1
			}
		})).toThrow(/halfOpenTimeout/i)

		expect(() => createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 1,
				timeWindow: 1000,
				halfOpenTimeout: 1000,
				halfOpenMaxAttempts: 0
			}
		})).toThrow(/halfOpenMaxAttempts/i)

		expect(() => createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 1,
				timeWindow: 1000,
				halfOpenTimeout: 1000,
				halfOpenMaxAttempts: 2,
				halfOpenSuccessThreshold: 3
			}
		})).toThrow(/halfOpenSuccessThreshold/i)

		const strictBreaker = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 2,
				timeWindow: 1000,
				halfOpenTimeout: 100,
				halfOpenMaxAttempts: 1,
				halfOpenSuccessThreshold: 1
			}
		})

		strictBreaker.recordSuccess(resource, scope, id)
		expect(strictBreaker.getState(resource, scope, id)).toBe('CLOSED')
		expect(strictBreaker.peek(resource, scope, id).state).toBe('CLOSED')

		strictBreaker.recordFailure(resource, scope, id)
		strictBreaker.recordFailure(resource, scope, id)
		expect(strictBreaker.canAttempt(resource, scope, id)).toMatchObject({
			allowed: false,
			state: 'OPEN',
			resource
		})

		clock.advanceBy(150)
		expect(strictBreaker.canAttempt(resource, scope, id)).toMatchObject({
			allowed: true,
			state: 'HALF_OPEN',
			resource
		})
		expect(strictBreaker.canAttempt(resource, scope, id)).toMatchObject({
			allowed: false,
			state: 'HALF_OPEN',
			resource
		})
	})

	it('lets admitted half-open probes recover after probe capacity is saturated', () => {
		for (let i = 0; i < 5; i++) breaker.recordFailure(resource, scope, id)
		expect(breaker.canAttempt(resource, scope, id).state).toBe('OPEN')
		clock.advanceBy(30_001)
		const probes = [
			breaker.canAttempt(resource, scope, id),
			breaker.canAttempt(resource, scope, id),
			breaker.canAttempt(resource, scope, id)
		]
		expect(probes.every((probe) => probe.allowed && probe.state === 'HALF_OPEN')).toBe(true)

		expect(breaker.canAttempt(resource, scope, id)).toMatchObject({
			allowed: false,
			state: 'HALF_OPEN',
			generation: probes[0]?.generation
		})

		for (const probe of probes) {
			breaker.recordSuccess(resource, scope, id, probe.state, probe.generation, probe.admission)
		}
		expect(breaker.canAttempt(resource, scope, id)).toMatchObject({allowed: true, state: 'CLOSED'})
	})

	it('does not close while an admitted probe from the recovery generation is unresolved', () => {
		const recovery = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 2,
				halfOpenSuccessThreshold: 1
			}
		})
		const closed = recovery.canAttempt(resource, scope, id)
		recovery.recordFailure(resource, scope, id, closed.state, closed.generation, closed.admission)
		expect(recovery.canAttempt(resource, scope, id).state).toBe('OPEN')
		clock.advanceBy(10)
		const successfulProbe = recovery.canAttempt(resource, scope, id)
		const failingProbe = recovery.canAttempt(resource, scope, id)
		recovery.recordSuccess(
			resource, scope, id, successfulProbe.state, successfulProbe.generation, successfulProbe.admission
		)

		expect(recovery.canAttempt(resource, scope, id)).toMatchObject({
			allowed: false,
			state: 'HALF_OPEN'
		})
		recovery.recordFailure(
			resource, scope, id, failingProbe.state, failingProbe.generation, failingProbe.admission
		)
		expect(recovery.peek(resource, scope, id).state).toBe('OPEN')
	})

	it('keeps a reentrant recovery probe authoritative during OPEN to HALF_OPEN transition', () => {
		let now = 0
		let reenter = false
		let nested!: ReturnType<ReturnType<typeof createCircuitBreakerEngine>['canAttempt']>
		let recovery!: ReturnType<typeof createCircuitBreakerEngine>
		recovery = createCircuitBreakerEngine({
			clock: {now: () => {
				if (reenter) {
					reenter = false
					nested = recovery.canAttempt(resource, scope, id)
				}
				return now
			}},
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 1
			}
		})
		const closed = recovery.canAttempt(resource, scope, id)
		recovery.recordFailure(resource, scope, id, closed.state, closed.generation, closed.admission)
		expect(recovery.canAttempt(resource, scope, id).state).toBe('OPEN')
		now = 10
		reenter = true

		expect(recovery.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'HALF_OPEN'})
		expect(nested).toMatchObject({allowed: true, state: 'HALF_OPEN'})
		recovery.recordSuccess(resource, scope, id, nested.state, nested.generation, nested.admission)
		expect(recovery.canAttempt(resource, scope, id)).toMatchObject({allowed: true, state: 'CLOSED'})
	})

	it('publishes a half-open failure before reading its transition timestamp', () => {
		let now = 0
		let reenter = false
		let nested!: ReturnType<ReturnType<typeof createCircuitBreakerEngine>['canAttempt']>
		let recovery!: ReturnType<typeof createCircuitBreakerEngine>
		recovery = createCircuitBreakerEngine({
			clock: {now: () => {
				if (reenter) {
					reenter = false
					nested = recovery.canAttempt(resource, scope, id)
				}
				return now
			}},
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 2
			}
		})
		const closed = recovery.canAttempt(resource, scope, id)
		recovery.recordFailure(resource, scope, id, closed.state, closed.generation, closed.admission)
		expect(recovery.canAttempt(resource, scope, id).state).toBe('OPEN')
		now = 10
		const probe = recovery.canAttempt(resource, scope, id)
		reenter = true
		recovery.recordFailure(resource, scope, id, probe.state, probe.generation, probe.admission)

		expect(nested).toMatchObject({allowed: false, state: 'OPEN'})
		expect(recovery.peek(resource, scope, id).state).toBe('OPEN')
	})

	it('does not invalidate an admission published during the closing timestamp callback', () => {
		let now = 0
		let reenter = false
		let nested!: ReturnType<ReturnType<typeof createCircuitBreakerEngine>['canAttempt']>
		let recovery!: ReturnType<typeof createCircuitBreakerEngine>
		recovery = createCircuitBreakerEngine({
			clock: {now: () => {
				if (reenter) {
					reenter = false
					nested = recovery.canAttempt(resource, scope, id)
				}
				return now
			}},
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 1
			}
		})
		const closed = recovery.canAttempt(resource, scope, id)
		recovery.recordFailure(resource, scope, id, closed.state, closed.generation, closed.admission)
		expect(recovery.canAttempt(resource, scope, id).state).toBe('OPEN')
		now = 10
		const probe = recovery.canAttempt(resource, scope, id)
		recovery.recordSuccess(resource, scope, id, probe.state, probe.generation, probe.admission)
		reenter = true
		const outer = recovery.canAttempt(resource, scope, id)
		expect(nested).toMatchObject({allowed: true, state: 'CLOSED'})
		recovery.recordFailure(resource, scope, id, nested.state, nested.generation, nested.admission)
		recovery.recordCancellation(resource, scope, id, outer.state, outer.generation, outer.admission)

		expect(recovery.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
	})

	it('does not move an open breaker toward half-open when the wall clock moves backward', () => {
		for (let i = 0; i < 5; i++) {
			breaker.recordFailure(resource, scope, id)
		}
		expect(breaker.canAttempt(resource, scope, id).state).toBe('OPEN')

		clock.set(0)
		expect(breaker.canAttempt(resource, scope, id)).toMatchObject({
			allowed: false,
			state: 'OPEN'
		})
	})

	it('releases a cancelled half-open probe without exhausting probe capacity', () => {
		for (let i = 0; i < 5; i++) breaker.recordFailure(resource, scope, id)
		expect(breaker.canAttempt(resource, scope, id).allowed).toBe(false)
		clock.advanceBy(30_001)
		const probe = breaker.canAttempt(resource, scope, id)
		expect(probe).toMatchObject({allowed: true, state: 'HALF_OPEN'})
		expect(breaker.peek(resource, scope, id).halfOpenAttempts).toBe(1)

		breaker.recordCancellation(resource, scope, id, probe.state, probe.generation, probe.admission)
		expect(breaker.peek(resource, scope, id).halfOpenAttempts).toBe(0)
		expect(breaker.canAttempt(resource, scope, id)).toMatchObject({allowed: true, state: 'HALF_OPEN'})
	})

	it('retains half-open successes across the closed-state failure window', () => {
		const recovery = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 10,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 2,
				halfOpenSuccessThreshold: 2
			}
		})
		recovery.recordFailure(resource, scope, id)
		expect(recovery.canAttempt(resource, scope, id).state).toBe('OPEN')
		clock.advanceBy(10)

		const first = recovery.canAttempt(resource, scope, id)
		expect(first.state).toBe('HALF_OPEN')
		recovery.recordSuccess(resource, scope, id, first.state, first.generation, first.admission)
		clock.advanceBy(11)
		const second = recovery.canAttempt(resource, scope, id)
		recovery.recordSuccess(resource, scope, id, second.state, second.generation, second.admission)

		expect(recovery.inspect(resource, scope, id)).toMatchObject({
			state: 'CLOSED', failures: 0, successes: 0, halfOpenAttempts: 0
		})
	})

	it('counts each admitted half-open probe at most once', () => {
		const oneShot = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 10,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 2,
				halfOpenSuccessThreshold: 2
			}
		})
		oneShot.recordFailure(resource, scope, id)
		expect(oneShot.canAttempt(resource, scope, id).state).toBe('OPEN')
		clock.advanceBy(10)

		const first = oneShot.canAttempt(resource, scope, id)
		oneShot.recordSuccess(resource, scope, id, first.state, first.generation, first.admission)
		oneShot.recordSuccess(resource, scope, id, first.state, first.generation, first.admission)
		expect(oneShot.inspect(resource, scope, id)).toMatchObject({state: 'HALF_OPEN', successes: 1})

		const second = oneShot.canAttempt(resource, scope, id)
		oneShot.recordSuccess(resource, scope, id, second.state, second.generation, second.admission)
		expect(oneShot.inspect(resource, scope, id)).toMatchObject({state: 'CLOSED', successes: 0})
	})

	it('does not recreate reset state from a late admitted completion', () => {
		const admitted = breaker.canAttempt(resource, scope, id)
		breaker.reset(resource, scope, id)

		breaker.recordFailure(resource, scope, id, admitted.state, admitted.generation, admitted.admission)

		expect(breaker.peek(resource, scope, id)).toMatchObject({state: 'CLOSED', failures: 0})
	})

	it('ignores late probe completions from a previous breaker state', () => {
		for (let i = 0; i < 5; i++) breaker.recordFailure(resource, scope, id)
		expect(breaker.canAttempt(resource, scope, id).allowed).toBe(false)
		clock.advanceBy(30_001)
		const probes = [
			breaker.canAttempt(resource, scope, id),
			breaker.canAttempt(resource, scope, id),
			breaker.canAttempt(resource, scope, id)
		]
		expect(probes.every((probe) => probe.state === 'HALF_OPEN')).toBe(true)

		for (const probe of probes) {
			breaker.recordSuccess(resource, scope, id, probe.state, probe.generation, probe.admission)
		}
		expect(breaker.inspect(resource, scope, id).state).toBe('CLOSED')

		breaker.recordFailure(resource, scope, id, 'HALF_OPEN')
		expect(breaker.inspect(resource, scope, id)).toMatchObject({state: 'CLOSED', failures: 0})
	})

	it('ignores late half-open completions from an earlier half-open generation', () => {
		for (let i = 0; i < 5; i++) breaker.recordFailure(resource, scope, id)
		expect(breaker.canAttempt(resource, scope, id).state).toBe('OPEN')
		clock.advanceBy(30_001)
		const oldProbe = breaker.canAttempt(resource, scope, id)
		expect(oldProbe.state).toBe('HALF_OPEN')

		breaker.recordFailure(resource, scope, id, oldProbe.state, oldProbe.generation, oldProbe.admission)
		expect(breaker.inspect(resource, scope, id).state).toBe('OPEN')
		clock.advanceBy(30_001)
		const newProbe = breaker.canAttempt(resource, scope, id)
		expect(newProbe.state).toBe('HALF_OPEN')
		expect(newProbe.generation).not.toBe(oldProbe.generation)

		breaker.recordSuccess(resource, scope, id, oldProbe.state, oldProbe.generation, oldProbe.admission)
		expect(breaker.inspect(resource, scope, id)).toMatchObject({
			state: 'HALF_OPEN',
			successes: 0
		})
	})

	it('keeps hot breaker state recent when bounded state evicts cold keys', () => {
		breaker.recordFailure(resource, scope, id)
		for (let index = 0; index < 9_999; index++) {
			breaker.recordSuccess(`cold-${index}`, scope, id)
		}
		expect(breaker.canAttempt(resource, scope, id)).toMatchObject({allowed: true, state: 'CLOSED'})
		breaker.recordSuccess('overflow', scope, id)

		expect(breaker.peek(resource, scope, id).failures).toBe(1)
	})

	it('keeps OPEN protection at capacity after the half-open deadline', () => {
		const bounded = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 1
			},
			maxStateKeys: 2
		})

		for (const protectedResource of ['protected-a', 'protected-b']) {
			bounded.recordFailure(protectedResource, scope, id)
			expect(bounded.canAttempt(protectedResource, scope, id).state).toBe('OPEN')
		}

		expect(bounded.canAttempt('attacker-overflow', scope, id)).toMatchObject({
			allowed: false,
			state: 'OPEN'
		})
		expect(bounded.getState('attacker-overflow', scope, id)).toBe('OPEN')
		expect(bounded.peek('attacker-overflow', scope, id)).toMatchObject({state: 'OPEN', generation: -1})
		expect(bounded.inspect('attacker-overflow', scope, id)).toMatchObject({state: 'OPEN', generation: -1})
		expect(bounded.canAttempt('protected-a', scope, id)).toMatchObject({
			allowed: false,
			state: 'OPEN'
		})
		clock.advanceBy(30_000)
		expect(bounded.canAttempt('after-protection', scope, id)).toMatchObject({
			allowed: false,
			state: 'OPEN'
		})
		expect(bounded.canAttempt('protected-a', scope, id)).toMatchObject({
			allowed: true,
			state: 'HALF_OPEN'
		})
	})

	it('does not evict partial HALF_OPEN recovery evidence at capacity', () => {
		const bounded = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 2,
				halfOpenSuccessThreshold: 2
			},
			maxStateKeys: 1
		})
		bounded.recordFailure('protected', scope, id)
		expect(bounded.canAttempt('protected', scope, id).state).toBe('OPEN')
		clock.advanceBy(30_000)
		const firstProbe = bounded.canAttempt('protected', scope, id)
		expect(firstProbe).toMatchObject({allowed: true, state: 'HALF_OPEN'})
		bounded.recordSuccess(
			'protected', scope, id, firstProbe.state, firstProbe.generation, firstProbe.admission
		)

		expect(bounded.canAttempt('replacement', scope, id)).toMatchObject({
			allowed: false,
			state: 'OPEN'
		})
		expect(bounded.peek('protected', scope, id)).toMatchObject({
			state: 'HALF_OPEN',
			successes: 1
		})
	})

	it('does not evict a CLOSED entry while an admitted completion is still authoritative', () => {
		const bounded = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 2,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 1
			},
			maxStateKeys: 1
		})
		const oldAdmission = bounded.canAttempt('old', scope, id)

		expect(bounded.canAttempt('replacement', scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
		bounded.recordFailure(
			'old', scope, id, oldAdmission.state, oldAdmission.generation, oldAdmission.admission
		)
		expect(bounded.peek('old', scope, id).failures).toBe(1)

		// Completion releases active ownership, but the failure remains authoritative
		// until its CLOSED accounting window expires.
		expect(bounded.canAttempt('replacement', scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
		clock.advanceBy(60_000)
		expect(bounded.canAttempt('replacement', scope, id)).toMatchObject({allowed: true, state: 'CLOSED'})
	})

	it('bounds outstanding CLOSED admissions and returns capacity on completion or reset', () => {
		const bounded = createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 1
			},
			maxStateKeys: 2
		})
		const admissions = Array.from(
			{length: 10_000},
			() => bounded.canAttempt('bounded', scope, id)
		)
		expect(admissions.every((admission) => admission.allowed)).toBe(true)
		expect(bounded.canAttempt('overflow', scope, id)).toMatchObject({
			allowed: false,
			state: 'CLOSED'
		})

		const released = admissions[0]!
		bounded.recordCancellation(
			'bounded', scope, id, released.state, released.generation, released.admission
		)
		expect(bounded.canAttempt('overflow', scope, id).allowed).toBe(true)

		bounded.reset('bounded', scope, id)
		expect(bounded.canAttempt('after-reset', scope, id).allowed).toBe(true)
	})

	it('validates the circuit-breaker state bound', () => {
		expect(() => createCircuitBreakerEngine({
			clock,
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 1
			},
			maxStateKeys: 0
		})).toThrow(/maxStateKeys/i)
	})

	it('does not recreate state when late work reports after destroy', () => {
		breaker.recordFailure(resource, scope, id)
		breaker.destroy()

		breaker.recordFailure(resource, scope, id)
		breaker.recordSuccess(resource, scope, id)

		expect(breaker.inspect(resource, scope, id)).toMatchObject({
			state: 'OPEN',
			failures: 0,
			successes: 0
		})
		expect(breaker.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
	})

	it('does not publish an admission when the clock reentrantly destroys the engine', () => {
		let engine!: ReturnType<typeof createCircuitBreakerEngine>
		let destroyed = false
		engine = createCircuitBreakerEngine({
			clock: {now: () => {
				if (!destroyed) { destroyed = true; engine.destroy() }
				return 0
			}},
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 5,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 3
			}
		})

		expect(engine.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
		expect(engine.peek(resource, scope, id)).toMatchObject({state: 'OPEN', generation: -1})

		let inspectionEngine!: ReturnType<typeof createCircuitBreakerEngine>
		inspectionEngine = createCircuitBreakerEngine({
			clock: {now: () => { inspectionEngine.destroy(); return 0 }},
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 5,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 3
			}
		})
		expect(inspectionEngine.getState(resource, scope, id)).toBe('OPEN')
	})

	it('does not issue an admission from an entry detached by reentrant reset', () => {
		let resetOnRead = false
		let engine!: ReturnType<typeof createCircuitBreakerEngine>
		engine = createCircuitBreakerEngine({
			clock: {now: () => {
				if (resetOnRead) { resetOnRead = false; engine.reset(resource, scope, id) }
				return 0
			}},
			config: {
				failureRatioThreshold: 0.5,
				failureCountThreshold: 5,
				timeWindow: 60_000,
				halfOpenTimeout: 30_000,
				halfOpenMaxAttempts: 3
			}
		})
		const initial = engine.canAttempt(resource, scope, id)
		engine.recordCancellation(resource, scope, id, initial.state, initial.generation, initial.admission)

		resetOnRead = true
		expect(engine.canAttempt(resource, scope, id)).toMatchObject({allowed: false, state: 'OPEN', generation: -1})
		expect(engine.canAttempt(resource, scope, id)).toMatchObject({allowed: true, state: 'CLOSED'})
	})

	it('does not evict replacement state published by a reentrant reclaim clock', () => {
		let now = 0
		let reenter = false
		let nested!: ReturnType<ReturnType<typeof createCircuitBreakerEngine>['canAttempt']>
		let engine!: ReturnType<typeof createCircuitBreakerEngine>
		engine = createCircuitBreakerEngine({
			clock: {now: () => {
				if (reenter) {
					reenter = false
					engine.reset('protected', scope, id)
					nested = engine.canAttempt('protected', scope, id)
				}
				return now
			}},
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 10,
				timeWindow: 10,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 1
			},
			maxStateKeys: 1
		})
		const initial = engine.canAttempt('protected', scope, id)
		engine.recordFailure('protected', scope, id, initial.state, initial.generation, initial.admission)
		now = 10
		reenter = true

		expect(engine.canAttempt('attacker', scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
		expect(nested).toMatchObject({allowed: true, state: 'CLOSED'})
		expect(engine.peek('protected', scope, id).generation).toBe(nested.generation)
	})

	it('rechecks store capacity after a reentrant entry-creation clock', () => {
		let reenter = true
		let nested!: ReturnType<ReturnType<typeof createCircuitBreakerEngine>['canAttempt']>
		let engine!: ReturnType<typeof createCircuitBreakerEngine>
		engine = createCircuitBreakerEngine({
			clock: {now: () => {
				if (reenter) {
					reenter = false
					nested = engine.canAttempt('nested', scope, id)
				}
				return 0
			}},
			config: {
				failureRatioThreshold: 1,
				failureCountThreshold: 1,
				timeWindow: 10,
				halfOpenTimeout: 10,
				halfOpenMaxAttempts: 1
			},
			maxStateKeys: 1
		})

		expect(engine.canAttempt('outer', scope, id)).toMatchObject({allowed: false, state: 'OPEN'})
		expect(nested).toMatchObject({allowed: true, state: 'CLOSED'})
		expect(engine.peek('nested', scope, id).generation).toBe(nested.generation)
	})

})
