/**
 * @file Circuit breaker engine - pure L1 logic for circuit breaker state machine.
 * No observability, no orchestration - pure state management.
 */

import {captureClock} from '../utils/capabilities'
import {copyDataDescriptorValues, getPlainDataDescriptors} from '../utils/data-object'

import {createCircuitBreakerStore, inspectBreakerEntry} from './circuit-breaker-store'
import type {BreakerStateEntry, CircuitBreakerEngineOptions, CircuitBreakerInspection, CircuitBreakerResult} from './circuit-breaker-types'
import {validateCircuitBreakerConfig} from './circuit-breaker-validation'
import type {CircuitBreakerState} from './internal-types'
import {createIsolationKey} from './state-isolation'

export type {CircuitBreakerEngineOptions, CircuitBreakerInspection, CircuitBreakerResult} from './circuit-breaker-types'

const MAX_BREAKER_STATE_KEYS = 10_000
const MAX_BREAKER_ADMISSIONS = 10_000

/**
 * Create a circuit breaker engine.
 * Pure logic - no observability, no orchestration.
 */
export function createCircuitBreakerEngine(options: CircuitBreakerEngineOptions) {

	const clock = captureClock(options.clock)
	const configDescriptors = getPlainDataDescriptors(options.config)
	if (!configDescriptors) throw new Error('[Resilience] CircuitBreakerConfig must be a plain data object')
	const inputConfig = copyDataDescriptorValues(configDescriptors) as unknown as CircuitBreakerEngineOptions['config']
	const maxStateKeys = options.maxStateKeys ?? MAX_BREAKER_STATE_KEYS
	if (!Number.isSafeInteger(maxStateKeys) || maxStateKeys < 1 || maxStateKeys > MAX_BREAKER_STATE_KEYS) {
		throw new Error('[Resilience] Circuit breaker maxStateKeys must be a positive safe integer')
	}

	const halfOpenSuccessThreshold = validateCircuitBreakerConfig(inputConfig)
	const config = Object.freeze({
		failureRatioThreshold: inputConfig.failureRatioThreshold,
		failureCountThreshold: inputConfig.failureCountThreshold,
		timeWindow: inputConfig.timeWindow,
		halfOpenTimeout: inputConfig.halfOpenTimeout,
		halfOpenMaxAttempts: inputConfig.halfOpenMaxAttempts,
		...(inputConfig.halfOpenSuccessThreshold !== undefined ? {halfOpenSuccessThreshold: inputConfig.halfOpenSuccessThreshold} : {})
	})

	let destroyed = false
	let generationSequence = 0
	let activeAdmissions = 0

	function createInitialState(): BreakerStateEntry {

		const now = clock.now()
		return {
			state: 'CLOSED',
			failures: 0,
			successes: 0,
			windowStart: now,
			lastTransitionTime: now,
			halfOpenAttempts: 0,
			halfOpenInFlight: 0,
			admissions: new Map(),
			gen: generationSequence++
		}

	}

	const store = createCircuitBreakerStore({
		clock,
		maxStateKeys,
		createEntry: createInitialState,
		nextGeneration: () => generationSequence,
		isDestroyed: () => destroyed,
		isReclaimable: (entry) => entry.admissions.size === 0 && (
			entry.state === 'CLOSED' && (
				entry.failures === 0 || Math.max(0, clock.now() - entry.windowStart) >= config.timeWindow
			)
		)
	})
	const breakers = store.entries
	const getBreakerState = store.getOrCreate
	const inspectMissingState = store.inspectMissing

	/**
	 * Reset window if expired.
	 */
	function resetWindowIfExpired(entry: BreakerStateEntry): void {

		const now = clock.now()
		if (Math.max(0, now - entry.windowStart) >= config.timeWindow) {
			entry.failures = 0
			entry.successes = 0
			entry.windowStart = now
		}

	}

	/**
	 * Check if breaker should transition to OPEN.
	 */
	function shouldOpen(entry: BreakerStateEntry): boolean {

		resetWindowIfExpired(entry)

		const total = entry.failures + entry.successes
		if (total === 0) {
			return false
		}

		const failureRatio = entry.failures / total
		const failureCountExceeded = entry.failures >= config.failureCountThreshold
		const failureRatioExceeded = entry.failures > 0
			&& total >= config.failureCountThreshold
			&& failureRatio >= config.failureRatioThreshold

		return failureCountExceeded || failureRatioExceeded

	}

	/**
	 * Check if breaker should transition from HALF_OPEN to CLOSED.
	 */
	function shouldClose(entry: BreakerStateEntry): boolean {

		if (entry.state !== 'HALF_OPEN') {
			return false
		}

		return entry.successes >= halfOpenSuccessThreshold && entry.halfOpenInFlight === 0

	}

	/**
	 * Reset breaker entry back to CLOSED.
	 */
	function resetEntry(entry: BreakerStateEntry): void {
		entry.state = 'CLOSED'
		entry.failures = 0
		entry.successes = 0
		entry.windowStart = Number.MAX_SAFE_INTEGER
		entry.lastTransitionTime = Number.MAX_SAFE_INTEGER
		entry.halfOpenAttempts = 0
		entry.halfOpenInFlight = 0
		entry.gen = generationSequence++
		const generation = entry.gen
		let now: number
		try { now = clock.now() } catch { return }
		if (entry.state === 'CLOSED' && entry.gen === generation) {
			entry.windowStart = now
			entry.lastTransitionTime = now
		}

	}

	/**
	 * Transition OPEN -> HALF_OPEN when timeout has elapsed.
	 */
	function transitionToHalfOpen(entry: BreakerStateEntry, now: number): void {
		entry.state = 'HALF_OPEN'
		entry.lastTransitionTime = now
		entry.halfOpenAttempts = 0
		entry.halfOpenInFlight = 0
		entry.failures = 0
		entry.successes = 0
		entry.windowStart = now
		entry.gen = generationSequence++

	}

	/**
	 * Apply state transitions before checking allowance/state.
	 */
	function applyTransitions(entry: BreakerStateEntry): void {

		if (entry.state === 'CLOSED' && shouldOpen(entry)) {
			entry.state = 'OPEN'
			entry.lastTransitionTime = Number.MAX_SAFE_INTEGER
			entry.gen = generationSequence++
			const generation = entry.gen
			let openedAt: number
			try { openedAt = clock.now() } catch { return }
			if (entry.state === 'OPEN' && entry.gen === generation) entry.lastTransitionTime = openedAt
			return
		}

		if (entry.state === 'OPEN') {
			const generation = entry.gen
			const now = clock.now()
			if (entry.state === 'OPEN' && entry.gen === generation
				&& Math.max(0, now - entry.lastTransitionTime) >= config.halfOpenTimeout) {
				transitionToHalfOpen(entry, now)
			}
		}

		if (shouldClose(entry)) {
			resetEntry(entry)
		}

	}

	return {

		/**
		 * Check if operation is allowed for resource.
		 * Uses state isolation key for tenant/workspace/resource isolation.
		 */
		canAttempt(
			resource: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string
		): CircuitBreakerResult {
			if (destroyed) return {allowed: false, state: 'OPEN', resource, generation: -1}

			const key = createIsolationKey(resource, scope, id)
			const entry = getBreakerState(key)
			if (!entry) {
				return {allowed: false, state: 'OPEN', resource, generation: -1}
			}

			applyTransitions(entry)
			if (destroyed || breakers.get(key) !== entry) {
				return {allowed: false, state: 'OPEN', resource, generation: -1}
			}

			// Check if allowed
			if (entry.state === 'OPEN') {
				return {
					allowed: false,
					state: 'OPEN',
					resource,
					generation: entry.gen
				}
			}
			if (activeAdmissions >= MAX_BREAKER_ADMISSIONS) {
				return {
					allowed: false,
					state: entry.state,
					resource,
					generation: entry.gen
				}
			}

			if (entry.state === 'HALF_OPEN') {
				if (entry.halfOpenAttempts >= config.halfOpenMaxAttempts) {
					// Probe capacity is saturated, but the admitted probes are still
					// authoritative. Keep HALF_OPEN so their successful completions can
					// close the breaker instead of being invalidated by an extra caller.
					return {
						allowed: false,
						state: 'HALF_OPEN',
						resource,
						generation: entry.gen
					}
				}
				entry.halfOpenAttempts++
				entry.halfOpenInFlight++
			}
			const admission = Symbol('breaker-admission')
			entry.admissions.set(admission, {state: entry.state, generation: entry.gen})
			activeAdmissions++

			return {
				allowed: true,
				state: entry.state,
				resource,
				generation: entry.gen,
				admission
			}

		},

		/**
		 * Record success for resource.
		 */
		recordSuccess(
			resource: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string,
			expectedState?: CircuitBreakerState,
			expectedGeneration?: number,
			admission?: symbol
		): void {
			if (destroyed) return

			const key = createIsolationKey(resource, scope, id)
			const entry = admission === undefined ? getBreakerState(key) : breakers.get(key)
			if (!entry) return
			if (admission !== undefined) {
				const admitted = entry.admissions.get(admission)
				if (!admitted) return
				entry.admissions.delete(admission)
				activeAdmissions--
				expectedState = admitted.state
				expectedGeneration = admitted.generation
			} else if (entry.admissions.size > 0) return
			if (expectedState !== undefined && entry.state !== expectedState) return
			if (expectedGeneration !== undefined && entry.gen !== expectedGeneration) return
			if (expectedState === 'HALF_OPEN') entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1)

			// The rolling failure window belongs only to CLOSED accounting. HALF_OPEN
			// successes are recovery-generation evidence and must survive long-running
			// or sequential probes that cross timeWindow.
			if (entry.state === 'CLOSED') {
				try { resetWindowIfExpired(entry) } catch { return }
			}

			if (entry.state === 'HALF_OPEN') {
				entry.successes++
			} else if (entry.state === 'CLOSED') {
				entry.successes++
			}

		},

		/**
		 * Record failure for resource.
		 */
		recordFailure(
			resource: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string,
			expectedState?: CircuitBreakerState,
			expectedGeneration?: number,
			admission?: symbol
		): void {
			if (destroyed) return

			const key = createIsolationKey(resource, scope, id)
			const entry = admission === undefined ? getBreakerState(key) : breakers.get(key)
			if (!entry) return
			if (admission !== undefined) {
				const admitted = entry.admissions.get(admission)
				if (!admitted) return
				entry.admissions.delete(admission)
				activeAdmissions--
				expectedState = admitted.state
				expectedGeneration = admitted.generation
			} else if (entry.admissions.size > 0) return
			if (expectedState !== undefined && entry.state !== expectedState) return
			if (expectedGeneration !== undefined && entry.gen !== expectedGeneration) return
			if (expectedState === 'HALF_OPEN') entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1)

			if (entry.state === 'CLOSED') {
				try { resetWindowIfExpired(entry) } catch {
					entry.state = 'OPEN'
					entry.lastTransitionTime = Number.MAX_SAFE_INTEGER
					entry.successes = 0
					entry.halfOpenAttempts = 0
					entry.gen = generationSequence++
					return
				}
			}

			entry.failures++

			if (entry.state === 'HALF_OPEN') {
				// Failure in half-open immediately opens
				entry.state = 'OPEN'
				entry.lastTransitionTime = Number.MAX_SAFE_INTEGER
				entry.successes = 0
				entry.halfOpenAttempts = 0
				entry.halfOpenInFlight = 0
				entry.gen = generationSequence++
				const generation = entry.gen
				let failedAt: number
				try { failedAt = clock.now() } catch { return }
				if (breakers.get(key) === entry && entry.state === 'OPEN' && entry.gen === generation) {
					entry.lastTransitionTime = failedAt
				}
			}

		},

		/** Release a half-open probe that ended through caller cancellation. */
		recordCancellation(
			resource: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string,
			expectedState?: CircuitBreakerState,
			expectedGeneration?: number,
			admission?: symbol
		): void {
			if (destroyed) return
			const key = createIsolationKey(resource, scope, id)
			const entry = breakers.get(key)
			if (admission !== undefined) {
				const admitted = entry?.admissions.get(admission)
				if (!admitted) return
				entry!.admissions.delete(admission)
				activeAdmissions--
				expectedState = admitted.state
				expectedGeneration = admitted.generation
			} else if ((entry?.admissions.size ?? 0) > 0) return
			if (expectedState !== undefined && entry?.state !== expectedState) return
			if (expectedGeneration !== undefined && entry?.gen !== expectedGeneration) return
			if (entry?.state === 'HALF_OPEN') {
				entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1)
				if (entry.halfOpenAttempts > 0) entry.halfOpenAttempts--
			}
		},

		/**
		 * Get current state for resource.
		 */
		getState(
			resource: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string
		): CircuitBreakerState {
			if (destroyed) return 'OPEN'

			const key = createIsolationKey(resource, scope, id)
			const entry = breakers.get(key)
			if (!entry) {
				const missing = inspectMissingState()
				return destroyed ? 'OPEN' : missing.state
			}
			applyTransitions(entry)
			if (destroyed) return 'OPEN'
			return entry.state

		},

		/**
		 * Peek raw state without applying transitions.
		 */
		peek(
			resource: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string
		): CircuitBreakerInspection {
			if (destroyed) return {state: 'OPEN', failures: 0, successes: 0, windowStart: 0, lastTransitionTime: 0, halfOpenAttempts: 0, generation: -1}

			const key = createIsolationKey(resource, scope, id)
			const entry = breakers.get(key)
			if (!entry) {
				const missing = inspectMissingState()
				return destroyed ? {state: 'OPEN', failures: 0, successes: 0, windowStart: 0, lastTransitionTime: 0, halfOpenAttempts: 0, generation: -1} : missing
			}

			return inspectBreakerEntry(entry)

		},

		/**
		 * Inspect detailed breaker state for resource.
		 */
		inspect(
			resource: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string
		): CircuitBreakerInspection {
			if (destroyed) return {state: 'OPEN', failures: 0, successes: 0, windowStart: 0, lastTransitionTime: 0, halfOpenAttempts: 0, generation: -1}

			const key = createIsolationKey(resource, scope, id)
			const entry = breakers.get(key)
			if (!entry) {
				const missing = inspectMissingState()
				return destroyed ? {state: 'OPEN', failures: 0, successes: 0, windowStart: 0, lastTransitionTime: 0, halfOpenAttempts: 0, generation: -1} : missing
			}
			applyTransitions(entry)
			if (destroyed) return {state: 'OPEN', failures: 0, successes: 0, windowStart: 0, lastTransitionTime: 0, halfOpenAttempts: 0, generation: -1}

			return inspectBreakerEntry(entry)

		},

		/**
		 * Reset breaker state for resource.
		 */
		reset(
			resource: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string
		): void {
			if (destroyed) return

			const key = createIsolationKey(resource, scope, id)
			activeAdmissions -= breakers.get(key)?.admissions.size ?? 0
			breakers.delete(key)

		},

		/**
		 * Destroy engine - clears all breaker windows and state.
		 */
		destroy(): void {

			destroyed = true
			breakers.clear()
			activeAdmissions = 0

		}

	}

}
