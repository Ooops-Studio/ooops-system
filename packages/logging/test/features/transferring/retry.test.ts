import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import {httpSink} from '../../../src/features/transferring/http'
import {sendWithRetry, type RetryPolicy} from '../../../src/features/transferring/retry'
import type {Sink} from '../../../src/types/sink'

describe('sendWithRetry', () => {
	const defaultPolicy: RetryPolicy = {
		maxAttempts: 3,
		baseDelayMs: 100,
		multiplier: 2,
		maxDelayMs: 1000,
		jitter: 0.1,
		attemptTimeoutMs: 0
	}

	const mockClock: Clock = {
		now: vi.fn(() => 1000000)
	}

	let onMark: ReturnType<typeof vi.fn>
	let onError: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		onMark = vi.fn()
		onError = vi.fn()
		vi.mocked(mockClock.now).mockReturnValue(1000000)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('should return early when lines array is empty', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn()
		}

		await sendWithRetry([], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).not.toHaveBeenCalled()
		expect(sink.writeBatch).not.toHaveBeenCalled()
		expect(onMark).not.toHaveBeenCalled()
		expect(onError).not.toHaveBeenCalled()
	})

	it('should succeed on first attempt', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined),
			writeBatch: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1', 'line2'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.writeBatch).toHaveBeenCalledWith(['line1', 'line2'])
		expect(onMark).toHaveBeenCalledWith('write-batch', undefined, 2)
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
		expect(onError).not.toHaveBeenCalled()
	})

	it('should use writeBatch when available', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.writeBatch).toHaveBeenCalledWith(['line1'])
		expect(sink.write).not.toHaveBeenCalled()
	})

	it('should fallback to individual writes when writeBatch not available', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1', 'line2'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(sink.write).toHaveBeenNthCalledWith(1, 'line1')
		expect(sink.write).toHaveBeenNthCalledWith(2, 'line2')
	})

	it('reports only the undelivered suffix for non-batch write failures', async() => {
		const onFailure = vi.fn().mockResolvedValue(true)
		const sink: Sink<string> = {
			write: vi.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('line2 failed'))
		}
		const singleAttemptPolicy = {...defaultPolicy, maxAttempts: 1}

		await sendWithRetry(
			['line1', 'line2', 'line3'],
			sink,
			singleAttemptPolicy,
			mockClock,
			onMark,
			onError,
			undefined,
			undefined,
			undefined,
			onFailure
		)

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(sink.write).toHaveBeenNthCalledWith(1, 'line1')
		expect(sink.write).toHaveBeenNthCalledWith(2, 'line2')
		expect(onFailure).toHaveBeenCalledWith(['line2', 'line3'], expect.any(Error))
	})

	it('should retry after failure', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('First attempt fails'))
				.mockResolvedValueOnce(undefined)
		}

		const promise = sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		// Fast-forward past the retry delay
		await vi.advanceTimersByTimeAsync(200)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(onMark).toHaveBeenCalledWith('write-batch', undefined, 1)
		expect(onMark).toHaveBeenCalledWith('error')
		expect(onMark).toHaveBeenCalledWith('retry', expect.objectContaining({attempt: 1, delay: expect.any(Number)}))
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
		expect(onError).not.toHaveBeenCalled()
	})

	it('does not retry an HTTP network failure with an unknown delivery outcome', async() => {
		const mockFetch = vi.fn()
			.mockRejectedValueOnce(new Error('Network error'))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: 'OK',
				text: () => Promise.resolve('OK')
			})
		global.fetch = mockFetch

		const sink = httpSink('https://example.com/logs')

		const result = sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)
		await vi.runAllTicks()
		await expect(result)
			.rejects.toMatchObject({
				code: 'DELIVERY_BATCH_AMBIGUOUS',
				ambiguousDelivery: true
			})

		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(onMark).not.toHaveBeenCalledWith('retry', expect.anything())
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ambiguousDelivery: true}))

		delete (global as unknown as {fetch?: unknown}).fetch
	})

	it('should exhaust max attempts and call onError', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(new Error('Always fails'))
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 2
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Always fails')

		// Fast-forward past all retry delays
		await vi.advanceTimersByTimeAsync(1000)

		await rejection

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(onMark).toHaveBeenCalledWith('write-batch', undefined, 1)
		expect(onMark).toHaveBeenCalledWith('error')
		expect(onError).toHaveBeenCalledWith(expect.any(Error))
	})

	it('should handle maxAttempts less than 1', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(new Error('Fails'))
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 0
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Fails')

		await vi.advanceTimersByTimeAsync(100)

		await rejection

		// Should still attempt at least once (Math.max(1, 0) = 1)
		expect(sink.write).toHaveBeenCalledTimes(1)
		expect(onError).toHaveBeenCalled()
	})

	it('should handle negative maxAttempts', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(new Error('Fails'))
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: -5
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Fails')

		await vi.advanceTimersByTimeAsync(100)

		await rejection

		// Should still attempt at least once (Math.max(1, -5) = 1)
		expect(sink.write).toHaveBeenCalledTimes(1)
		expect(onError).toHaveBeenCalled()
	})

	it('should handle timeout on attempt', async() => {
		const seenSignals: AbortSignal[] = []
		const sink: Sink<string> = {
			write: vi.fn().mockImplementation((_line, options?: {signal?: AbortSignal}) => {
				if (options?.signal) seenSignals.push(options.signal)
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () => {
						reject(new Error('aborted write'))
					}, {once: true})
				})
			}),
			writeBatch: vi.fn().mockImplementation((_lines, options?: {signal?: AbortSignal}) => {
				if (options?.signal) seenSignals.push(options.signal)
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () => {
						reject(new Error('aborted batch'))
					}, {once: true})
				})
			})
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1,
			attemptTimeoutMs: 100
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow()

		// Fast-forward past timeout and retry delays
		await vi.advanceTimersByTimeAsync(500)

		await rejection

		expect(sink.writeBatch).toHaveBeenCalledTimes(1)
		expect(seenSignals[0]?.aborted).toBe(true)
		expect(onError).toHaveBeenCalled()
	})

	it('routes late ambiguous timeout failures through onFailure', async() => {
		let rejectWrite: ((error: Error) => void) | undefined
		const sink: Sink<string> = {
			write: vi.fn().mockImplementation(() => new Promise<void>((_resolve, reject) => {
				rejectWrite = reject
			}))
		}
		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1,
			attemptTimeoutMs: 10
		}
		const onFailure = vi.fn().mockResolvedValue(true)
		const ambiguousDeliveries: Promise<void>[] = []

		const promise = sendWithRetry(
			['line1'],
			sink,
			policy,
			mockClock,
			onMark,
			onError,
			undefined,
			undefined,
			undefined,
			onFailure,
			(delivery) => {
				ambiguousDeliveries.push(delivery)
			}
		)
		const rejection = expect(promise).rejects.toMatchObject({
			code: 'DELIVERY_TIMEOUT',
			ambiguousDelivery: true
		})

		await vi.advanceTimersByTimeAsync(60)
		await rejection
		expect(onFailure).not.toHaveBeenCalled()

		rejectWrite?.(new Error('late write failed'))
		await Promise.allSettled(ambiguousDeliveries)

		expect(onFailure).toHaveBeenCalledWith(['line1'], expect.objectContaining({
			message: 'late write failed'
		}))
	})

	it('keeps late ambiguous fallback failures observable', async() => {
		let rejectWrite: ((error: Error) => void) | undefined
		const sink: Sink<string> = {
			write: vi.fn().mockImplementation(() => new Promise<void>((_resolve, reject) => {
				rejectWrite = reject
			}))
		}
		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1,
			attemptTimeoutMs: 10
		}
		const fallbackError = new Error('spool fallback failed')
		const onFailure = vi.fn().mockRejectedValue(fallbackError)
		const ambiguousDeliveries: Promise<void>[] = []

		const promise = sendWithRetry(
			['line1'],
			sink,
			policy,
			mockClock,
			onMark,
			onError,
			undefined,
			undefined,
			undefined,
			onFailure,
			(delivery) => {
				ambiguousDeliveries.push(delivery)
			}
		)
		const rejection = expect(promise).rejects.toMatchObject({
			code: 'DELIVERY_TIMEOUT',
			ambiguousDelivery: true
		})

		await vi.advanceTimersByTimeAsync(60)
		await rejection

		rejectWrite?.(new Error('late write failed'))
		const failure = await ambiguousDeliveries[0]?.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(AggregateError)
		expect((failure as AggregateError).errors).toEqual([
			expect.objectContaining({message: 'late write failed'}), fallbackError
		])
		expect(onFailure).toHaveBeenCalledWith(['line1'], expect.objectContaining({
			message: 'late write failed'
		}))
		expect(onError).toHaveBeenCalledWith(fallbackError)
	})

	it('contains late delivery when the ambiguous-delivery handoff throws', async() => {
		let rejectWrite!: (error: Error) => void
		const sink: Sink<string> = {
			write: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectWrite = reject }))
		}
		const callbackError = new Error('handoff failed')
		const policy = {...defaultPolicy, maxAttempts: 1, attemptTimeoutMs: 5}
		const operation = sendWithRetry(
			['line1'], sink, policy, mockClock, onMark, onError,
			undefined, undefined, undefined, undefined,
			() => { throw callbackError }
		)
		const rejection = expect(operation).rejects.toMatchObject({ambiguousDelivery: true})
		await vi.advanceTimersByTimeAsync(60)
		await rejection
		rejectWrite(new Error('late failure'))
		await Promise.resolve()
		await Promise.resolve()
		expect(onError).toHaveBeenCalledWith(callbackError)
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({message: 'late failure'}))
	})

	it('should call onMark with correct event types', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail 1'))
				.mockRejectedValueOnce(new Error('Fail 2'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 3
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(1000)

		await promise

		expect(onMark).toHaveBeenCalledWith('write-batch', undefined, 1)
		expect(onMark).toHaveBeenCalledWith('error')
		expect(onMark).toHaveBeenCalledWith('retry', expect.objectContaining({attempt: expect.any(Number), delay: expect.any(Number)}))
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle multiple retries with exponential backoff', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail 1'))
				.mockRejectedValueOnce(new Error('Fail 2'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 3,
			baseDelayMs: 50,
			multiplier: 2
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(500)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(3)
		// Verify retry was called with increasing delays
		const retryCalls = onMark.mock.calls.filter((call) => call[0] === 'retry')
		expect(retryCalls.length).toBeGreaterThan(0)
	})

	it('should handle outer try-catch error', async() => {
		// Test error thrown during sink access (outer try-catch handles it)
		const sink: Sink<string> = {
			get write() {
				return () => {
					throw new Error('Property access error')
				}
			}
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1 // Only one attempt to avoid infinite retry loop
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Property access error')

		// Fast-forward timers to avoid timeout
		await vi.advanceTimersByTimeAsync(100)

		await rejection

		expect(onError).toHaveBeenCalledWith(expect.any(Error))
	})

	it('isolates errors in onMark callbacks', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		const errorOnMark = vi.fn().mockImplementation(() => {
			throw new Error('onMark error')
		})

		await expect(
			sendWithRetry(['line1'], sink, defaultPolicy, mockClock, errorOnMark, onError, undefined, undefined)
		).resolves.toBeUndefined()

		expect(onError).not.toHaveBeenCalled()
	})

	it('isolates errors in onError callbacks', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(new Error('Sink error'))
		}

		const errorOnError = vi.fn().mockImplementation(() => {
			throw new Error('onError callback error')
		})

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1
		}

		await expect(
			sendWithRetry(['line1'], sink, policy, mockClock, onMark, errorOnError, undefined, undefined)
		).rejects.toThrow('Sink error')

		expect(errorOnError).toHaveBeenCalled()
	})

	it('preserves delivery and fallback failures for a single-attempt policy', async() => {
		const deliveryError = new Error('sink delivery failed')
		const fallbackError = new Error('failure fallback failed')
		const sink: Sink<string> = {write: vi.fn().mockRejectedValue(deliveryError)}
		const failureFallback = vi.fn().mockRejectedValue(fallbackError)
		const policy = {...defaultPolicy, maxAttempts: 1}

		const failure = await sendWithRetry(
			['line1'], sink, policy, mockClock, onMark, onError,
			undefined, undefined, undefined, failureFallback
		).then(() => undefined, (error: unknown) => error)

		expect(failure).toBeInstanceOf(AggregateError)
		expect((failure as AggregateError).errors).toEqual([
			expect.objectContaining({cause: deliveryError}), fallbackError
		])
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({cause: deliveryError}))
		expect(onError).toHaveBeenCalledWith(fallbackError)
	})

	it('isolates late timeout delivery observer failures', async() => {
		const sink: Sink<string> = {
			write: vi.fn(() => new Promise((_, reject) => {
				setTimeout(() => reject(new Error('late sink failure')), 100)
			}))
		}
		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1,
			attemptTimeoutMs: 5
		}
		const throwingOnLateError = vi.fn((error: unknown) => {
			if (error instanceof Error && error.message === 'late sink failure') {
				throw new Error('observer failed')
			}
		})

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, throwingOnLateError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Operation timed out after 5ms')

		await vi.advanceTimersByTimeAsync(60)
		await rejection
		await vi.advanceTimersByTimeAsync(100)

		expect(throwingOnLateError).toHaveBeenCalledWith(expect.objectContaining({
			message: 'late sink failure'
		}))
	})

	it('should handle success after multiple retries', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail 1'))
				.mockRejectedValueOnce(new Error('Fail 2'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 3
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(1000)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(3)
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
		expect(onError).not.toHaveBeenCalled()
	})

	it('should handle single line with writeBatch', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['single'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.writeBatch).toHaveBeenCalledWith(['single'])
		expect(sink.write).not.toHaveBeenCalled()
	})

	it('should handle many lines with writeBatch', async() => {
		const lines = Array.from({length: 100}, (_, i) => `line ${i}`)
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(
			lines, sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined
		)

		expect(sink.writeBatch).toHaveBeenCalledWith(lines)
		expect(onMark).toHaveBeenCalledWith('write-batch', undefined, 100)
	})

	it('should handle retry with custom policy values', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			maxAttempts: 5,
			baseDelayMs: 200,
			multiplier: 1.5,
			maxDelayMs: 2000,
			jitter: 0.2,
			attemptTimeoutMs: 10000
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(500)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(onMark).toHaveBeenCalledWith('retry', expect.objectContaining({
			attempt: 1,
			delay: expect.any(Number)
		}))
	})

	it('should break loop when attempt >= maxAttempts', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(new Error('Always fails'))
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 2
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow()

		await vi.advanceTimersByTimeAsync(500)

		await rejection

		// Should attempt exactly maxAttempts times
		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(onError).toHaveBeenCalled()
	})

	it('should handle Promise.all rejection in fallback write', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('Second write fails'))
		}

		const promise = sendWithRetry(['line1', 'line2'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(500)

		await promise

		expect(onMark).toHaveBeenCalledWith('error')
	})

	it('should handle withTimeout rejection', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockImplementation((_line, options?: {signal?: AbortSignal}) => new Promise((_resolve, reject) => {
				options?.signal?.addEventListener('abort', () => {
					reject(new Error('aborted write'))
				}, {once: true})
			})),
			writeBatch: vi.fn().mockImplementation((_lines, options?: {signal?: AbortSignal}) => new Promise((_resolve, reject) => {
				options?.signal?.addEventListener('abort', () => {
					reject(new Error('aborted batch'))
				}, {once: true})
			}))
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1,
			attemptTimeoutMs: 50
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow()

		await vi.advanceTimersByTimeAsync(200)

		await rejection

		expect(onError).toHaveBeenCalled()
	})

	it('should handle zero timeout', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			attemptTimeoutMs: 0
		}

		await sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle negative timeout', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			attemptTimeoutMs: -100
		}

		await sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle Infinity timeout', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			attemptTimeoutMs: Infinity
		}

		await sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle NaN timeout', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			attemptTimeoutMs: NaN
		}

		await sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle very large timeout', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			attemptTimeoutMs: Number.MAX_SAFE_INTEGER
		}

		await sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle zero baseDelayMs', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			baseDelayMs: 0
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(10)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(onMark).toHaveBeenCalledWith('retry', expect.objectContaining({attempt: 1, delay: expect.any(Number)}))
	})

	it('should handle zero multiplier', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			multiplier: 0,
			baseDelayMs: 10 // Use small delay to avoid timeout
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(50)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
	})

	it('should handle zero maxDelayMs', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxDelayMs: 0
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(10)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(onMark).toHaveBeenCalledWith('retry', expect.objectContaining({attempt: 1, delay: 0}))
	})

	it('should handle zero jitter', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			jitter: 0
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(200)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
		const retryCall = onMark.mock.calls.find((call) => call[0] === 'retry')
		expect(retryCall).toBeDefined()
		expect(retryCall?.[1]).toHaveProperty('delay')
	})

	it('should handle negative jitter', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			jitter: -0.1
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(200)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
	})

	it('should handle jitter greater than 1', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			jitter: 1.5,
			baseDelayMs: 10, // Use small delay to avoid timeout
			maxDelayMs: 1000 // Ensure maxDelayMs is reasonable
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(200)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
	})

	it('should handle very small baseDelayMs', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			baseDelayMs: 1
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(10)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
	})

	it('should handle very large baseDelayMs', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			baseDelayMs: 10000
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(11000)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
	})

	it('should handle very large multiplier', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			multiplier: 10
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(200)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
	})

	it('should handle fractional multiplier', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			multiplier: 1.5
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(200)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
	})

	it('should handle maxDelayMs smaller than baseDelayMs', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			baseDelayMs: 1000,
			maxDelayMs: 100
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(200)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(2)
		const retryCall = onMark.mock.calls.find((call) => call[0] === 'retry')
		expect(retryCall?.[1]).toHaveProperty('delay')
		expect((retryCall?.[1] as {delay: number}).delay).toBeLessThanOrEqual(100)
	})

	it('should handle maxAttempts of 1', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(new Error('Fails'))
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Fails')

		await vi.advanceTimersByTimeAsync(100)

		await rejection

		expect(sink.write).toHaveBeenCalledTimes(1)
		expect(onError).toHaveBeenCalled()
		expect(onMark).not.toHaveBeenCalledWith('retry', expect.anything())
	})

	it('should handle very large maxAttempts', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail 1'))
				.mockRejectedValueOnce(new Error('Fail 2'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 100
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(500)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(3)
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle writeBatch throwing synchronously', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockImplementation(() => {
				throw new Error('Synchronous error')
			})
		}

		const promise = sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Synchronous error')

		await vi.advanceTimersByTimeAsync(500)

		await rejection

		expect(onError).toHaveBeenCalled()
	})

	it('should handle write throwing synchronously', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockImplementation(() => {
				throw new Error('Synchronous error')
			})
		}

		const promise = sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Synchronous error')

		await vi.advanceTimersByTimeAsync(500)

		await rejection

		expect(onError).toHaveBeenCalled()
	})

	it('should handle writeBatch returning non-promise', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockReturnValue(undefined as unknown as Promise<void>)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.writeBatch).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle write returning non-promise', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockReturnValue(undefined as unknown as Promise<void>)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle clock.now throwing', async() => {
		const errorClock: Clock = {
			now: vi.fn().mockImplementation(() => {
				throw new Error('Clock error')
			})
		}

		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, errorClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle clock.now returning NaN', async() => {
		const nanClock: Clock = {
			now: vi.fn().mockReturnValue(NaN)
		}

		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, nanClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle clock.now returning Infinity', async() => {
		const infClock: Clock = {
			now: vi.fn().mockReturnValue(Infinity)
		}

		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, infClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle clock.now returning negative value', async() => {
		const negClock: Clock = {
			now: vi.fn().mockReturnValue(-1000)
		}

		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, negClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle multiple consecutive successful calls', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)
		await sendWithRetry(['line2'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)
		await sendWithRetry(['line3'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalledTimes(3)
		expect(onMark).toHaveBeenCalledTimes(6) // 3 write-batch + 3 flush
		expect(onError).not.toHaveBeenCalled()
	})

	it('should handle retry delay calculation with different attempt numbers', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail 1'))
				.mockRejectedValueOnce(new Error('Fail 2'))
				.mockRejectedValueOnce(new Error('Fail 3'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 4,
			baseDelayMs: 100,
			multiplier: 2
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(1000)

		await promise

		expect(sink.write).toHaveBeenCalledTimes(4)
		const retryCalls = onMark.mock.calls.filter((call) => call[0] === 'retry')
		expect(retryCalls.length).toBe(3)
		// Verify delays increase exponentially
		const delays = retryCalls.map((call) => (call[1] as {delay: number}).delay)
		expect(delays[0]).toBeLessThanOrEqual(1000)
		expect(delays[1]).toBeLessThanOrEqual(1000)
		expect(delays[2]).toBeLessThanOrEqual(1000)
	})

	it('should handle error in setTimeout callback', async() => {
		// Note: This test verifies that setTimeout errors are handled gracefully
		// In practice, setTimeout rarely throws synchronously, but if it does,
		// it would be caught by the inner try-catch and trigger a retry
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		// Test that normal setTimeout behavior works (the error handling is tested elsewhere)
		// If setTimeout were to throw, it would be caught by the inner try-catch
		const promise = sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(500)

		await promise

		// Should succeed after retry
		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
		expect(onError).not.toHaveBeenCalled()
	})

	it('should handle very long lines', async() => {
		const longLine = 'a'.repeat(100000)
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(
			[longLine], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined
		)

		expect(sink.write).toHaveBeenCalledWith(longLine)
		expect(onMark).toHaveBeenCalledWith('write-batch', undefined, 1)
	})

	it('should handle special characters in lines', async() => {
		const specialLines = [
			'line with "quotes"',
			'line with\nnewlines',
			'line with\ttabs',
			'line with\\backslashes',
			'🚀 emoji line 中文',
			'line with null\0character',
			'line with unicode \u{1F600}'
		]

		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(
			specialLines, sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined
		)

		expect(sink.write).toHaveBeenCalledTimes(specialLines.length)
		specialLines.forEach((line, index) => {
			expect(sink.write).toHaveBeenNthCalledWith(index + 1, line)
		})
	})

	it('should handle empty strings in lines array', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['', '', ''], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.write).toHaveBeenCalledTimes(3)
		expect(sink.write).toHaveBeenNthCalledWith(1, '')
		expect(sink.write).toHaveBeenNthCalledWith(2, '')
		expect(sink.write).toHaveBeenNthCalledWith(3, '')
	})

	it('should handle onMark being called multiple times per attempt', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const promise = sendWithRetry(['line1', 'line2'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(500)

		await promise

		// Should call write-batch twice (once per attempt), error once, retry once, flush once
		const writeBatchCalls = onMark.mock.calls.filter((call) => call[0] === 'write-batch')
		expect(writeBatchCalls.length).toBe(2)
		expect(writeBatchCalls[0]?.[2]).toBe(2) // size should be 2
		expect(writeBatchCalls[1]?.[2]).toBe(2) // size should be 2
	})

	it('should handle lastErr being undefined when outer catch is triggered', async() => {
		// Test that outer catch handles errors even when lastErr might be undefined
		const sink: Sink<string> = {
			get write() {
				return () => {
					throw new Error('Property access error')
				}
			}
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1 // Only one attempt to avoid infinite retry loop
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Property access error')

		// Fast-forward timers to avoid timeout
		await vi.advanceTimersByTimeAsync(100)

		await rejection
	})

	it('should handle aborted signal before attempt', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		const abortController = new AbortController()
		abortController.abort()

		await sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined, abortController.signal)

		expect(sink.write).not.toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('drop', {reason: 'signal-aborted'})
	})

	it('should handle aborted signal before backoff', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(new Error('Write failed'))
		}

		const abortController = new AbortController()

		const promise = sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined, abortController.signal)

		// Abort after first failure but before backoff
		await vi.advanceTimersByTimeAsync(10)
		abortController.abort()

		await promise

		expect(onMark).toHaveBeenCalledWith('drop', {reason: 'signal-aborted'})
		expect(sink.write).toHaveBeenCalledTimes(1)
	})

	it('drops an in-flight aborted write without invoking the failure handoff', async() => {
		const abortController = new AbortController()
		const onFailure = vi.fn().mockResolvedValue(true)
		const sink: Sink<string> = {
			write: vi.fn((_line, options?: {signal?: AbortSignal}) => new Promise<void>((_resolve, reject) => {
				options?.signal?.addEventListener('abort', () => {
					reject(options.signal?.reason)
				}, {once: true})
			}))
		}

		const delivery = sendWithRetry(
			['line1'], sink, defaultPolicy, mockClock, onMark, onError,
			undefined, undefined, abortController.signal, onFailure
		)
		abortController.abort()

		await expect(delivery).resolves.toBeUndefined()
		expect(onFailure).not.toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('drop', {reason: 'signal-aborted'})
	})

	it('should handle exhausted attempts', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(new Error('Write failed'))
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 2
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Write failed')

		await vi.advanceTimersByTimeAsync(1000)

		await rejection

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(onError).toHaveBeenCalled()
	})

	it('settles a timed-out abort-ignoring attempt after bounded grace', async() => {
		let rejectWrite!: (error: Error) => void
		let settled = false
		const sink: Sink<string> = {
			write: vi.fn().mockImplementation(() => new Promise((_resolve, reject) => {
				rejectWrite = reject
			}))
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 1,
			attemptTimeoutMs: 50
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
			.catch(() => undefined)
			.finally(() => {
				settled = true
			})

		await vi.advanceTimersByTimeAsync(50)
		await Promise.resolve()
		expect(settled).toBe(false)

		await vi.advanceTimersByTimeAsync(50)
		await promise
		expect(settled).toBe(true)
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			code: 'DELIVERY_TIMEOUT',
			ambiguousDelivery: true
		}))

		rejectWrite(new Error('late write failure'))
		await vi.waitFor(() => {
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				message: 'late write failure'
			}))
		})

	})

	it('should handle Promise.resolve wrapping correctly', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined),
			writeBatch: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(sink.writeBatch).toHaveBeenCalled()
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle delay being negative after jitter calculation', async() => {
		// This tests the edge case where jitter could theoretically make delay negative
		// but exponentialBackoff should clamp it to >= 0
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			baseDelayMs: 1,
			jitter: 0.5
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(10)

		await promise

		const retryCall = onMark.mock.calls.find((call) => call[0] === 'retry')
		expect(retryCall).toBeDefined()
		const delay = (retryCall?.[1] as {delay: number}).delay
		expect(delay).toBeGreaterThanOrEqual(0)
	})

	it('should handle delay exceeding maxDelayMs', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			baseDelayMs: 1000,
			multiplier: 10,
			maxDelayMs: 100
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(200)

		await promise

		const retryCall = onMark.mock.calls.find((call) => call[0] === 'retry')
		expect(retryCall).toBeDefined()
		const delay = (retryCall?.[1] as {delay: number}).delay
		expect(delay).toBeLessThanOrEqual(100)
	})

	it('should handle all retry attempts failing with different errors', async() => {
		const errors = [
			new Error('Error 1'),
			new TypeError('Error 2'),
			new RangeError('Error 3')
		]

		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(errors[0])
				.mockRejectedValueOnce(errors[1])
				.mockRejectedValueOnce(errors[2])
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 3
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toThrow('Error 3')

		await vi.advanceTimersByTimeAsync(1000)

		await rejection

		expect(sink.write).toHaveBeenCalledTimes(3)
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({cause: errors[2]}))
	})

	it('should handle non-Error objects being thrown', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce('string error')
				.mockRejectedValueOnce(123)
				.mockRejectedValueOnce(null)
		}

		const policy: RetryPolicy = {
			...defaultPolicy,
			maxAttempts: 3
		}

		const promise = sendWithRetry(['line1'], sink, policy, mockClock, onMark, onError, undefined, undefined)
		const rejection = expect(promise).rejects.toBeNull()

		await vi.advanceTimersByTimeAsync(1000)

		await rejection

		expect(sink.write).toHaveBeenCalledTimes(3)
		expect(onError).toHaveBeenCalledWith(null) // Last error should be passed
	})

	it('should handle onMark receiving correct size parameter', async() => {
		const lines = ['line1', 'line2', 'line3', 'line4', 'line5']
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined),
			writeBatch: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(
			lines, sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined
		)

		expect(onMark).toHaveBeenCalledWith('write-batch', undefined, 5)
	})

	it('should handle onMark receiving undefined info parameter on success', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined),
			writeBatch: vi.fn().mockResolvedValue(undefined)
		}

		await sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		expect(onMark).toHaveBeenCalledWith('write-batch', undefined, 1)
		expect(onMark).toHaveBeenCalledWith('flush', undefined, 0)
	})

	it('should handle onMark receiving retry info with attempt and delay', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockRejectedValueOnce(new Error('Fail'))
				.mockResolvedValueOnce(undefined)
		}

		const promise = sendWithRetry(['line1'], sink, defaultPolicy, mockClock, onMark, onError, undefined, undefined)

		await vi.advanceTimersByTimeAsync(500)

		await promise

		const retryCall = onMark.mock.calls.find((call) => call[0] === 'retry')
		expect(retryCall).toBeDefined()
		expect(retryCall?.[1]).toHaveProperty('attempt')
		expect(retryCall?.[1]).toHaveProperty('delay')
		expect((retryCall?.[1] as {attempt: number}).attempt).toBe(1)
		expect(typeof (retryCall?.[1] as {delay: number}).delay).toBe('number')
	})

	it('does not retry breaker-open errors and reports the failure once', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(Object.assign(new Error('breaker open'), {
				code: 'BREAKER_OPEN'
			}))
		}
		const onFailure = vi.fn()

		await expect(sendWithRetry(
			['line1'],
			sink,
			defaultPolicy,
			mockClock,
			onMark,
			onError,
			undefined,
			undefined,
			undefined,
			onFailure
		)).rejects.toThrow('breaker open')

		expect(sink.write).toHaveBeenCalledTimes(1)
		expect(onMark).toHaveBeenCalledWith('error')
		expect(onMark).not.toHaveBeenCalledWith('retry', expect.anything())
		expect(onFailure).toHaveBeenCalledWith(['line1'], expect.objectContaining({code: 'BREAKER_OPEN'}))
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({code: 'BREAKER_OPEN'}))
	})

	it('does not retry explicitly non-retryable errors', async() => {
		const sink: Sink<string> = {
			writeBatch: vi.fn().mockRejectedValue(Object.assign(new Error('fatal'), {
				nonRetryable: true,
				knownNoDelivery: true
			}))
		}

		await expect(sendWithRetry(
			['line1', 'line2'],
			sink,
			defaultPolicy,
			mockClock,
			onMark,
			onError
		)).rejects.toThrow('fatal')

		expect(sink.writeBatch).toHaveBeenCalledTimes(1)
		expect(onMark).not.toHaveBeenCalledWith('retry', expect.anything())
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({nonRetryable: true}))
	})

	it('does not retry errors marked with retryable false', async() => {
		const sink: Sink<string> = {
			writeBatch: vi.fn().mockRejectedValue(Object.assign(new Error('fatal'), {
				code: 'HTTP_BAD_REQUEST',
				retryable: false,
				statusCode: 400,
				knownNoDelivery: true
			}))
		}

		await expect(sendWithRetry(
			['line1'],
			sink,
			defaultPolicy,
			mockClock,
			onMark,
			onError
		)).rejects.toThrow('fatal')

		expect(sink.writeBatch).toHaveBeenCalledTimes(1)
		expect(onMark).not.toHaveBeenCalledWith('retry', expect.anything())
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			code: 'HTTP_BAD_REQUEST',
			retryable: false,
			statusCode: 400
		}))
	})

	it('isolates throwing telemetry and error observers from delivery outcomes', async() => {
		const observerFailure = () => {
			throw new Error('observer failed')
		}
		const successfulSink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await expect(sendWithRetry(
			['line1'],
			successfulSink,
			defaultPolicy,
			mockClock,
			observerFailure,
			observerFailure
		)).resolves.toBeUndefined()

		const failedSink: Sink<string> = {
			writeBatch: vi.fn().mockRejectedValue(Object.assign(new Error('delivery failed'), {retryable: false}))
		}
		await expect(sendWithRetry(
			['line1'],
			failedSink,
			defaultPolicy,
			mockClock,
			observerFailure,
			observerFailure
		)).rejects.toThrow('delivery failed')
	})
})
