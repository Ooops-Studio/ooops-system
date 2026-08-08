import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import {
	attachTransferLifecycleReentryState,
	createTransferLifecycleReentryState,
	invokeTransferLifecycle,
	isTransferLifecycleReentry,
	isTransferLifecycleStateReentry
} from '../core/transfer-lifecycle-reentry'
import {createTransferring} from '../core/transferring'
import {consoleSink, type ConsoleSinkOptions} from '../features/transferring/console'
import type {TransferSinkState, TransferringHandle} from '../types/transferring'
import {createBoundedFailureBuffer} from '../utils/bounded-failures'
import {createStageOnError} from '../utils/on-error'

const aggregate = (errors: unknown[], message: string): void => {
	if (errors.length === 0) return
	if (errors.length === 1) throw errors[0]
	throw new AggregateError(errors, message)
}

export interface StdoutTransferringOptions {
	readonly clock: Clock
	readonly errors?: Errors
	readonly selfMetrics?: boolean
	readonly metrics?: MetricsPort
	readonly stream?: ConsoleSinkOptions['stream']
}

export function createStdoutTransferring(options: Readonly<StdoutTransferringOptions>): TransferringHandle {
	return createTransferring({sink: consoleSink({stream: options.stream}), clock: options.clock,
		...(options.errors ? {errors: options.errors} : {}),
		...(options.selfMetrics !== undefined ? {selfMetrics: options.selfMetrics} : {}),
		...(options.metrics ? {metrics: options.metrics} : {})})
}

export interface FanoutTransferringOptions {
	readonly stdout?: TransferringHandle
	readonly remote?: TransferringHandle
	readonly errors?: Errors
}

export function createFanoutTransferring(options: Readonly<FanoutTransferringOptions>): TransferringHandle {
	const {stdout, remote, errors} = options
	if (!stdout && !remote) throw new Error('Logging requires stdout or one remote sink.')
	if (!stdout) return remote as TransferringHandle
	if (!remote) return stdout
	const onError = createStageOnError(errors, {stage: 'transferring', preset: 'fanout'})
	const pendingFailures = createBoundedFailureBuffer<unknown>('Fan-out logging writes')
	let closing = false
	let closed = false
	let flushPromise: Promise<void> | undefined
	let closePromise: Promise<void> | undefined
	const lifecycleReentryState = createTransferLifecycleReentryState(
		() => isTransferLifecycleReentry(stdout) || isTransferLifecycleReentry(remote)
	)
	const isLifecycleReentry = (): boolean => isTransferLifecycleStateReentry(lifecycleReentryState)
	const writeTo = (target: TransferringHandle, line: string): void => {
		try { target.write(line) } catch(error) { pendingFailures.push(error); onError(error) }
	}
	return attachTransferLifecycleReentryState({
		write(line): void {
			if (closed || closing) return
			writeTo(stdout, line)
			writeTo(remote, line)
		},
		async flush(): Promise<void> {
			// A child transport may synchronously route lifecycle work back through
			// this fan-out. Joining the operation from inside that child would make
			// the operation await itself, so contain that causal re-entry as a no-op.
			if (isLifecycleReentry()) return
			if (closed) return
			if (closePromise) return await closePromise
			if (flushPromise) return await flushPromise
			let resolveOperation!: () => void
			let rejectOperation!: (error: unknown) => void
			const operation = new Promise<void>((resolve, reject) => {
				resolveOperation = resolve
				rejectOperation = reject
			})
			flushPromise = operation
			const run = async(): Promise<void> => {
				const failures = pendingFailures.drain()
				const settle = async(target: TransferringHandle): Promise<unknown> => {
					let result: Promise<void>
					try {
						result = invokeTransferLifecycle(lifecycleReentryState, () => target.flush())
					} catch(error) { return error }
					try { await result; return undefined } catch(error) { return error }
				}
				const [stdoutFailure, remoteFailure] = await Promise.all([settle(stdout), settle(remote)])
				for (const failure of [stdoutFailure, remoteFailure]) {
					if (failure !== undefined) { failures.push(failure); onError(failure) }
				}
				aggregate(failures, 'Logging fan-out flush failed.')
			}
			void run().then(resolveOperation, rejectOperation)
			try { await operation } finally { if (flushPromise === operation) flushPromise = undefined }
		},
		async close(): Promise<void> {
			if (isLifecycleReentry()) return
			if (closed) return
			if (closePromise) return await closePromise
			closing = true
			let resolveOperation!: () => void
			let rejectOperation!: (error: unknown) => void
			const operation = new Promise<void>((resolve, reject) => {
				resolveOperation = resolve
				rejectOperation = reject
			})
			closePromise = operation
			const run = async(): Promise<void> => {
				const failures = pendingFailures.drain()
				// An already-started fan-out flush owns both child transports. Closing
				// either child concurrently can discard buffered records in adapters that
				// do not serialize their own flush/close operations.
				if (flushPromise) {
					try { await flushPromise } catch(error) { failures.push(error) }
				}
				const closeChild = async(target: TransferringHandle): Promise<void> => {
					let result: Promise<void>
					result = invokeTransferLifecycle(lifecycleReentryState, () => target.close())
					await result
				}
				const settleClose = async(target: TransferringHandle): Promise<unknown> => {
					try { await closeChild(target); return undefined } catch(error) { return error }
				}
				const [stdoutFailure, remoteFailure] = await Promise.all([
					settleClose(stdout), settleClose(remote)
				])
				for (const failure of [stdoutFailure, remoteFailure]) {
					if (failure !== undefined) { failures.push(failure); onError(failure) }
				}
				aggregate(failures, 'Logging fan-out close failed.')
				closed = true
				closing = false
			}
			void run().then(resolveOperation, rejectOperation)
			try { await operation } catch(error) { closePromise = undefined; throw error }
		},
		telemetry: () => {
			const local = stdout.telemetry()
			const distant = remote.telemetry()
			const rank: Record<TransferSinkState, number> = {healthy: 0, degraded: 1, unhealthy: 2, closed: 3}
			const sinkState = closed ? 'closed' : rank[distant.sinkState] >= rank[local.sinkState]
				? distant.sinkState : local.sinkState
			return Object.freeze({
				queueSize: local.queueSize + distant.queueSize,
				writtenTotal: Math.min(local.writtenTotal, distant.writtenTotal),
				droppedTotal: local.droppedTotal + distant.droppedTotal,
				retriedTotal: local.retriedTotal + distant.retriedTotal,
				sinkState,
				...(distant.lastFailureCode ?? local.lastFailureCode
					? {lastFailureCode: distant.lastFailureCode ?? local.lastFailureCode} : {})
			})
		}
	}, lifecycleReentryState)
}
