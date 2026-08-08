import {describe, it, expect, vi, beforeEach} from 'vitest'

import {enqueueWithBackpressure} from '../../../src/features/transferring/backpressure'
import type {BackpressurePolicy} from '../../../src/features/transferring/backpressure'

describe('Backpressure', () => {
	const policy: BackpressurePolicy = {
		maxQueuedItems: 3,
		maxQueuedBytes: 100,
		onOverflow: 'drop-oldest'
	}

	const mockOnMark = vi.fn()
	const mockOnError = vi.fn()

	let queue: string[]
	let queueSize: {value: number}
	let queuedBytes: {value: number}

	beforeEach(() => {
		vi.clearAllMocks()
		queue = []
		queueSize = {value: 0}
		queuedBytes = {value: 0}
	})

	describe('enqueueWithBackpressure', () => {
		it('should enqueue line when under limits', () => {
			const result = enqueueWithBackpressure('test line', queue, queueSize, queuedBytes, policy, false, mockOnMark, mockOnError)

			expect(result).toBe(true)
			expect(queue).toEqual(['test line'])
			expect(queueSize.value).toBe(1)
			expect(queuedBytes.value).toBe(9) // 'test line' = 9 bytes
			expect(mockOnMark).not.toHaveBeenCalled()
			expect(mockOnError).not.toHaveBeenCalled()
		})

		it('should enqueue line at front when front=true', () => {
			queue.push('existing line')
			queueSize.value = 1
			queuedBytes.value = 13 // 'existing line' = 13 bytes

			const result = enqueueWithBackpressure('new line', queue, queueSize, queuedBytes, policy, true, mockOnMark, mockOnError)

			expect(result).toBe(true)
			expect(queue).toEqual(['new line', 'existing line'])
			expect(queueSize.value).toBe(2)
			expect(queuedBytes.value).toBe(21) // 8 + 13 = 21 bytes
		})

		it('should drop oldest when maxQueuedItems exceeded and onOverflow=drop-oldest', () => {
			// Fill queue to max capacity
			queue.push('line1', 'line2', 'line3')
			queueSize.value = 3
			queuedBytes.value = 15 // 5 bytes each

			const result = enqueueWithBackpressure('line4', queue, queueSize, queuedBytes, policy, false, mockOnMark, mockOnError)

			expect(result).toBe(true)
			expect(queue).toEqual(['line2', 'line3', 'line4'])
			expect(queueSize.value).toBe(3)
			expect(queuedBytes.value).toBe(15) // Still 15 bytes (5 each)
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-evict-oldest'})
		})

		it('should drop newest when onOverflow=drop-newest', () => {
			const dropNewestPolicy: BackpressurePolicy = {
				maxQueuedItems: 2,
				maxQueuedBytes: 50,
				onOverflow: 'drop-newest'
			}

			queue.push('line1', 'line2')
			queueSize.value = 2
			queuedBytes.value = 10

			const result = enqueueWithBackpressure('line3', queue, queueSize, queuedBytes, dropNewestPolicy, false, mockOnMark, mockOnError)

			expect(result).toBe(false)
			expect(queue).toEqual(['line1', 'line2'])
			expect(queueSize.value).toBe(2)
			expect(queuedBytes.value).toBe(10)
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-drop-newest'})
		})

		it('should error when onOverflow=error', () => {
			const errorPolicy: BackpressurePolicy = {
				maxQueuedItems: 2,
				maxQueuedBytes: 50,
				onOverflow: 'error'
			}

			queue.push('line1', 'line2')
			queueSize.value = 2
			queuedBytes.value = 10

			const result = enqueueWithBackpressure('line3', queue, queueSize, queuedBytes, errorPolicy, false, mockOnMark, mockOnError)

			expect(result).toBe(false)
			expect(queue).toEqual(['line1', 'line2'])
			expect(queueSize.value).toBe(2)
			expect(queuedBytes.value).toBe(10)
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-error'})
			expect(mockOnError).toHaveBeenCalledWith(new Error('transferring/backpressure: queue overflow'))
		})

		it('normalizes legacy onOverflow=block to drop-newest with an error marker', () => {
			const legacyPolicy = {
				maxQueuedItems: 2,
				maxQueuedBytes: 50,
				onOverflow: 'block'
			} as unknown as BackpressurePolicy

			queue.push('line1', 'line2')
			queueSize.value = 2
			queuedBytes.value = 10

			const result = enqueueWithBackpressure('line3', queue, queueSize, queuedBytes, legacyPolicy, false, mockOnMark, mockOnError)

			expect(result).toBe(false)
			expect(queue).toEqual(['line1', 'line2'])
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-drop-newest'})
			expect(mockOnError).toHaveBeenCalledWith(new Error('transferring/backpressure: legacy block overflow policy is not supported; dropping newest'))
		})

		it('should handle maxQueuedBytes exceeded', () => {
			const bytePolicy: BackpressurePolicy = {
				maxQueuedItems: 10,
				maxQueuedBytes: 20,
				onOverflow: 'drop-oldest'
			}

			queue.push('very long line here')
			queueSize.value = 1
			queuedBytes.value = 19 // 'very long line here' = 19 bytes

			const result = enqueueWithBackpressure('test', queue, queueSize, queuedBytes, bytePolicy, false, mockOnMark, mockOnError)

			expect(result).toBe(true)
			expect(queue).toEqual(['test'])
			expect(queueSize.value).toBe(1)
			expect(queuedBytes.value).toBe(4) // 'test' = 4 bytes
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-evict-oldest'})
		})

		it('should handle both limits exceeded', () => {
			const strictPolicy: BackpressurePolicy = {
				maxQueuedItems: 1,
				maxQueuedBytes: 5,
				onOverflow: 'drop-oldest'
			}

			queue.push('test')
			queueSize.value = 1
			queuedBytes.value = 4

			const result = enqueueWithBackpressure('long', queue, queueSize, queuedBytes, strictPolicy, false, mockOnMark, mockOnError)

			expect(result).toBe(true)
			expect(queue).toEqual(['long'])
			expect(queueSize.value).toBe(1)
			expect(queuedBytes.value).toBe(4) // 'long' = 4 bytes
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-evict-oldest'})
		})

		it('should handle empty queue with drop-oldest', () => {
			const dropOldestPolicy: BackpressurePolicy = {
				maxQueuedItems: 0,
				maxQueuedBytes: 0,
				onOverflow: 'drop-oldest'
			}

			const result = enqueueWithBackpressure('test', queue, queueSize, queuedBytes, dropOldestPolicy, false, mockOnMark, mockOnError)

			expect(result).toBe(false)
			expect(queue).toEqual([])
			expect(queueSize.value).toBe(0)
			expect(queuedBytes.value).toBe(0)
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-drop-newest'})
		})

		it('preserves queued records when the newest record can never fit', () => {
			const bytePolicy: BackpressurePolicy = {
				maxQueuedItems: 3,
				maxQueuedBytes: 10,
				onOverflow: 'drop-oldest'
			}
			queue.push('old-1', 'old-2')
			queueSize.value = 2
			queuedBytes.value = 10

			const result = enqueueWithBackpressure(
				'new-record-that-is-too-large',
				queue,
				queueSize,
				queuedBytes,
				bytePolicy,
				false,
				mockOnMark,
				mockOnError
			)

			expect(result).toBe(false)
			expect(queue).toEqual(['old-1', 'old-2'])
			expect(queueSize.value).toBe(2)
			expect(queuedBytes.value).toBe(10)
			expect(mockOnMark).toHaveBeenCalledOnce()
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-drop-newest'})
		})

		it('should handle unicode characters correctly', () => {
			const unicodeLine = '🚀 test with emoji 🎉'
			const result = enqueueWithBackpressure(
				unicodeLine, queue, queueSize, queuedBytes, policy, false, mockOnMark, mockOnError)

			expect(result).toBe(true)
			expect(queue).toEqual([unicodeLine])
			expect(queueSize.value).toBe(1)
			// Unicode characters take more bytes in UTF-8
			expect(queuedBytes.value).toBeGreaterThan(unicodeLine.length)
		})

		it('works in browser-like runtimes without Node Buffer', () => {
			vi.stubGlobal('Buffer', undefined)
			try {
				const result = enqueueWithBackpressure(
					'🚀', queue, queueSize, queuedBytes, policy, false, mockOnMark, mockOnError
				)
				expect(result).toBe(true)
				expect(queuedBytes.value).toBe(4)
			} finally {
				vi.unstubAllGlobals()
			}
		})

		it('should handle very long lines', () => {
			const longLinePolicy: BackpressurePolicy = {
				maxQueuedItems: 3,
				maxQueuedBytes: 2000,
				onOverflow: 'drop-oldest'
			}
			const longLine = 'a'.repeat(1000)
			const result = enqueueWithBackpressure(
				longLine,
				queue,
				queueSize,
				queuedBytes,
				longLinePolicy,
				false,
				mockOnMark,
				mockOnError
			)

			expect(result).toBe(true)
			expect(queue).toEqual([longLine])
			expect(queueSize.value).toBe(1)
			expect(queuedBytes.value).toBe(1000)
		})

		it('should handle multiple consecutive drops', () => {
			const dropNewestPolicy: BackpressurePolicy = {
				maxQueuedItems: 1,
				maxQueuedBytes: 10,
				onOverflow: 'drop-newest'
			}

			queue.push('existing')
			queueSize.value = 1
			queuedBytes.value = 8

			// First drop
			const result1 = enqueueWithBackpressure('line1', queue, queueSize, queuedBytes, dropNewestPolicy, false, mockOnMark, mockOnError)
			expect(result1).toBe(false)
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-drop-newest'})

			// Second drop
			const result2 = enqueueWithBackpressure('line2', queue, queueSize, queuedBytes, dropNewestPolicy, false, mockOnMark, mockOnError)
			expect(result2).toBe(false)
			expect(mockOnMark).toHaveBeenCalledTimes(2)
		})

		it('isolates mark callback failures from drop-newest decisions', () => {
			const dropNewestPolicy: BackpressurePolicy = {
				maxQueuedItems: 1,
				maxQueuedBytes: 10,
				onOverflow: 'drop-newest'
			}
			queue.push('existing')
			queueSize.value = 1
			queuedBytes.value = 8

			const result = enqueueWithBackpressure(
				'line',
				queue,
				queueSize,
				queuedBytes,
				dropNewestPolicy,
				false,
				vi.fn(() => {
					throw new Error('mark failed')
				}),
				mockOnError
			)

			expect(result).toBe(false)
			expect(queue).toEqual(['existing'])
			expect(mockOnError).not.toHaveBeenCalled()
		})

		it('isolates error callback failures from overflow decisions', () => {
			const errorPolicy: BackpressurePolicy = {
				maxQueuedItems: 1,
				maxQueuedBytes: 10,
				onOverflow: 'error'
			}
			queue.push('existing')
			queueSize.value = 1
			queuedBytes.value = 8

			const result = enqueueWithBackpressure(
				'line',
				queue,
				queueSize,
				queuedBytes,
				errorPolicy,
				false,
				mockOnMark,
				vi.fn(() => {
					throw new Error('error observer failed')
				})
			)

			expect(result).toBe(false)
			expect(queue).toEqual(['existing'])
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-error'})
		})

		it('should handle front insertion with drops', () => {
			const dropOldestPolicy: BackpressurePolicy = {
				maxQueuedItems: 2,
				maxQueuedBytes: 20,
				onOverflow: 'drop-oldest'
			}

			queue.push('line1', 'line2')
			queueSize.value = 2
			queuedBytes.value = 10

			const result = enqueueWithBackpressure('line3', queue, queueSize, queuedBytes, dropOldestPolicy, true, mockOnMark, mockOnError)

			expect(result).toBe(true)
			expect(queue).toEqual(['line3', 'line2'])
			expect(queueSize.value).toBe(2)
			expect(queuedBytes.value).toBe(10)
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-evict-oldest'})
		})

		it('should handle edge case with exact byte limit', () => {
			const exactPolicy: BackpressurePolicy = {
				maxQueuedItems: 10,
				maxQueuedBytes: 10,
				onOverflow: 'drop-newest'
			}

			queue.push('123456789') // 9 bytes
			queueSize.value = 1
			queuedBytes.value = 9

			// This should fit exactly
			const result1 = enqueueWithBackpressure('a', queue, queueSize, queuedBytes, exactPolicy, false, mockOnMark, mockOnError)
			expect(result1).toBe(true)
			expect(queue).toEqual(['123456789', 'a'])
			expect(queuedBytes.value).toBe(10)

			// This should be dropped
			const result2 = enqueueWithBackpressure('b', queue, queueSize, queuedBytes, exactPolicy, false, mockOnMark, mockOnError)
			expect(result2).toBe(false)
			expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-drop-newest'})
		})
	})
})
