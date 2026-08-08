import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import type {Sink} from '../types/sink'
import type {LogLine, TransferringHandle} from '../types/transferring'

import {createStdoutTransferring} from './fanout-transferring'

/**
 * Production delivery has two independent paths: mandatory direct stdout and
 * one optional fixed remote pipeline. It intentionally does not use custom
 * delivery controls or custom transfer composition.
 */
export async function createProductionTransferring(
	clock: Clock,
	remote: Sink<LogLine> | undefined,
	errors?: Errors,
	selfMetrics?: boolean,
	metrics?: MetricsPort
): Promise<TransferringHandle> {
	const stdout = createStdoutTransferring({
		clock,
		...(errors ? {errors} : {}),
		...(selfMetrics !== undefined ? {selfMetrics} : {}),
		...(metrics ? {metrics} : {})
	})
	if (!remote) return stdout

	const {createProductionRemoteTransferring} = await import('./production-remote-transferring')
	return await createProductionRemoteTransferring({
		stdout,
		remote,
		clock,
		...(selfMetrics !== undefined ? {selfMetrics} : {}),
		...(metrics ? {metrics} : {}),
		...(errors ? {errors} : {})
	})
}
