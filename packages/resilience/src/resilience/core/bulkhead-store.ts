import type {BulkheadBucket, BulkheadBuckets} from './bulkhead-types'
import type {StateIsolationKey} from './internal-types'

/** Mutable queue bookkeeping kept separate from bulkhead admission decisions. */
export function createBulkheadStore(maxConcurrent: number, maxBuckets: number) {
	const buckets: BulkheadBuckets = new Map()
	function getOrCreate(key: StateIsolationKey): BulkheadBucket | undefined {
		let bucket = buckets.get(key)
		if (!bucket) {
			if (buckets.size >= maxBuckets) return undefined
			bucket = {active: 0, queue: [], permits: new Set()}
			buckets.set(key, bucket)
		}
		return bucket
	}
	function removeIfIdle(key: StateIsolationKey, bucket: BulkheadBucket): void {
		if (bucket.active === 0 && bucket.queue.length === 0) buckets.delete(key)
	}
	function admitQueued(bucket: BulkheadBucket): void {
		while (bucket.queue.length > 0 && bucket.active < maxConcurrent) {
			const item = bucket.queue.shift()
			if (!item) break
			bucket.active++
			item.resolve()
		}
	}
	function rejectQueued(bucket: BulkheadBucket, message: string): void {
		for (const item of [...bucket.queue]) item.reject(new Error(message))
		bucket.queue = []
	}
	function destroy(message: string): void {
		for (const bucket of buckets.values()) {
			rejectQueued(bucket, message)
			bucket.active = 0
			bucket.permits.clear()
		}
		buckets.clear()
	}
	return {buckets, getOrCreate, removeIfIdle, admitQueued, destroy}
}
