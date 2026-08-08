/** @file Logger write-pipeline factory. */
import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes, LogContext, LogLevel, LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import {MAX_ACTIVE_LOG_PIPELINES} from '../constants'
import type {Enriching} from '../types/enriching'
import type {Formatting, FormattingMode} from '../types/formatting'
import type {LoggingSamplingPolicy} from '../types/handler'
import type {Redacting} from '../types/redacting'
import type {TransferringHandle} from '../types/transferring'
import {copyLogAttributes, mergeContext} from '../utils/enriching'
import {reportLogDropped} from '../utils/self-metrics'

import {getSeverityRank, mergeAttributesWithLifecycle, safeClockNow, shouldKeepRecord} from './logger-helpers'
import type {LoggerLifecycleState} from './logger-lifecycle-state'
import {
	invokeTransferLifecycle,
	type TransferLifecycleReentryState
} from './transfer-lifecycle-reentry'

const MAX_ADMITTED_MESSAGE_LENGTH = 16_384

interface LoggerWriterDependencies {
	enriching: Enriching
	redacting: Redacting
	formatting: Formatting
	transferring: TransferringHandle
	clock: Clock
	mode: FormattingMode
	errors?: Errors
	selfMetrics?: boolean
	metrics?: MetricsPort
	controlState: {level: LogLevel; sampling?: LoggingSamplingPolicy}
	lifecycleState: LoggerLifecycleState
	syncLifecycleState: () => void
	isAcceptingWrites: () => boolean
	getAdmissionBarrier: () => Promise<void> | undefined
	inFlightLogs: Set<Promise<void>>
	pipelineReentryState: TransferLifecycleReentryState
	rememberDeliveryFailure: (error: unknown) => void
	recordDropped: (reason: string) => void
	onError: (error: unknown) => void
}

export function createLoggerLogWriter(dependencies: LoggerWriterDependencies) {
	const {
		enriching, redacting, formatting, transferring, clock, mode, errors, selfMetrics, metrics,
		controlState, lifecycleState, syncLifecycleState, isAcceptingWrites, getAdmissionBarrier, inFlightLogs,
		pipelineReentryState, rememberDeliveryFailure, recordDropped, onError
	} = dependencies
	const log = (
		boundContext: LogContext | undefined,
		invocationLevel: LogLevel,
		message: string,
		attributes?: LogAttributes
	): Promise<void> => {
		let release!: () => void
		const reservation = new Promise<void>((resolve) => {
			release = () => {
				inFlightLogs.delete(reservation)
				resolve()
			}
		})
		inFlightLogs.add(reservation)
		const drop = (reason: string): Promise<void> => {
			recordDropped(reason)
			if (selfMetrics) reportLogDropped(metrics, reason)
			release()
			return reservation
		}
		try {
			// Reserve before lifecycle inspection or attribute snapshotting: either may
			// synchronously re-enter shutdown through caller-controlled capabilities.
			syncLifecycleState()
			if (!isAcceptingWrites()) {
				return drop('closed')
			}
			if (inFlightLogs.size > MAX_ACTIVE_LOG_PIPELINES) {
				return drop('capacity')
			}
			const admittedDraining = lifecycleState.isDraining
			const admittedHealthStatus = lifecycleState.healthStatus
			if (admittedDraining && (invocationLevel === 'trace' || invocationLevel === 'debug')) {
				return drop('draining')
			}
			if (getSeverityRank(invocationLevel) < getSeverityRank(controlState.level)) {
				release()
				return reservation
			}
			const admissionBarrier = getAdmissionBarrier()
			const admittedAttributes = copyLogAttributes(attributes)
			const admittedMessage = typeof message === 'string'
				? message.length <= MAX_ADMITTED_MESSAGE_LENGTH
					? message
					: `${message.slice(0, MAX_ADMITTED_MESSAGE_LENGTH)}[Truncated]`
				: '[Unserializable]'
			const pipeline = Promise.resolve().then(() => invokeTransferLifecycle(
				pipelineReentryState,
				async(): Promise<void> => {
					try {
						if (admissionBarrier) await admissionBarrier.catch(() => undefined)
						const enrichedRecord: LogRecord = await enriching({
							level: invocationLevel,
							message: admittedMessage,
							time: safeClockNow(clock),
							context: mergeContext(boundContext, {
								attributes: mergeAttributesWithLifecycle(admittedAttributes, admittedHealthStatus)
							})
						}, {})
						const redactedRecord: LogRecord = await redacting(enrichedRecord, {})
						if (controlState.sampling && !shouldKeepRecord(redactedRecord, invocationLevel, controlState.sampling)) {
							recordDropped('sampling')
							if (selfMetrics) {
								reportLogDropped(metrics, 'sampling')
							}
							return
						}
						const formattedLine = formatting(redactedRecord, {mode, errors})
						transferring.write(formattedLine)
						if (admittedDraining) {
							await transferring.flush().catch((error: unknown) => {
								rememberDeliveryFailure(error)
							})
						}
					} catch(error) {
						onError(error)
					}
				}
			))
			return pipeline.finally(release)
		} catch(error) {
			onError(error)
			release()
			return reservation
		}
	}
	return log
}
