import {describe, expect, it, vi} from 'vitest'

import {
	createAmbiguousDeliveryTimeoutError,
	FAILED_DELIVERY_LINES,
	type LoggingDeliveryError,
	writeLinesSequentially
} from '../../../src/features/transferring/delivery'
import type {Sink} from '../../../src/types/sink'

describe('writeLinesSequentially', () => {
	it('stops at the first failed non-batch write and reports the undelivered suffix', async() => {
		const sink: Sink<string> = {
			write: vi.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('line2 failed'))
		}

		const rejection = await writeLinesSequentially(sink, ['line1', 'line2', 'line3'])
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(sink.write).toHaveBeenCalledTimes(2)
		expect(sink.write).toHaveBeenNthCalledWith(1, 'line1')
		expect(sink.write).toHaveBeenNthCalledWith(2, 'line2')
		expect(rejection).toBeInstanceOf(Error)
		expect(rejection.message).toBe('line2 failed')
		expect(rejection[FAILED_DELIVERY_LINES]).toEqual(['line2', 'line3'])
	})

	it('passes AbortSignal to individual writes when provided', async() => {
		const signal = new AbortController().signal
		const sink: Sink<string> = {
			write: vi.fn().mockResolvedValue(undefined)
		}

		await writeLinesSequentially(sink, ['line'], {signal})

		expect(sink.write).toHaveBeenCalledWith('line', {signal})
	})

	it('keeps a timed-out sequential write ambiguous when the sink rejects its abort signal', async() => {
		const controller = new AbortController()
		const sink: Sink<string> = {
			write: vi.fn().mockImplementation((_line, options?: {signal?: AbortSignal}) => new Promise<void>((_resolve, reject) => {
				options?.signal?.addEventListener('abort', () => {
					reject(new Error('sink aborted the request'))
				}, {once: true})
			}))
		}

		const pending = writeLinesSequentially(sink, ['line1'], {signal: controller.signal})
		controller.abort(createAmbiguousDeliveryTimeoutError('attempt timed out'))

		await expect(pending).rejects.toMatchObject({
			code: 'DELIVERY_TIMEOUT',
			nonRetryable: true,
			ambiguousDelivery: true
		})
	})

	it('marks a single-item writeBatch rejection without accepted-count metadata as ambiguous', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockRejectedValue(new Error('batch transport failed'))
		}

		const rejection = await writeLinesSequentially(sink, ['line1'])
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(rejection).toMatchObject({
			code: 'DELIVERY_BATCH_AMBIGUOUS',
			nonRetryable: true,
			ambiguousDelivery: true
		})
		expect(rejection[FAILED_DELIVERY_LINES]).toEqual(['line1'])
	})

	it('keeps a retry-classified batch rejection ambiguous without a known no-delivery outcome', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockRejectedValue(Object.assign(new Error('connection reset'), {retryable: true}))
		}

		const rejection = await writeLinesSequentially(sink, ['line1'])
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(rejection).toMatchObject({
			code: 'DELIVERY_BATCH_AMBIGUOUS',
			ambiguousDelivery: true,
			nonRetryable: true
		})
	})

	it('marks retry-classified writeBatch rejections as ambiguous without an explicit no-delivery outcome', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockRejectedValue(Object.assign(new Error('connection reset'), {
				code: 'ECONNRESET',
				retryable: true
			}))
		}

		const rejection = await writeLinesSequentially(sink, ['line1', 'line2'])
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(rejection).toMatchObject({
			code: 'DELIVERY_BATCH_AMBIGUOUS',
			nonRetryable: true,
			ambiguousDelivery: true
		})
		expect(rejection[FAILED_DELIVERY_LINES]).toEqual(['line1', 'line2'])
	})

	it('preserves an explicit no-delivery batch outcome for retry orchestration', async() => {
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockRejectedValue(Object.assign(new Error('request rejected'), {
				retryable: true,
				knownNoDelivery: true
			}))
		}

		const rejection = await writeLinesSequentially(sink, ['line1'])
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(rejection).toMatchObject({
			retryable: true,
			knownNoDelivery: true
		})
		expect(rejection.ambiguousDelivery).toBeUndefined()
	})

	it('preserves an exact undelivered suffix reported by a batch sink', async() => {
		const source = Object.assign(new Error('second item failed'), {deliveredCount: 1})
		const batchFailure = Object.assign(source, {
			[FAILED_DELIVERY_LINES]: ['line2', 'line3']
		})
		const sink: Sink<string> = {
			write: vi.fn(),
			writeBatch: vi.fn().mockRejectedValue(batchFailure)
		}

		const rejection = await writeLinesSequentially(sink, ['line1', 'line2', 'line3'])
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(rejection[FAILED_DELIVERY_LINES]).toEqual(['line2', 'line3'])
		expect(rejection.deliveredCount).toBe(1)
		expect(rejection.ambiguousDelivery).toBeUndefined()
	})

	it('wraps frozen sink errors without replacing them with a metadata assignment error', async() => {
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(Object.freeze(new Error('frozen sink failure')))
		}

		const rejection = await writeLinesSequentially(sink, ['line1'])
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(rejection.message).toBe('frozen sink failure')
		expect(rejection.cause).toBeInstanceOf(Error)
		expect(rejection[FAILED_DELIVERY_LINES]).toEqual(['line1'])
	})

	it('preserves a hostile sink failure when its metadata getters throw', async() => {
		const source = new Proxy(new Error('hostile sink failure'), {
			get(target, property, receiver) {
				if (property === 'retryable') {
					throw new Error('metadata getter failed')
				}
				return Reflect.get(target, property, receiver)
			}
		})
		const sink: Sink<string> = {
			write: vi.fn().mockRejectedValue(source)
		}

		const rejection = await writeLinesSequentially(sink, ['line1'])
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(rejection.message).toBe('hostile sink failure')
		expect(rejection.cause).toBe(source)
		expect(rejection[FAILED_DELIVERY_LINES]).toEqual(['line1'])
	})

	it('rejects oversized or accessor-backed undelivered metadata as ambiguous', async() => {
		const getter = vi.fn(() => 'forged')
		const accessorItems = ['placeholder']
		Object.defineProperty(accessorItems, '0', {get: getter})
		const oversizedItems = Array.from({length: 10_001}, () => 'forged')

		for (const items of [accessorItems, oversizedItems]) {
			const source = Object.assign(new Error('hostile batch metadata'), {
				[FAILED_DELIVERY_LINES]: items
			})
			const sink: Sink<string> = {
				write: vi.fn(),
				writeBatch: vi.fn().mockRejectedValue(source)
			}
			const rejection = await writeLinesSequentially(sink, ['line1'])
				.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

			expect(rejection).toMatchObject({
				code: 'DELIVERY_BATCH_AMBIGUOUS',
				nonRetryable: true,
				ambiguousDelivery: true
			})
			expect(rejection[FAILED_DELIVERY_LINES]).toEqual(['line1'])
		}
		expect(getter).not.toHaveBeenCalled()
	})
})
