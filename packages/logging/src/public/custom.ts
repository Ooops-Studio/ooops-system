import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogContext, LogLevel} from '@ooopsstudio/core/contracts/logging'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import {
	BATCH_INTERVAL_SERVER_PROD_MS,
	BATCH_SIZE_SERVER_PROD,
	QUEUE_BYTES_PRODUCTION,
	QUEUE_ITEMS_PRODUCTION,
	RETRY_MAX_ATTEMPTS_SERVER_PROD
} from '../constants'
import {createLogger} from '../core/logger'
import {cleanupLoggingConstructionFailure, constructLoggerWithCleanup} from '../core/logger-construction'
import {normalizeSampling, snapshotLoggingClock, snapshotLoggingLifecycle} from '../core/logger-helpers'
import {createCircuitProtectedSink} from '../features/transferring/circuit-protected-sink'
import type {Enriching, EnrichingProvider} from '../types/enriching'
import type {Formatting, FormattingMode} from '../types/formatting'
import type {LoggingSamplingPolicy, ManagedLogging, MutableLevelLogging} from '../types/handler'
import type {Redacting, RedactingBudgets, RedactingRule} from '../types/redacting'
import type {
	BackpressurePolicy,
	BatchingPolicy,
	CircuitBreakerPolicy,
	RetryPolicy,
	TransferringHandle,
	TransferringPolicies
} from '../types/transferring'
import {snapshotLogContext} from '../utils/enriching'
import {isLogLevel} from '../utils/guards'
import {snapshotLoggingOptions} from '../utils/options'
import {snapshotTransferringPolicies} from '../utils/transferring-validation'

import {createCustomEnriching, createCustomFormatting, createCustomRedacting} from './custom-stages'
import {createCustomTransferring} from './custom-transferring'
import {createFanoutTransferring, createStdoutTransferring} from './fanout-transferring'
import {buildObservabilityLogContext} from './observability'
import {
	resolveLoggingRemote,
	snapshotLoggingRemote,
	type LoggingRemoteInput
} from './remote-resolution'

export type CustomLoggingRemote = LoggingRemoteInput

export interface CustomLoggingDestinations {
	readonly stdout?: boolean
	/** Route local output to one stream, or split warnings/errors to stderr. */
	readonly consoleStream?: 'split' | 'stdout' | 'stderr'
	readonly remote?: CustomLoggingRemote
}

export interface CustomLoggingDelivery {
	readonly mode?: 'direct' | 'batched'
	readonly batching?: BatchingPolicy
	readonly retry?: RetryPolicy
	readonly backpressure?: BackpressurePolicy
	readonly circuitBreaker?: CircuitBreakerPolicy | false
}

export interface CustomLoggingRedaction {
	readonly additionalKeys?: ReadonlyArray<string | RegExp>
	readonly additionalValuePatterns?: ReadonlyArray<RegExp>
	readonly additionalRules?: ReadonlyArray<RedactingRule>
	readonly budgets?: RedactingBudgets
}

export interface CustomLoggingOptions {
	readonly clock: Clock
	readonly level?: LogLevel
	readonly mutableLevel?: boolean
	readonly format?: FormattingMode
	readonly resource?: ObservabilityResource
	readonly context?: LogContext
	readonly providers?: ReadonlyArray<EnrichingProvider>
	readonly redaction?: CustomLoggingRedaction
	readonly destinations?: CustomLoggingDestinations
	readonly delivery?: CustomLoggingDelivery
	readonly sampling?: LoggingSamplingPolicy
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly lifecycle?: LifecyclePort
	readonly selfMetrics?: boolean
}

const DEFAULT_BATCHING: BatchingPolicy = {
	maxBatch: BATCH_SIZE_SERVER_PROD,
	maxIntervalMs: BATCH_INTERVAL_SERVER_PROD_MS,
	maxBytes: 128_000
}
const DEFAULT_RETRY: RetryPolicy = {
	maxAttempts: RETRY_MAX_ATTEMPTS_SERVER_PROD,
	baseDelayMs: 150,
	multiplier: 2,
	maxDelayMs: 10_000,
	jitter: 0.25,
	attemptTimeoutMs: 8_000
}
const DEFAULT_BACKPRESSURE: BackpressurePolicy = {
	maxQueuedItems: QUEUE_ITEMS_PRODUCTION,
	maxQueuedBytes: QUEUE_BYTES_PRODUCTION,
	onOverflow: 'drop-oldest'
}
const DEFAULT_BREAKER: CircuitBreakerPolicy = {
	failureThreshold: 3,
	halfOpenAfterMs: 5_000,
	maxHalfOpenProbes: 1
}

export interface CreateCustomLogging {
	(options: Readonly<CustomLoggingOptions & {mutableLevel: true}>): Promise<MutableLevelLogging>
	(options: Readonly<CustomLoggingOptions & {mutableLevel?: false}>): Promise<ManagedLogging>
	(options: Readonly<CustomLoggingOptions>): Promise<ManagedLogging | MutableLevelLogging>
}

