/**
 * @file Aggregation helper functions.
 * Utilities for histogram bucket selection and bucket merging.
 */

/**
 * Find the bucket index for a value in a sorted bucket array
 * @param value - Value to find bucket for
 * @param buckets - Sorted array of bucket boundaries
 * @returns Bucket index (0-based), or buckets.length if value exceeds all buckets
 */
export function selectBucket(value: number, buckets: ReadonlyArray<number>): number {

	if (buckets.length === 0) {
		return 0
	}

	// Binary search for the right bucket
	let left = 0
	let right = buckets.length

	while (left < right) {
		const mid = Math.floor((left + right) / 2)
		if (buckets[mid]! < value) {
			left = mid + 1
		} else {
			right = mid
		}
	}

	return left
}

/**
 * Histogram bucket state
 */
export interface HistogramBuckets {
	readonly buckets: ReadonlyArray<number>
	readonly counts: ReadonlyArray<number>
	readonly sum: number
	readonly count: number
}

/**
 * Merge two histogram bucket states
 * @param buckets1 - First histogram state
 * @param buckets2 - Second histogram state
 * @returns Merged histogram state
 */
export function mergeHistogramBuckets(
	buckets1: HistogramBuckets,
	buckets2: HistogramBuckets
): HistogramBuckets {

	// Ensure both have the same bucket boundaries
	if (buckets1.buckets.length !== buckets2.buckets.length) {
		throw new Error('Cannot merge histograms with different bucket boundaries')
	}

	// Verify bucket boundaries match
	for (let i = 0; i < buckets1.buckets.length; i++) {
		if (buckets1.buckets[i] !== buckets2.buckets[i]) {
			throw new Error('Cannot merge histograms with different bucket boundaries')
		}
	}

	// Merge counts
	const mergedCounts = buckets1.counts.map((count, i) => count + (buckets2.counts[i] ?? 0))

	return {
		buckets: buckets1.buckets,
		counts: mergedCounts,
		sum: buckets1.sum + buckets2.sum,
		count: buckets1.count + buckets2.count
	}
}
