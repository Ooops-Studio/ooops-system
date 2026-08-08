/**
 * @file Rate-limited logger wrapper for metrics service.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import {createTokenBucket} from '@ooopsstudio/core/runtime/rate/token-bucket'
import {createMonotonicClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'

export interface RateLimitConfig {
	readonly maxLogsPerInterval: number
	readonly intervalMs: number
	readonly burst?: number
}

/**
 * Create a rate-limited logger wrapper.
 * Prevents log spam in hot loops by limiting log frequency.
 */
export function createRateLimitedLogger(
	logger: Logging,
	config: RateLimitConfig,
	clock?: Clock
): Logging {
	const {maxLogsPerInterval, intervalMs, burst = maxLogsPerInterval} = config
	const monotonicClock = clock ? {now: () => clock.now()} : createMonotonicClock()
	const bucket = createTokenBucket(maxLogsPerInterval, intervalMs, burst, monotonicClock)

	const shouldLog = (): boolean => bucket.tryRemove(1)

	return {
		level: logger.level,
		trace: (message, attributes) => {
			if (shouldLog()) {
				logger.trace(message, attributes)
			}
		},
		debug: (message, attributes) => {
			if (shouldLog()) {
				logger.debug(message, attributes)
			}
		},
		info: (message, attributes) => {
			if (shouldLog()) {
				logger.info(message, attributes)
			}
		},
		warn: (message, attributes) => {
			if (shouldLog()) {
				logger.warn(message, attributes)
			}
		},
		error: (message, attributes) => {
			logger.error(message, attributes)
		},
		fatal: (message, attributes) => {
			logger.fatal(message, attributes)
		},
		context: (bindings) => createRateLimitedLogger(logger.context(bindings), config, clock)
	}
}
