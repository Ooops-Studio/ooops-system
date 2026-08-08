import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import {
	BATCH_MAX_BYTES_PRODUCTION,
	BATCH_MAX_INTERVAL_PRODUCTION,
	BATCH_MAX_SIZE_PRODUCTION,
	BREAKER_HALF_OPEN_TIMEOUT_PRODUCTION,
	BREAKER_THRESHOLD_PRODUCTION,
	RETRY_BASE_DELAY_PRODUCTION,
	RETRY_JITTER_PRODUCTION,
	RETRY_MAX_ATTEMPTS_PRODUCTION,
	RETRY_MAX_DELAY_PRODUCTION,
	RETRY_MULTIPLIER_PRODUCTION,
	TOKEN_BUCKET_BURST_PRODUCTION,
	TOKEN_BUCKET_RATE_PRODUCTION
} from '../constants'
import {createOtlpRemoteExporter, type OtlpRemoteConfig} from '../sinks'
import type {SpanProcessorPort} from '../types/ports'

import {BatchingProcessor} from './batching-processor'
import {createResilientExporter} from './transferring'

/** Fixed production delivery path. It intentionally has no custom policy branches. */
export function createProductionTracingProcessor(options: {
	readonly remote: OtlpRemoteConfig
	readonly clock: Clock
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
}): SpanProcessorPort {
	const exporter = createResilientExporter({
		exporter: createOtlpRemoteExporter(options.remote, options.clock, true),
		retryPolicy: {
			maxAttempts: RETRY_MAX_ATTEMPTS_PRODUCTION,
			baseDelayMs: RETRY_BASE_DELAY_PRODUCTION,
			multiplier: RETRY_MULTIPLIER_PRODUCTION,
			maxDelayMs: RETRY_MAX_DELAY_PRODUCTION,
			jitter: RETRY_JITTER_PRODUCTION,
			attemptTimeoutMs: 10_000
		},
		tokenBucketRate: TOKEN_BUCKET_RATE_PRODUCTION,
		tokenBucketBurst: TOKEN_BUCKET_BURST_PRODUCTION,
		breakerThreshold: BREAKER_THRESHOLD_PRODUCTION,
		breakerHalfOpenTimeout: BREAKER_HALF_OPEN_TIMEOUT_PRODUCTION,
		clock: options.clock,
		// The batching processor below is the single owner of terminal error
		// reporting; the resilient exporter still owns retry/breaker behavior.
		...(options.logger ? {logger: options.logger} : {})
	})
	return new BatchingProcessor(exporter, {
		maxBatch: BATCH_MAX_SIZE_PRODUCTION,
		maxIntervalMs: BATCH_MAX_INTERVAL_PRODUCTION,
		maxBytes: BATCH_MAX_BYTES_PRODUCTION
	}, options.clock, options.metrics, options.errors)
}
