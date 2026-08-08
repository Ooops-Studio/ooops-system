import {createMonotonicClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'

import type {Sink, SinkWriteOptions} from '../../types/sink'
import type {LogLine} from '../../types/transferring'

import {canAttemptSend, createBreaker, noteFailure, noteSuccess, type BreakerPolicy} from './circuit-breaker'
import {createDeliveryError} from './delivery'

export function createCircuitProtectedSink(
	sink: Sink<LogLine>,
	policy: BreakerPolicy,
	onBreakerEvent?: (state: string) => void
): Sink<LogLine> {
	const breakerPolicy = {...policy}
	const breaker = createBreaker(breakerPolicy.maxHalfOpenProbes)
	const monotonicClock = createMonotonicClock()
	const write = async(line: LogLine, options?: SinkWriteOptions): Promise<void> => {
		if (!canAttemptSend(breaker, breakerPolicy, monotonicClock, onBreakerEvent)) {
			throw Object.assign(new Error('Logging remote circuit breaker is open.'), {
				code: 'LOGGING_REMOTE_BREAKER_OPEN',
				retryable: false
			})
		}
		const attemptGeneration = breaker.generation ?? 0
		try {
			await sink.write(line, options)
			noteSuccess(breaker, onBreakerEvent, attemptGeneration)
		} catch(error) {
			noteFailure(breaker, breakerPolicy, monotonicClock, onBreakerEvent, attemptGeneration)
			throw error
		}
	}
	return {
		write,
		async writeBatch(lines, options) {
			for (let index = 0; index < lines.length; index += 1) {
				try {
					await write(lines[index] as LogLine, options)
				} catch(error) {
					const deliveryError = createDeliveryError(error, lines.slice(index))
					if (index > 0) deliveryError.deliveredCount = index
					throw deliveryError
				}
			}
		},
		async flush(options) {
			await sink.flush?.(options)
		},
		async close() {
			await sink.close?.()
		}
	}
}
