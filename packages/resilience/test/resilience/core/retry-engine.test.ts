/**
 * @file Tests for retry engine (L1 pure logic).
 */

import type {RetryPolicy} from '@ooopsstudio/core/contracts/resilience'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createRetryEngine} from '../../../src/resilience/core/retry-engine'

describe('retry-engine', () => {

	let clock: ReturnType<typeof createFixedClock>
	let retryEngine: ReturnType<typeof createRetryEngine>
	let policy: RetryPolicy

	beforeEach(() => {

		clock = createFixedClock(1000)
		policy = {
			maxAttempts: 3,
			initialDelay: 100,
			maxDelay: 1000,
			backoff: 'exponential',
			backoffMultiplier: 2,
			maxTotalTime: 5000,
			maxCpuConsumption: 10000
		}
		retryEngine = createRetryEngine({
			clock,
			policy
		})

	})

	it('should allow retry on first attempt', () => {

		const error = new Error('test error')
		const decision = retryEngine.shouldRetry(error)

		expect(decision.attempt).toBe(1)
		expect(decision.shouldRetry).toBe(true)
		expect(decision.delay).toBeGreaterThanOrEqual(0)
		expect(decision.cpuConsumed).toBeGreaterThanOrEqual(0)

	})

	it('does not admit a retry after its backoff consumes the total-time budget', () => {
		const bounded = createRetryEngine({
			clock,
			policy: {...policy, initialDelay: 50, maxDelay: 50, maxTotalTime: 50, jitter: 'none'}
		})
		const decision = bounded.shouldRetry(new Error('retryable'))
		expect(decision).toMatchObject({shouldRetry: false, delay: 0})

		clock.advanceBy(50)
		expect(bounded.canRetryNow()).toBe(false)
	})

	it('rejects non-finite retry limits before an unbounded retry loop can start', () => {

		expect(() => createRetryEngine({
			clock,
			policy: {...policy, maxAttempts: Number.NaN}
		})).toThrow(/maxAttempts/i)
		expect(() => createRetryEngine({
			clock,
			policy: {...policy, backoffMultiplier: Number.NaN}
		})).toThrow(/backoffMultiplier/i)
		expect(() => createRetryEngine({
			clock,
			policy: {...policy, maxDelay: 2_147_483_648}
		})).toThrow(/2147483647/i)
		expect(() => createRetryEngine({
			clock,
			policy: {...policy, initialDelay: 101, maxDelay: 100}
		})).toThrow(/maxDelay must be >= initialDelay/i)
		expect(() => createRetryEngine({
			clock,
			policy: {...policy, backoff: 'invalid' as never}
		})).toThrow(/backoff/i)
		expect(() => createRetryEngine({
			clock,
			policy: {...policy, jitter: 'invalid' as never}
		})).toThrow(/jitter/i)
		expect(() => createRetryEngine({
			clock,
			policy: {...policy, errorClassifier: 'retry' as never}
		})).toThrow(/errorClassifier must be a function/i)
	})

	it('should allow retry on subsequent attempts', () => {

		const error = new Error('test error')

		// First attempt
		const decision1 = retryEngine.shouldRetry(error)
		expect(decision1.attempt).toBe(1)
		expect(decision1.shouldRetry).toBe(true)

		// Record CPU consumption and advance clock
		retryEngine.recordCpuConsumption(10)
		clock.advanceBy(decision1.delay)

		// Second attempt
		const decision2 = retryEngine.shouldRetry(error)
		expect(decision2.attempt).toBe(2)
		expect(decision2.shouldRetry).toBe(true)

	})

	it('should exhaust retries after maxAttempts', () => {

		const error = new Error('test error')

		// First attempt
		const decision1 = retryEngine.shouldRetry(error)
		expect(decision1.attempt).toBe(1)
		expect(decision1.shouldRetry).toBe(true)

		// Second attempt
		retryEngine.recordCpuConsumption(10)
		clock.advanceBy(decision1.delay)
		const decision2 = retryEngine.shouldRetry(error)
		expect(decision2.attempt).toBe(2)
		expect(decision2.shouldRetry).toBe(true)

		// The third failed physical attempt exhausts maxAttempts = 3.
		retryEngine.recordCpuConsumption(10)
		clock.advanceBy(decision2.delay)
		const decision3 = retryEngine.shouldRetry(error)
		expect(decision3.attempt).toBe(3)
		expect(decision3.shouldRetry).toBe(false)
		expect(retryEngine.canRetryNow()).toBe(false)

	})

	it('never retries when maxAttempts allows only the initial physical attempt', () => {
		const singleAttempt = createRetryEngine({clock, policy: {...policy, maxAttempts: 1}})
		expect(singleAttempt.shouldRetry(new Error('failed once'))).toMatchObject({
			attempt: 1,
			shouldRetry: false,
			delay: 0
		})
		expect(singleAttempt.canRetryNow()).toBe(false)
	})

	it('snapshots policy limits so later mutation cannot extend retries', () => {
		const mutablePolicy: RetryPolicy = {...policy, maxAttempts: 2}
		const bounded = createRetryEngine({clock, policy: mutablePolicy})
		;(mutablePolicy as {maxAttempts: number}).maxAttempts = 100

		expect(bounded.shouldRetry(new Error('first failure')).shouldRetry).toBe(true)
		expect(bounded.shouldRetry(new Error('second failure'))).toMatchObject({attempt: 2, shouldRetry: false})
	})

	it('captures the clock method so later capability rewiring cannot expire retries', () => {
		const mutableClock = {now: () => 0}
		const bounded = createRetryEngine({clock: mutableClock, policy})
		mutableClock.now = () => policy.maxTotalTime + 1

		expect(bounded.shouldRetry(new Error('retryable')).shouldRetry).toBe(true)
	})

	it('rejects accessor-backed policy fields without invoking them', () => {
		const getter = vi.fn(() => 3)
		const hostile = {...policy} as Record<string, unknown>
		Object.defineProperty(hostile, 'maxAttempts', {enumerable: true, get: getter})

		expect(() => createRetryEngine({clock, policy: hostile as unknown as RetryPolicy})).toThrow(/plain data object/u)
		expect(getter).not.toHaveBeenCalled()
	})

	it('should respect maxCpuConsumption limit', () => {

		const error = new Error('test error')
		const lowCpuPolicy: RetryPolicy = {
			maxAttempts: 10,
			initialDelay: 100,
			maxDelay: 1000,
			backoff: 'exponential',
			backoffMultiplier: 2,
			maxTotalTime: 50000,
			maxCpuConsumption: 100 // Very low limit
		}
		const lowCpuEngine = createRetryEngine({
			clock,
			policy: lowCpuPolicy
		})

		// First attempt
		const decision1 = lowCpuEngine.shouldRetry(error)
		expect(decision1.shouldRetry).toBe(true)

		// Record high CPU consumption
		lowCpuEngine.recordCpuConsumption(150) // Exceeds limit

		// Second attempt should fail due to CPU limit
		clock.advanceBy(decision1.delay)
		const decision2 = lowCpuEngine.shouldRetry(error)
		expect(decision2.shouldRetry).toBe(false)

	})

	it('should reset state correctly', () => {

		const error = new Error('test error')

		// First attempt
		const decision1 = retryEngine.shouldRetry(error)
		expect(decision1.attempt).toBe(1)

		// Record CPU consumption
		retryEngine.recordCpuConsumption(10)

		// Reset
		retryEngine.reset()

		// After reset, should start from attempt 1 again
		const decision2 = retryEngine.shouldRetry(error)
		expect(decision2.attempt).toBe(1)
		expect(decision2.cpuConsumed).toBe(0)

	})

	it('fails closed when clock, classifier, or jitter reentrantly resets a decision', () => {
		let clockEngine!: ReturnType<typeof createRetryEngine>
		let resetFromClock = false
		clockEngine = createRetryEngine({
			clock: {now: () => {
				if (resetFromClock) { resetFromClock = false; clockEngine.reset() }
				return 1_000
			}},
			policy
		})
		resetFromClock = true
		expect(clockEngine.shouldRetry(new Error('clock reset'))).toMatchObject({attempt: 0, shouldRetry: false, delay: 0})
		expect(clockEngine.shouldRetry(new Error('after reset'))).toMatchObject({attempt: 1, shouldRetry: true})

		let classifierEngine!: ReturnType<typeof createRetryEngine>
		let resetFromClassifier = true
		classifierEngine = createRetryEngine({
			clock,
			policy: {...policy, errorClassifier: () => {
				if (resetFromClassifier) { resetFromClassifier = false; classifierEngine.reset() }
				return {isRetryable: true, category: 'transient'}
			}}
		})
		expect(classifierEngine.shouldRetry(new Error('classifier reset'))).toMatchObject({attempt: 0, shouldRetry: false})

		let jitterEngine!: ReturnType<typeof createRetryEngine>
		let resetFromJitter = true
		jitterEngine = createRetryEngine({
			clock,
			policy,
			random: () => {
				if (resetFromJitter) { resetFromJitter = false; jitterEngine.reset() }
				return 0.5
			}
		})
		expect(jitterEngine.shouldRetry(new Error('jitter reset'))).toMatchObject({attempt: 0, shouldRetry: false})
	})

	it('uses full jitter by default for exponential backoff when random is stubbed', () => {
		const jitteredEngine = createRetryEngine({
			clock,
			policy,
			random: () => 0.5
		})

		const decision = jitteredEngine.shouldRetry(new Error('network timeout'))

		expect(decision.delay).toBe(50)
		expect(decision.shouldRetry).toBe(true)
	})

	it('keeps fixed backoff deterministic unless jitter is explicitly enabled', () => {
		const fixedPolicy: RetryPolicy = {
			...policy,
			backoff: 'fixed',
			initialDelay: 200,
			maxDelay: 200
		}
		const fixedEngine = createRetryEngine({
			clock,
			policy: fixedPolicy,
			random: () => 0.1
		})

		const decision = fixedEngine.shouldRetry(new Error('network timeout'))

		expect(decision.delay).toBe(200)
	})

	it('covers validation, elapsed-time exhaustion, classifiers, and linear backoff branches', () => {
		expect(() => createRetryEngine({
			clock,
			policy: {
				...policy,
				maxAttempts: 0
			}
		})).toThrow(/maxAttempts/i)
		expect(() => createRetryEngine({
			clock,
			policy: {
				...policy,
				maxTotalTime: 0
			}
		})).toThrow(/maxTotalTime/i)
		expect(() => createRetryEngine({
			clock,
			policy: {
				...policy,
				initialDelay: -1
			}
		})).toThrow(/initialDelay/i)
		expect(() => createRetryEngine({
			clock,
			policy: {
				...policy,
				maxDelay: -1
			}
		})).toThrow(/maxDelay/i)
		expect(() => createRetryEngine({
			clock,
			policy: {
				...policy,
				maxCpuConsumption: 0
			}
		})).toThrow(/maxCpuConsumption/i)

		const linearEngine = createRetryEngine({
			clock,
			policy: {
				...policy,
				backoff: 'linear',
				initialDelay: 150,
				jitter: 'none'
			}
		})
		expect(linearEngine.shouldRetry(new Error('linear')).delay).toBe(150)

		const classifierEngine = createRetryEngine({
			clock,
			policy: {
				...policy,
				errorClassifier: (error) => {
					if (String(error).includes('retryable')) {
						return {
							isRetryable: true,
							category: 'NETWORK',
							delay: 321
						}
					}
					return {
						isRetryable: false,
						category: 'UNKNOWN'
					}
				}
			}
		})
		expect(classifierEngine.shouldRetry('retryable').delay).toBe(321)
		expect(classifierEngine.shouldRetry('permanent').shouldRetry).toBe(false)

		const shortWindowClock = createFixedClock(100)
		const shortWindowEngine = createRetryEngine({
			clock: shortWindowClock,
			policy: {
				...policy,
				maxTotalTime: 50
			}
		})
		shortWindowClock.advanceBy(60)
		expect(shortWindowEngine.shouldRetry(new Error('late')).shouldRetry).toBe(false)

		expect(() => retryEngine.recordCpuConsumption(-1)).toThrow(/consumed must be finite and >= 0/i)
	})

	it('does not treat a backward wall-clock jump as negative elapsed retry time', () => {
		const rollbackClock = createFixedClock(1_000)
		const engine = createRetryEngine({
			clock: rollbackClock,
			policy: {...policy, jitter: 'none'}
		})

		rollbackClock.set(100)
		expect(engine.shouldRetry(new Error('rollback'))).toMatchObject({
			shouldRetry: true,
			delay: 100
		})
	})

	it('fails safe for invalid classifier delays and random values', () => {

		const invalidClassifier = createRetryEngine({
			clock,
			policy: {
				...policy,
				errorClassifier: () => ({isRetryable: true, category: 'NETWORK', delay: Number.NaN})
			}
		})
		expect(invalidClassifier.shouldRetry(new Error('retry')).shouldRetry).toBe(false)

		const invalidRandom = createRetryEngine({
			clock,
			policy,
			random: () => Number.NaN
		})
		expect(invalidRandom.shouldRetry(new Error('retry')).delay).toBe(0)
		expect(() => retryEngine.recordCpuConsumption(Number.NaN)).toThrow(/finite/i)

	})

	it('fails closed when caller-provided classifiers or jitter sources throw', () => {

		const throwingClassifier = createRetryEngine({
			clock,
			policy: {...policy, errorClassifier: () => { throw new Error('classifier failed') }}
		})
		expect(throwingClassifier.shouldRetry(new Error('operation failed')).shouldRetry).toBe(false)

		const throwingRandom = createRetryEngine({
			clock,
			policy,
			random: () => { throw new Error('random failed') }
		})
		expect(throwingRandom.shouldRetry(new Error('operation failed')).delay).toBe(0)

	})

	it('rechecks the CPU ceiling after a reentrant classifier with an explicit delay', () => {
		let bounded!: ReturnType<typeof createRetryEngine>
		bounded = createRetryEngine({
			clock,
			policy: {
				...policy,
				maxCpuConsumption: 10,
				errorClassifier: () => {
					bounded.recordCpuConsumption(10)
					return {isRetryable: true, category: 'NETWORK', delay: 1}
				}
			}
		})

		expect(bounded.shouldRetry(new Error('operation failed'))).toMatchObject({
			attempt: 1,
			delay: 0,
			shouldRetry: false,
			cpuConsumed: 10
		})
	})

	it('does not evaluate accessor-backed or proxy classifier results', () => {
		const retryableGetter = vi.fn(() => true)
		const accessorResult = Object.defineProperties({}, {
			isRetryable: {enumerable: true, get: retryableGetter},
			category: {enumerable: true, value: 'NETWORK'}
		})
		const accessorClassifier = createRetryEngine({
			clock,
			policy: {...policy, errorClassifier: () => accessorResult as never}
		})
		expect(accessorClassifier.shouldRetry(new Error('operation failed')).shouldRetry).toBe(false)
		expect(retryableGetter).not.toHaveBeenCalled()

		const proxyClassifier = createRetryEngine({
			clock,
			policy: {...policy, errorClassifier: () => new Proxy({}, {
				getOwnPropertyDescriptor() { throw new Error('hostile descriptor') }
			}) as never}
		})
		expect(() => proxyClassifier.shouldRetry(new Error('original failure'))).not.toThrow()
		expect(proxyClassifier.shouldRetry(new Error('original failure')).shouldRetry).toBe(false)
	})

	it('caps classifier-provided delays to the policy maximum', () => {

		const engine = createRetryEngine({
			clock,
			policy: {
				...policy,
				maxDelay: 250,
				errorClassifier: () => ({isRetryable: true, category: 'NETWORK', delay: 1_000})
			}
		})

		expect(engine.shouldRetry(new Error('retryable')).delay).toBe(250)

	})

})