export const createCustomLogging = (async(
	options: Readonly<CustomLoggingOptions>
) => {
	const snapshot = snapshotLoggingOptions<Readonly<CustomLoggingOptions>>(options, [
		'clock', 'level', 'mutableLevel', 'format', 'resource', 'context', 'providers',
		'redaction', 'destinations', 'delivery', 'sampling', 'errors', 'metrics', 'lifecycle', 'selfMetrics'
	], 'Custom logging')
	const clock = snapshotLoggingClock(snapshot.clock)!
	const lifecycle = snapshotLoggingLifecycle(snapshot.lifecycle)
	const level = snapshot.level ?? 'info'
	if (!isLogLevel(level)) throw new TypeError('Custom logging level must be a valid log level')
	if (snapshot.mutableLevel !== undefined && typeof snapshot.mutableLevel !== 'boolean') {
		throw new TypeError('Custom logging mutableLevel must be a boolean')
	}
	const format = snapshot.format ?? 'json'
	if (format !== 'json' && format !== 'pretty') throw new TypeError('Custom logging format must be json or pretty')
	const selfMetrics = snapshot.selfMetrics ?? true
	if (typeof selfMetrics !== 'boolean') throw new TypeError('Custom logging selfMetrics must be a boolean')
	const sampling = normalizeSampling(snapshot.sampling)
	const destinations = snapshotLoggingOptions<CustomLoggingDestinations>(snapshot.destinations ?? {}, [
		'stdout', 'consoleStream', 'remote'
	], 'Custom logging destinations')
	const stdoutEnabled = destinations.stdout ?? true
	if (typeof stdoutEnabled !== 'boolean') throw new TypeError('Custom logging destinations.stdout must be a boolean')
	const consoleStream = destinations.consoleStream ?? 'split'
	if (consoleStream !== 'split' && consoleStream !== 'stdout' && consoleStream !== 'stderr') {
		throw new TypeError('Custom logging destinations.consoleStream must be split, stdout, or stderr')
	}
	if (!stdoutEnabled && destinations.consoleStream !== undefined) {
		throw new Error('Custom logging destinations.consoleStream requires stdout to be enabled.')
	}
	const remoteSnapshot = snapshotLoggingRemote(destinations.remote, 'Custom logging')
	if (!stdoutEnabled && !remoteSnapshot) throw new Error('Custom logging requires stdout or one remote destination.')
	const delivery = snapshotLoggingOptions<CustomLoggingDelivery>(snapshot.delivery ?? {}, [
		'mode', 'batching', 'retry', 'backpressure', 'circuitBreaker'
	], 'Custom logging delivery')
	const mode = delivery.mode ?? (remoteSnapshot ? 'batched' : 'direct')
	if (mode !== 'direct' && mode !== 'batched') throw new TypeError('Custom logging delivery.mode must be direct or batched')
	if (!remoteSnapshot && (mode !== 'direct' || delivery.batching || delivery.retry || delivery.backpressure || delivery.circuitBreaker !== undefined)) {
		throw new Error('Custom logging delivery policies require a remote destination.')
	}
	if (mode === 'direct' && (delivery.batching || delivery.backpressure)) {
		throw new Error('Custom logging direct delivery does not support batching or backpressure.')
	}
	if (mode === 'batched' && !remoteSnapshot) throw new Error('Custom logging batched delivery requires a remote destination.')
	const policy: TransferringPolicies = snapshotTransferringPolicies({
		...(mode === 'batched' ? {batching: delivery.batching ?? DEFAULT_BATCHING,
			backpressure: delivery.backpressure ?? DEFAULT_BACKPRESSURE} : {}),
		...(remoteSnapshot ? {retry: delivery.retry ?? DEFAULT_RETRY} : {}),
		...(delivery.circuitBreaker
			? {circuitBreaker: delivery.circuitBreaker} : {})
	})
	const breakerPolicy = delivery.circuitBreaker === false ? undefined
		: policy.circuitBreaker ?? (remoteSnapshot ? DEFAULT_BREAKER : undefined)
	const context = snapshotLogContext(buildObservabilityLogContext(snapshot.context, snapshot.resource))
	const stages: [Enriching, Redacting, Formatting] = await Promise.all([
		createCustomEnriching({context, providers: snapshot.providers, errors: snapshot.errors,
			metrics: snapshot.metrics, lifecycle, selfMetrics}),
		createCustomRedacting({...snapshot.redaction, errors: snapshot.errors}),
		createCustomFormatting(format)
	])
	const remote = await resolveLoggingRemote(remoteSnapshot)
	let remoteHandle: TransferringHandle | undefined
	try {
		if (remote) {
			let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
			const protectedSink = breakerPolicy
				? createCircuitProtectedSink(remote, breakerPolicy, (next) => { circuitState = next as typeof circuitState })
				: remote
			const base = await createCustomTransferring(
				protectedSink, clock, policy, snapshot.errors, selfMetrics, snapshot.metrics
			)
			const baseTelemetry = base.telemetry
			remoteHandle = Object.assign(base, {
				telemetry: () => {
					const telemetry = baseTelemetry()
					return Object.freeze({...telemetry,
						sinkState: circuitState === 'open' ? 'unhealthy'
							: circuitState === 'half-open' ? 'degraded' : telemetry.sinkState,
						...(circuitState === 'open' ? {lastFailureCode: 'LOGGING_REMOTE_BREAKER_OPEN'} : {})})
				}
			})
		}
	} catch(error) {
		return await cleanupLoggingConstructionFailure(error, async() => await remote?.close?.())
	}
	let stdout: TransferringHandle | undefined
	let transferring: TransferringHandle
	try {
		stdout = stdoutEnabled ? createStdoutTransferring({clock, stream: consoleStream, errors: snapshot.errors,
			selfMetrics, metrics: snapshot.metrics}) : undefined
		transferring = createFanoutTransferring({stdout, remote: remoteHandle, errors: snapshot.errors})
	} catch(error) {
		return await cleanupLoggingConstructionFailure(error, async() => {
			await Promise.all([stdout?.close(), remoteHandle?.close()])
		})
	}
	return constructLoggerWithCleanup(() => createLogger(
		stages[0], stages[1], stages[2], transferring, clock, level, format, context,
		snapshot.errors, selfMetrics, snapshot.metrics, lifecycle,
		{mutableLevel: snapshot.mutableLevel, sampling}
	), transferring) as Promise<ManagedLogging | MutableLevelLogging>
}) as CreateCustomLogging
