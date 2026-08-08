import {describe, it, expect} from 'vitest'

import {
	mergeHistogramBuckets,
	selectBucket
} from '../../src/utils/aggregation'

describe('aggregation utils', () => {

	describe('selectBucket', () => {

		it('should return 0 for empty buckets', () => {

			expect(selectBucket(1.0, [])).toBe(0)
		})

		it('should find correct bucket index', () => {

			const buckets = [0.1, 0.5, 1.0, 2.5, 5.0, 10.0]

			expect(selectBucket(0.05, buckets)).toBe(0) // Below first bucket
			expect(selectBucket(0.1, buckets)).toBe(0) // At first bucket
			expect(selectBucket(0.3, buckets)).toBe(1) // Between 0.1 and 0.5
			expect(selectBucket(0.5, buckets)).toBe(1) // At second bucket
			expect(selectBucket(1.5, buckets)).toBe(3) // Between 1.0 and 2.5
			expect(selectBucket(10.0, buckets)).toBe(5) // At last bucket
			expect(selectBucket(20.0, buckets)).toBe(6) // Above all buckets
		})

		it('should handle single bucket', () => {

			expect(selectBucket(0.5, [1.0])).toBe(0)
			expect(selectBucket(1.0, [1.0])).toBe(0)
			expect(selectBucket(2.0, [1.0])).toBe(1)
		})
	})

	describe('mergeHistogramBuckets', () => {

		it('should merge histogram buckets', () => {

			const buckets1 = {
				buckets: [0.1, 0.5, 1.0],
				counts: [1, 2, 3, 1], // +1 for overflow
				sum: 5.0,
				count: 7
			}

			const buckets2 = {
				buckets: [0.1, 0.5, 1.0],
				counts: [2, 1, 2, 0],
				sum: 3.0,
				count: 5
			}

			const merged = mergeHistogramBuckets(buckets1, buckets2)

			expect(merged.buckets).toEqual([0.1, 0.5, 1.0])
			expect(merged.counts).toEqual([3, 3, 5, 1])
			expect(merged.sum).toBe(8.0)
			expect(merged.count).toBe(12)
		})

		it('should throw on different bucket boundaries', () => {

			const buckets1 = {
				buckets: [0.1, 0.5, 1.0],
				counts: [1, 2, 3, 1],
				sum: 5.0,
				count: 7
			}

			const buckets2 = {
				buckets: [0.1, 0.5, 2.0], // Different last bucket
				counts: [2, 1, 2, 0],
				sum: 3.0,
				count: 5
			}

			expect(() => {
				mergeHistogramBuckets(buckets1, buckets2)
			}).toThrow('Cannot merge histograms with different bucket boundaries')
		})

		it('should throw on different bucket lengths', () => {

			const buckets1 = {
				buckets: [0.1, 0.5, 1.0],
				counts: [1, 2, 3, 1],
				sum: 5.0,
				count: 7
			}

			const buckets2 = {
				buckets: [0.1, 0.5], // Different length
				counts: [2, 1, 0],
				sum: 3.0,
				count: 3
			}

			expect(() => {
				mergeHistogramBuckets(buckets1, buckets2)
			}).toThrow('Cannot merge histograms with different bucket boundaries')
		})
	})
})
