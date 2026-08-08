import type {TransferringHandle} from '../types/transferring'

export interface QueueState {
	queue: string[]
	queueSize: {value: number}
	queuedBytes: {value: number}
}

export interface BatchingHandle {
	forceFlush(): Promise<void>
}

/**
 * Creates a standard queue state for transferring functions
 */
export function createTransferringQueue(): QueueState {
	return {
		queue: [],
		queueSize: {value: 0},
		queuedBytes: {value: 0}
	}
}

/**
 * Creates a standard flush function for transferring
 */
export function createStandardFlush(
	baseTransferring: TransferringHandle,
	batching?: BatchingHandle
): () => Promise<void> {
	return async(): Promise<void> => {
		if (batching) {
			await batching.forceFlush()
		}
		await baseTransferring.flush()
	}
}
