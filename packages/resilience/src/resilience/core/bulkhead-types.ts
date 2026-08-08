import type {StateIsolationKey} from './internal-types'

export interface QueuedBulkheadItem {
	resolve(): void
	reject(error: unknown): void
}

export interface BulkheadBucket {
	active: number
	queue: QueuedBulkheadItem[]
	permits: Set<symbol>
}

export interface BulkheadResult {
	readonly allowed: boolean
	readonly bucket: string
	readonly reason?: string
	readonly action?: 'reject' | 'degrade'
	/** Opaque one-shot lease required to release an admitted operation. */
	readonly permit?: symbol
}

export type BulkheadQueueFailure = 'drop-oldest' | 'queue-timeout'

/** Internal typed rejection used to preserve queue-overflow semantics across an async wait. */
export class BulkheadQueueError extends Error {
	constructor(readonly reason: BulkheadQueueFailure) {
		super(reason === 'drop-oldest'
			? 'Dropped from queue (drop-oldest strategy)'
			: 'Bulkhead queue timeout')
		this.name = 'BulkheadQueueError'
	}
}

export type BulkheadBuckets = Map<StateIsolationKey, BulkheadBucket>
