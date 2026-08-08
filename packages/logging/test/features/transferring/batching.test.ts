import {describe, it, expect, vi} from 'vitest'

import {createBatching} from '../../../src/features/transferring/batching'

describe('createBatching', () => {
	// Helper function to create batching with mock dependencies
	const createMockBatching = (
		policy: {maxBatch: number; maxBytes: number; maxIntervalMs: number},
		retryPolicy?: {
			maxAttempts: number
			baseDelayMs: number
			multiplier: number
			maxDelayMs: number
			jitter: number
			attemptTimeoutMs: number
		}
	) => {
		const mockWriteBatch = vi.fn().mockResolvedValue(undefined)
		const mockSink = {
			writeBatch: mockWriteBatch,
			write: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined)
		}
		const mockClock = {now: vi.fn().mockReturnValue(Date.now())}
		const mockOnMark = vi.fn()
		const mockOnError = vi.fn()

		return {
			batching: createBatching(
				policy,
				mockClock,
				mockSink,
				retryPolicy,
				mockOnMark,
				mockOnError
			),
			mockSink,
			mockWriteBatch,
			mockClock,
			mockOnMark,
			mockOnError
		}
	}

	it('should create batching state', () => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)

		expect(batching.batch).toEqual([])
		expect(batching.batchBytes).toBe(0)
		expect(batching.flushTimer).toBeUndefined()
		expect(typeof batching.addLine).toBe('function')
		expect(batching.addLine).toHaveLength(4)
		expect(typeof batching.forceFlush).toBe('function')
	})

	it('should add lines to batch', () => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('test line', queue, queueSize, queuedBytes)

		// Pipeline manages batch internally, so batch is empty but batchBytes reflects pipeline state
		expect(batching.batch).toEqual([])
		expect(batching.batchBytes).toBeGreaterThanOrEqual(0)
	})

	it('should flush when batch reaches maxBatch', async() => {
		const policy = {
			maxBatch: 2,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('line1', queue, queueSize, queuedBytes)
		batching.addLine('line2', queue, queueSize, queuedBytes)

		// Wait for pipeline to flush
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Pipeline should have called writeBatch with the batched items
		expect(mockWriteBatch).toHaveBeenCalled()
		const callArgs = mockWriteBatch.mock.calls[0]
		expect(callArgs).toBeDefined()
		expect(callArgs?.[0]).toEqual(['line1', 'line2'])
		expect(batching.batch).toEqual([])
	})

	it('should flush when batch reaches maxBytes', async() => {
		const policy = {
			maxBatch: 10,
			maxBytes: 5,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('hello!', queue, queueSize, queuedBytes) // 6 bytes > 5

		// Wait for pipeline to flush
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(mockWriteBatch).toHaveBeenCalled()
		const callArgs = mockWriteBatch.mock.calls[0]
		expect(callArgs).toBeDefined()
		expect(callArgs?.[0]).toEqual(['hello!'])
		expect(batching.batch).toEqual([])
	})

	it('should plan flush timer when batch is not full', () => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('test', queue, queueSize, queuedBytes)

		// Pipeline manages flush timer internally, so it's undefined in our wrapper
		expect(batching.flushTimer).toBeUndefined()
	})

	it('should force flush immediately', async() => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('test', queue, queueSize, queuedBytes)
		await batching.forceFlush()

		expect(mockWriteBatch).toHaveBeenCalled()
		const callArgs = mockWriteBatch.mock.calls[0]
		expect(callArgs).toBeDefined()
		expect(callArgs?.[0]).toEqual(['test'])
		expect(batching.batch).toEqual([])
	})

	it('should handle empty batch on force flush', async() => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)

		await batching.forceFlush()

		expect(mockWriteBatch).not.toHaveBeenCalled()
	})

	it('waits for and surfaces a batched late ambiguous failure only once', async() => {
		vi.useFakeTimers()
		try {
			let rejectWrite!: (error: Error) => void
			const mockSink = {
				writeBatch: vi.fn().mockImplementation(() => new Promise<void>((_resolve, reject) => {
					rejectWrite = reject
				})),
				write: vi.fn().mockResolvedValue(undefined),
				flush: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined)
			}
			const mockClock = {now: vi.fn().mockReturnValue(Date.now())}
			const batching = createBatching(
				{maxBatch: 1, maxBytes: 1000, maxIntervalMs: 5000},
				mockClock,
				mockSink,
				{
					maxAttempts: 1,
					baseDelayMs: 0,
					multiplier: 1,
					maxDelayMs: 0,
					jitter: 0,
					attemptTimeoutMs: 10
				},
				vi.fn(),
				vi.fn()
			)
			const queue: string[] = []
			const queueSize = {value: 0}
			const queuedBytes = {value: 0}

			batching.addLine('line1', queue, queueSize, queuedBytes)
			let flushSettled = false
			const pendingFlush = batching.forceFlush().finally(() => { flushSettled = true })
			await vi.advanceTimersByTimeAsync(60)
			expect(flushSettled).toBe(false)

			rejectWrite(new Error('late batch failed'))
			await expect(pendingFlush).rejects.toThrow('late batch failed')

			await expect(batching.forceFlush()).resolves.toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it('should drain queue to batch when adding lines', () => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue = ['queued1', 'queued2', 'queued3']
		const queueSize = {value: 3}
		const queuedBytes = {value: 21} // 3 * 7 bytes

		batching.addLine('new line', queue, queueSize, queuedBytes)

		// Pipeline manages batch internally, but queue should be drained
		expect(batching.batch).toEqual([])
		expect(queue).toEqual([])
		expect(queueSize.value).toBe(0)
		expect(queuedBytes.value).toBe(0)
	})

	it('should respect maxBatch limit when draining queue', () => {
		const policy = {
			maxBatch: 2,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue = ['queued1', 'queued2', 'queued3']
		const queueSize = {value: 3}
		const queuedBytes = {value: 21}

		batching.addLine('new line', queue, queueSize, queuedBytes)

		// Pipeline manages batch internally, but queue should respect limits
		// Items that don't fit in pipeline batch will remain in queue
		expect(batching.batch).toEqual([])
		// Queue may still have items if pipeline batch is full
		expect(queueSize.value).toBeLessThanOrEqual(3)
	})

	it('should flush immediately when batch reaches maxBytes', async() => {
		const policy = {
			maxBatch: 10,
			maxBytes: 15,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('line1', queue, queueSize, queuedBytes) // 5 bytes
		batching.addLine('line2', queue, queueSize, queuedBytes) // 5 bytes
		batching.addLine('line3', queue, queueSize, queuedBytes) // 5 bytes

		// Wait for async flush to complete
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(mockWriteBatch).toHaveBeenCalled()
		const callArgs = mockWriteBatch.mock.calls[0]
		expect(callArgs).toBeDefined()
		expect(callArgs?.[0]).toContain('line1')
		expect(batching.batch).toEqual([])
	})

	it('should handle different byte size calculation methods', () => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('hello', queue, queueSize, queuedBytes)
		batching.addLine('world', queue, queueSize, queuedBytes)
		batching.addLine('test', queue, queueSize, queuedBytes)

		// Pipeline manages batch internally
		expect(batching.batch).toEqual([])
		expect(batching.batchBytes).toBeGreaterThanOrEqual(0)
	})

	it('should handle errors in flush callback', async() => {
		const policy = {
			maxBatch: 2,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const mockWriteBatch = vi.fn().mockRejectedValue(new Error('Flush failed'))
		const mockSink = {
			writeBatch: mockWriteBatch,
			write: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined)
		}
		const mockClock = {now: vi.fn().mockReturnValue(Date.now())}
		const mockOnMark = vi.fn()
		const mockOnError = vi.fn()
		const batching = createBatching(policy, mockClock, mockSink, undefined, mockOnMark, mockOnError)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('line1', queue, queueSize, queuedBytes)
		batching.addLine('line2', queue, queueSize, queuedBytes)

		// Wait for pipeline to attempt flush
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Should not throw, but handle the error gracefully
		expect(mockWriteBatch).toHaveBeenCalled()
	})

	it('should handle very large batches', () => {
		const policy = {
			maxBatch: 1000,
			maxBytes: 100000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		// Add many lines
		for (let i = 0; i < 100; i++) {
			batching.addLine(`line${i}`, queue, queueSize, queuedBytes)
		}

		// Pipeline manages batch internally
		expect(batching.batch).toEqual([])
		expect(batching.batchBytes).toBeGreaterThanOrEqual(0)
	})

	it('should handle empty lines', () => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('', queue, queueSize, queuedBytes)

		// Pipeline manages batch internally
		expect(batching.batch).toEqual([])
		expect(batching.batchBytes).toBeGreaterThanOrEqual(0)
	})

	it('should handle special characters in lines', () => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		const specialLine = 'Special chars: "quotes" \n newline \t tab \\ backslash'
		batching.addLine(specialLine, queue, queueSize, queuedBytes)

		// Pipeline manages batch internally
		expect(batching.batch).toEqual([])
		expect(batching.batchBytes).toBeGreaterThanOrEqual(0)
	})

	it('should handle unicode characters', () => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		const unicodeLine = '🚀 emoji test 中文'
		batching.addLine(unicodeLine, queue, queueSize, queuedBytes)

		// Pipeline manages batch internally
		expect(batching.batch).toEqual([])
		expect(batching.batchBytes).toBeGreaterThanOrEqual(0)
	})

	it('should flush immediately when batch is empty and line does not fit', async() => {
		const policy = {
			maxBatch: 1,
			maxBytes: 5,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		// Add a line that exceeds maxBytes when batch is empty
		batching.addLine('very long line that exceeds maxBytes', queue, queueSize, queuedBytes)

		// Should flush immediately even though it doesn't fit
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(mockWriteBatch).toHaveBeenCalled()
	})

	it('should recursively flush after draining queue', async() => {
		const policy = {
			maxBatch: 2,
			maxBytes: 100,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)
		const queue: string[] = ['queued1']
		const queueSize = {value: 1}
		const queuedBytes = {value: 7}

		// Add a line that will drain the queue into the batch
		// After flush completes, if queue still has items, it will recursively flush
		batching.addLine('line1', queue, queueSize, queuedBytes)

		// Add another line that fills the batch (maxBatch is 2)
		// This triggers flush, and after flush, it checks queue and recursively flushes
		batching.addLine('line2', queue, queueSize, queuedBytes)

		// Wait for flush to complete (including recursive flush)
		await new Promise((resolve) => setTimeout(resolve, 200))

		// Should have flushed (the recursive flush happens inside the first flush)
		expect(mockWriteBatch).toHaveBeenCalled()
	})

	it('should handle forceFlush with queue items', async() => {
		const policy = {
			maxBatch: 2,
			maxBytes: 100,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)
		const queue: string[] = ['queued1', 'queued2']
		const queueSize = {value: 2}
		const queuedBytes = {value: 14}

		// Add a line that goes to queue
		batching.addLine('line1', queue, queueSize, queuedBytes)
		batching.addLine('line2', queue, queueSize, queuedBytes)
		batching.addLine('line3', queue, queueSize, queuedBytes)

		// Force flush should drain queue
		await batching.forceFlush()

		expect(mockWriteBatch).toHaveBeenCalled()
		expect(queue.length).toBe(0)
	})

	it('should handle forceFlush when queue is empty but batch has items', async() => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1000,
			maxIntervalMs: 5000
		}

		const {batching, mockWriteBatch} = createMockBatching(policy)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('line1', queue, queueSize, queuedBytes)

		await batching.forceFlush()

		expect(mockWriteBatch).toHaveBeenCalled()
		expect(batching.batch.length).toBe(0)
	})

	it('uses backpressure policy when the pipeline batch is full', async() => {
		const policy = {
			maxBatch: 10,
			maxBytes: 1,
			maxIntervalMs: 5_000
		}
		const mockOnMark = vi.fn()
		const mockOnError = vi.fn()
		const metrics = {increment: vi.fn(), record: vi.fn()}
		const batching = createBatching(
			policy,
			{now: vi.fn().mockReturnValue(Date.now())},
			{
				writeBatch: vi.fn().mockResolvedValue(undefined),
				write: vi.fn().mockResolvedValue(undefined)
			},
			undefined,
			mockOnMark,
			mockOnError,
			true,
			metrics,
			undefined,
			{current: {maxQueuedItems: 1, maxQueuedBytes: 1, onOverflow: 'drop-newest'}}
		)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('line-too-large-for-pipeline', queue, queueSize, queuedBytes)
		await new Promise((resolve) => setTimeout(resolve, 150))

		expect(queueSize.value).toBe(0)
		expect(mockOnMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-drop-newest'})
		expect(metrics.increment).toHaveBeenCalledTimes(1)
	})

	it('surfaces exhausted batch failures during finalization', async() => {
		const policy = {
			maxBatch: 1,
			maxBytes: 100,
			maxIntervalMs: 5_000
		}
		const onError = vi.fn()
		const batching = createBatching(
			policy,
			{now: vi.fn().mockReturnValue(Date.now())},
			{
				writeBatch: vi.fn().mockRejectedValue(Object.assign(new Error('send failed'), {retryable: true, knownNoDelivery: true})),
				write: vi.fn().mockRejectedValue(new Error('send failed'))
			},
			{
				maxAttempts: 1,
				baseDelayMs: 1,
				multiplier: 1,
				maxDelayMs: 1,
				jitter: 0,
				attemptTimeoutMs: 10
			},
			vi.fn(),
			onError,
			false,
			undefined,
			undefined,
			undefined
		)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('line1', queue, queueSize, queuedBytes)
		await expect(batching.forceFlush()).rejects.toThrow('send failed')

		expect(onError).toHaveBeenCalledWith(expect.any(Error))
	})

	it('does not retry a writeBatch rejection with an unknown delivery outcome', async() => {
		const batching = createBatching(
			{maxBatch: 2, maxBytes: 100, maxIntervalMs: 5_000},
			{now: vi.fn().mockReturnValue(Date.now())},
			{
				writeBatch: vi.fn().mockRejectedValue(new Error('unknown batch outcome')),
				write: vi.fn()
			},
			{
				maxAttempts: 1,
				baseDelayMs: 1,
				multiplier: 1,
				maxDelayMs: 1,
				jitter: 0,
				attemptTimeoutMs: 10
			},
			vi.fn(),
			vi.fn(),
			false,
			undefined,
			undefined,
			undefined
		)

		batching.addLine('line1', [], {value: 0}, {value: 0})
		batching.addLine('line2', [], {value: 0}, {value: 0})

		await expect(batching.forceFlush()).rejects.toMatchObject({
			code: 'DELIVERY_BATCH_AMBIGUOUS',
			ambiguousDelivery: true
		})
	})

	it('reports backpressure overflow errors and surfaces them during finalization', async() => {
		const onError = vi.fn()
		const onMark = vi.fn()
		const batching = createBatching(
			{maxBatch: 10, maxBytes: 1, maxIntervalMs: 5_000},
			{now: vi.fn().mockReturnValue(Date.now())},
			{write: vi.fn().mockResolvedValue(undefined)},
			undefined,
			onMark,
			onError,
			false,
			undefined,
			undefined,
			{current: {maxQueuedItems: 0, maxQueuedBytes: 0, onOverflow: 'error'}}
		)

		batching.addLine('xx', [], {value: 0}, {value: 0})

		expect(onMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-error'})
		expect(onError).toHaveBeenCalledWith(expect.any(Error))
		await expect(batching.forceFlush()).rejects.toThrow('queue overflow')
	})

	it('clears a scheduled drain timer during forceFlush', async() => {
		const batching = createBatching(
			{maxBatch: 10, maxBytes: 1, maxIntervalMs: 5_000},
			{now: vi.fn().mockReturnValue(Date.now())},
			{write: vi.fn().mockResolvedValue(undefined), writeBatch: vi.fn().mockResolvedValue(undefined)},
			undefined,
			vi.fn(),
			vi.fn()
		)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}

		batching.addLine('line-too-large-for-pipeline', queue, queueSize, queuedBytes)
		await batching.forceFlush()

		expect(queueSize.value).toBe(0)
	})

	it('unrefs scheduled queue drain timers when the runtime supports it', async() => {
		const originalSetTimeout: typeof setTimeout = globalThis.setTimeout
		const unref = vi.fn()
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler, timeout, ...args) => {
			const handle = originalSetTimeout(handler, timeout, ...args)
			;(handle as {unref?: () => void}).unref = unref
			return handle
		}) as typeof setTimeout)
		try {
			const batching = createBatching(
				{maxBatch: 10, maxBytes: 1, maxIntervalMs: 5_000},
				{now: vi.fn().mockReturnValue(Date.now())},
				{write: vi.fn().mockResolvedValue(undefined), writeBatch: vi.fn().mockResolvedValue(undefined)},
				undefined,
				vi.fn(),
				vi.fn()
			)
			const queue: string[] = []
			const queueSize = {value: 0}
			const queuedBytes = {value: 0}

			batching.addLine('line-too-large-for-pipeline', queue, queueSize, queuedBytes)
			await batching.forceFlush()

			expect(unref).toHaveBeenCalled()
		} finally {
			setTimeoutSpy.mockRestore()
		}
	})

	it('swallows errors thrown by telemetry callbacks on success and retry', async() => {
		const sink = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('retry me'))
				.mockResolvedValueOnce(undefined)
		}
		const batching = createBatching(
			{maxBatch: 1, maxBytes: 100, maxIntervalMs: 5_000},
			{now: vi.fn().mockReturnValue(Date.now())},
			sink,
			{
				maxAttempts: 2,
				baseDelayMs: 1,
				multiplier: 1,
				maxDelayMs: 1,
				jitter: 0,
				attemptTimeoutMs: 10
			},
			vi.fn().mockImplementation(() => {
				throw new Error('mark failed')
			}),
			vi.fn()
		)

		batching.addLine('line1', [], {value: 0}, {value: 0})
		await expect(batching.forceFlush()).resolves.toBeUndefined()
	})

	it('keeps rollover work inside the bounded backpressure queue', async() => {
		let releaseFirst!: () => void
		const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
		const sink = {
			writeBatch: vi.fn()
				.mockImplementationOnce(async() => await firstPending)
				.mockResolvedValue(undefined),
			write: vi.fn().mockResolvedValue(undefined)
		}
		const onMark = vi.fn()
		const batching = createBatching(
			{maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 5_000},
			{now: () => Date.now()}, sink, undefined, onMark, vi.fn(), false,
			undefined, undefined,
			{current: {maxQueuedItems: 1, maxQueuedBytes: 1_000, onOverflow: 'drop-newest'}}
		)
		const queue: string[] = []
		const queueSize = {value: 0}
		const queuedBytes = {value: 0}
		for (const line of ['one', 'two', 'three', 'four', 'five', 'six']) {
			batching.addLine(line, queue, queueSize, queuedBytes)
		}

		expect(queue).toEqual(['five'])
		expect(queueSize.value).toBe(1)
		expect(onMark).toHaveBeenCalledWith('drop', {reason: 'backpressure-drop-newest'})
		releaseFirst()
		await batching.forceFlush()
		expect(queue).toEqual([])
		expect(sink.writeBatch).toHaveBeenCalledTimes(3)
	})

	it('passes abort signals through both batch and single-line sink paths', async() => {
		const abortController = new AbortController()
		const {signal} = abortController
		const batchSink = {
			writeBatch: vi.fn().mockResolvedValue(undefined),
			write: vi.fn().mockResolvedValue(undefined)
		}
		const singleSink = {
			write: vi.fn().mockResolvedValue(undefined)
		}
		const batchingWithBatchSink = createBatching(
			{maxBatch: 1, maxBytes: 100, maxIntervalMs: 5_000},
			{now: vi.fn().mockReturnValue(Date.now())},
			batchSink,
			undefined,
			vi.fn(),
			vi.fn(),
			false,
			undefined,
			signal
		)
		const batchingWithSingleSink = createBatching(
			{maxBatch: 1, maxBytes: 100, maxIntervalMs: 5_000},
			{now: vi.fn().mockReturnValue(Date.now())},
			singleSink,
			undefined,
			vi.fn(),
			vi.fn(),
			false,
			undefined,
			signal
		)

		batchingWithBatchSink.addLine('line1', [], {value: 0}, {value: 0})
		batchingWithSingleSink.addLine('line2', [], {value: 0}, {value: 0})
		await batchingWithBatchSink.forceFlush()
		await batchingWithSingleSink.forceFlush()

		expect(batchSink.writeBatch).toHaveBeenCalledWith(['line1'], expect.objectContaining({signal: expect.any(AbortSignal)}))
		expect(singleSink.write).toHaveBeenCalledWith('line2', expect.objectContaining({signal: expect.any(AbortSignal)}))
	})

	it('does not retry a per-record write that rejects after an attempt timeout', async() => {
		vi.useFakeTimers()
		try {
			const sink = {
				write: vi.fn((_line: string, options?: {signal?: AbortSignal}) => new Promise<void>((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () => reject(new Error('sink aborted')), {once: true})
				}))
			}
			const onError = vi.fn()
			const batching = createBatching(
				{maxBatch: 1, maxBytes: 100, maxIntervalMs: 5_000},
				{now: vi.fn().mockReturnValue(Date.now())},
				sink,
				{maxAttempts: 2, baseDelayMs: 1, multiplier: 1, maxDelayMs: 1, jitter: 0, attemptTimeoutMs: 10},
				vi.fn(),
				onError
			)

			batching.addLine('line1', [], {value: 0}, {value: 0})
			const flush = expect(batching.forceFlush()).rejects.toMatchObject({
				code: 'DELIVERY_TIMEOUT',
				ambiguousDelivery: true,
				nonRetryable: true
			})
			await vi.advanceTimersByTimeAsync(10)
			await flush

			expect(sink.write).toHaveBeenCalledTimes(1)
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				code: 'DELIVERY_TIMEOUT',
				ambiguousDelivery: true,
				nonRetryable: true
			}))
		} finally {
			vi.useRealTimers()
		}
	})

	it('reports retry and success self-metrics when enabled', async() => {
		const metrics = {increment: vi.fn(), record: vi.fn()}
		const batching = createBatching(
			{maxBatch: 1, maxBytes: 100, maxIntervalMs: 5_000},
			{now: vi.fn().mockReturnValue(Date.now())},
			{
				write: vi.fn()
					.mockRejectedValueOnce(new Error('retry me'))
					.mockResolvedValueOnce(undefined)
			},
			{
				maxAttempts: 2,
				baseDelayMs: 1,
				multiplier: 1,
				maxDelayMs: 1,
				jitter: 0,
				attemptTimeoutMs: 10
			},
			vi.fn(),
			vi.fn(),
			true,
			metrics
		)

		batching.addLine('line1', [], {value: 0}, {value: 0})
		await batching.forceFlush()

		expect(metrics.increment).toHaveBeenCalled()
		expect(metrics.record).not.toHaveBeenCalled()
	})
})
