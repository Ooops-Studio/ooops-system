import type {LogLevel} from '@ooopsstudio/core/contracts/logging'

import type {LoggingRuntimeState, LoggingStatus} from '../types/handler'
import type {TransferringHandle} from '../types/transferring'

export function projectLoggerStatus(
	level: LogLevel,
	mutableLevel: boolean,
	state: LoggingRuntimeState,
	transferring: TransferringHandle,
	admissionDropped: number,
	runtimeFailureCode?: string
): LoggingStatus {
	try {
		const telemetry = transferring.telemetry()
		return Object.freeze({
			state,
			level,
			mutableLevel,
			queueSize: telemetry.queueSize,
			droppedTotal: telemetry.droppedTotal + admissionDropped,
			retriedTotal: telemetry.retriedTotal,
			sinkState: state === 'closed' ? 'closed' : runtimeFailureCode ? 'unhealthy' : telemetry.sinkState,
			...(runtimeFailureCode ?? telemetry.lastFailureCode
				? {lastFailureCode: runtimeFailureCode ?? telemetry.lastFailureCode} : {})
		})
	} catch {
		return Object.freeze({
			state,
			level,
			mutableLevel,
			queueSize: 0,
			droppedTotal: admissionDropped,
			retriedTotal: 0,
			sinkState: state === 'closed' ? 'closed' : 'unhealthy',
			lastFailureCode: runtimeFailureCode ?? 'LOGGING_STATUS_FAILURE'
		})
	}
}
