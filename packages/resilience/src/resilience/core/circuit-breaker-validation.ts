import type {CircuitBreakerConfig} from './internal-types'
import {MAX_TIMER_DELAY_MS} from './timer-limits'

const MAX_BREAKER_COUNT = 10_000
const MAX_HALF_OPEN_ATTEMPTS = 1_000

export function validateCircuitBreakerConfig(config: CircuitBreakerConfig): number {
	if (!Number.isFinite(config.failureRatioThreshold) || config.failureRatioThreshold < 0 || config.failureRatioThreshold > 1) throw new Error('[Resilience] CircuitBreakerConfig.failureRatioThreshold must be between 0 and 1')
	if (!Number.isSafeInteger(config.failureCountThreshold) || config.failureCountThreshold < 1 || config.failureCountThreshold > MAX_BREAKER_COUNT) throw new Error(`[Resilience] CircuitBreakerConfig.failureCountThreshold must be a safe integer between 1 and ${MAX_BREAKER_COUNT}`)
	if (!Number.isFinite(config.timeWindow) || config.timeWindow <= 0 || config.timeWindow > MAX_TIMER_DELAY_MS) throw new Error(`[Resilience] CircuitBreakerConfig.timeWindow must be > 0 and <= ${MAX_TIMER_DELAY_MS}`)
	if (!Number.isFinite(config.halfOpenTimeout) || config.halfOpenTimeout <= 0 || config.halfOpenTimeout > MAX_TIMER_DELAY_MS) throw new Error(`[Resilience] CircuitBreakerConfig.halfOpenTimeout must be > 0 and <= ${MAX_TIMER_DELAY_MS}`)
	if (!Number.isSafeInteger(config.halfOpenMaxAttempts) || config.halfOpenMaxAttempts < 1 || config.halfOpenMaxAttempts > MAX_HALF_OPEN_ATTEMPTS) throw new Error(`[Resilience] CircuitBreakerConfig.halfOpenMaxAttempts must be a safe integer between 1 and ${MAX_HALF_OPEN_ATTEMPTS}`)
	const threshold = config.halfOpenSuccessThreshold ?? config.halfOpenMaxAttempts
	if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > config.halfOpenMaxAttempts) throw new Error('[Resilience] CircuitBreakerConfig.halfOpenSuccessThreshold must be a safe integer between 1 and halfOpenMaxAttempts')
	return threshold
}
