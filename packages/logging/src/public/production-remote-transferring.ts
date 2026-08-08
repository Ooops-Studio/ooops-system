import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import {
	BATCH_INTERVAL_SERVER_PROD_MS,
	BATCH_SIZE_SERVER_PROD,
	QUEUE_BYTES_PRODUCTION,
	QUEUE_ITEMS_PRODUCTION,
	RETRY_MAX_ATTEMPTS_SERVER_PROD
} from '../constants'
import type {BreakerPolicy} from '../features/transferring/circuit-breaker'
import {createCircuitProtectedSink} from '../features/transferring/circuit-protected-sink'
import type {Sink} from '../types/sink'
import type {BackpressurePolicy, BatchingPolicy, LogLine, RetryPolicy, TransferringHandle} from '../types/transferring'

import {createCustomTransferring} from './custom-transferring'
import {createFanoutTransferring} from './fanout-transferring'

const REMOTE_BATCHING: BatchingPolicy = {
	maxBatch: BATCH_SIZE_SERVER_PROD,
	maxIntervalMs: BATCH_INTERVAL_SERVER_PROD_MS,
	maxBytes: 128_000
}

const REMOTE_BACKPRESSURE: BackpressurePolicy = {
	maxQueuedItems: QUEUE_ITEMS_PRODUCTION,
	maxQueuedBytes: QUEUE_BYTES_PRODUCTION,
	onOverflow: 'drop-oldest'
}

const REMOTE_RETRY: RetryPolicy = {
	maxAttempts: RETRY_MAX_ATTEMPTS_SERVER_PROD,
	baseDelayMs: 150,
	multiplier: 2,
	maxDelayMs: 10_000,
	jitter: 0.25,
	attemptTimeoutMs: 8_000
}

const REMOTE_BREAKER: BreakerPolicy = {
	failureThreshold: 3,
	halfOpenAfterMs: 5_000,
	maxHalfOpenProbes: 1
}

export interface ProductionRemoteTransferringOptions {
	readonly stdout: TransferringHandle
	readonly remote: Sink<LogLine>
	readonly clock: Clock
	readonly errors?: Errors
	readonly selfMetrics?: boolean
	readonly metrics?: MetricsPort
}

export async function createProductionRemoteTransferring(
	options: Readonly<ProductionRemoteTransferringOptions>
): Promise<TransferringHandle> {
	let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
	const protectedRemote = createCircuitProtectedSink(options.remote, REMOTE_BREAKER, (state) => {
		if (state === 'closed' || state === 'open' || state === 'half-open') circuitState = state
	})
	const remoteBase = await createCustomTransferring(
		protectedRemote,
		options.clock,
		{batching: REMOTE_BATCHING, retry: REMOTE_RETRY, backpressure: REMOTE_BACKPRESSURE},
		options.errors,
		options.selfMetrics,
		options.metrics
	)
	const baseTelemetry = remoteBase.telemetry
	const remote = Object.assign(remoteBase, {
		telemetry: () => {
			const snapshot = baseTelemetry()
			return Object.freeze({
				...snapshot,
				sinkState: circuitState === 'open' ? 'unhealthy'
					: circuitState === 'half-open' ? 'degraded' : snapshot.sinkState,
				...(circuitState === 'open' ? {lastFailureCode: 'BREAKER_OPEN'} : {})
			})
		}
	})
	return createFanoutTransferring({
		stdout: options.stdout,
		remote,
		...(options.errors ? {errors: options.errors} : {})
	})
}
