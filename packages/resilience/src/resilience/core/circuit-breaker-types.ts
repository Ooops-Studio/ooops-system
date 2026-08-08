import type {Clock} from '@ooopsstudio/core/contracts/clock'

import type {CircuitBreakerConfig, CircuitBreakerState} from './internal-types'

export interface BreakerStateEntry {
	state: CircuitBreakerState
	failures: number
	successes: number
	windowStart: number
	lastTransitionTime: number
	halfOpenAttempts: number
	halfOpenInFlight: number
	/** One-shot admitted calls, retained across generation transitions until completion. */
	admissions: Map<symbol, {state: CircuitBreakerState; generation: number}>
	gen: number
}
export interface CircuitBreakerEngineOptions {
	readonly clock: Clock
	readonly config: CircuitBreakerConfig
	/** Internal state bound; exposed for deterministic capacity testing. */
	readonly maxStateKeys?: number
}
export interface CircuitBreakerResult {
	readonly allowed: boolean
	readonly state: CircuitBreakerState
	readonly resource: string
	readonly generation: number
	/** Opaque one-shot lease required to finalize an allowed attempt. */
	readonly admission?: symbol
}
export interface CircuitBreakerInspection {
	readonly state: CircuitBreakerState
	readonly failures: number
	readonly successes: number
	readonly windowStart: number
	readonly lastTransitionTime: number
	readonly halfOpenAttempts: number
	readonly generation: number
}
