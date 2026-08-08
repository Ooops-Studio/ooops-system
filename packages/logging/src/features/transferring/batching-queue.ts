import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import type {BackpressurePolicy, TransferSignalKind} from '../../types/transferring'

import {enqueueWithBackpressure} from './backpressure'

interface BatchPipeline {
	write(item: {line: string}): void
	getBatchSize(): number
	getBatchBytes(): number
}

interface QueueOptions {
	readonly pipeline: BatchPipeline
	readonly policy: {maxBatch: number; maxBytes: number}
	readonly backpressureRef?: {current?: BackpressurePolicy}
	readonly onMark?: (kind: TransferSignalKind, info?: LogAttributes, size?: number) => void
	readonly onError?: (error: unknown) => void
	readonly onBackpressureDrop: (count: number) => void
}

export interface BatchQueue {
	addLine(
		line: string,
		queue: string[],
		queueSize: {value: number},
		queuedBytes: {value: number}
	): void
	drainQueue(): void
	hasPending(): boolean
	clearDrainTimer(): void
}

export function createBatchQueue(options: Readonly<QueueOptions>): BatchQueue {
	const {pipeline, policy, backpressureRef, onMark, onError, onBackpressureDrop} = options
	const state = {
		queue: undefined as string[] | undefined,
		queueSize: undefined as {value: number} | undefined,
		queuedBytes: undefined as {value: number} | undefined,
		drainTimer: undefined as ReturnType<typeof setTimeout> | undefined
	}

	const drainQueue = (): void => {
		if (!state.queue || !state.queueSize || !state.queuedBytes || state.queue.length === 0) return
		while (state.queue.length > 0) {
			const next = state.queue[0] as string
			const nextBytes = byteSize(next)
			const batchSize = pipeline.getBatchSize()
			if (batchSize > 0 && (
				batchSize >= policy.maxBatch ||
				pipeline.getBatchBytes() + nextBytes > policy.maxBytes
			)) break
			const item = state.queue.shift() as string
			state.queueSize.value -= 1
			state.queuedBytes.value -= nextBytes
			try {
				pipeline.write({line: item})
			} catch(error) {
				state.queue.unshift(item)
				state.queueSize.value += 1
				state.queuedBytes.value += nextBytes
				throw error
			}
		}
	}

	const planDrain = (): void => {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (state.drainTimer) return
		state.drainTimer = setTimeout(() => {
			state.drainTimer = undefined
			try {
				drainQueue()
			} catch(error) {
				try { onError?.(error) } catch { /* Observer failures are isolated. */ }
			}
			if (state.queue && state.queue.length > 0) planDrain()
		}, 100)
		state.drainTimer.unref?.()
	}

	const addLine = (
		line: string,
		queue: string[],
		queueSize: {value: number},
		queuedBytes: {value: number}
	): void => {
		state.queue = queue
		state.queueSize = queueSize
		state.queuedBytes = queuedBytes
		drainQueue()

		const lineBytes = byteSize(line)
		if (pipeline.getBatchSize() < policy.maxBatch && pipeline.getBatchBytes() + lineBytes <= policy.maxBytes) {
			pipeline.write({line})
			return
		}

		const configuredPolicy = backpressureRef?.current
		const policyRef = configuredPolicy
		if (policyRef) {
			const beforeSize = queue.length
			const accepted = enqueueWithBackpressure(
				line, queue, queueSize, queuedBytes, policyRef, false,
				(mark, data) => { onMark?.(mark as TransferSignalKind, data as LogAttributes | undefined) },
				(error) => { onError?.(error) }
			)
			onBackpressureDrop(Math.max(0, beforeSize + 1 - queue.length))
			if (!accepted) return
		} else {
			queue.push(line)
			queueSize.value += 1
			queuedBytes.value += lineBytes
		}
		planDrain()
	}

	return {
		addLine,
		drainQueue,
		hasPending: () => (state.queue?.length ?? 0) > 0,
		clearDrainTimer: () => {
			if (!state.drainTimer) return
			clearTimeout(state.drainTimer)
			state.drainTimer = undefined
		}
	}
}
