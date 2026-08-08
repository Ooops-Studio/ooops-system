import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createResilientExporter, estimateSpanSize} from '../../src/core/transferring'

const span: SpanRecord = {
	name: 'span', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
	startTime: 0, endTime: 1, durationMs: 1, attributes: {text: 'value'}, status: {code: 'ok'}, events: []
}
const policy = {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 100}
const create = (exporter: Record<string, unknown>, overrides: Record<string, unknown> = {}) => createResilientExporter({
	exporter: exporter as never, retryPolicy: policy, tokenBucketRate: 100, tokenBucketBurst: 100,
	breakerThreshold: 2, breakerHalfOpenTimeout: 100, clock: createFixedClock(0),
	monotonicClock: {now: () => 0}, ...overrides
} as never)

describe('resilient tracing exporter', () => {
	it('keeps retry timer ownership when an exporter rewires global timers', async() => {
		const originalSetTimeout = globalThis.setTimeout
		let attempts = 0
		const exporter = {
			export: vi.fn(async() => {
				attempts++
				if (attempts === 1) {
					globalThis.setTimeout = (() => { throw new Error('poisoned timer') }) as typeof setTimeout
					return {status: 'retryable' as const, acceptedCount: 0, error: new Error('offline')}
				}
				return {status: 'success' as const, acceptedCount: 1}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = create(exporter, {
			retryPolicy: {...policy, baseDelayMs: 1, maxDelayMs: 1}
		})
		try {
			await expect(resilient.export([span])).resolves.toMatchObject({status: 'success', acceptedCount: 1})
			expect(exporter.export).toHaveBeenCalledTimes(2)
		} finally {
			globalThis.setTimeout = originalSetTimeout
		}
		await resilient.shutdown()
	})

	it('never retries physical delivery when its deadline timer is unavailable', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const scheduling = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 100) throw new Error('timer unavailable')
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const exporter = {
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = create(exporter)
		try {
			await expect(resilient.export([span])).resolves.toMatchObject({
				status: 'retryable', acceptedCount: 0
			})
			expect(exporter.export).toHaveBeenCalledOnce()
		} finally { scheduling.mockRestore() }
		await resilient.shutdown()
	})

	it('supports retry without implicitly enabling backpressure or a circuit breaker', async() => {
		const exporter = {export: vi.fn()
			.mockResolvedValueOnce({status: 'retryable', acceptedCount: 0})
			.mockResolvedValue({status: 'success', acceptedCount: 1}), shutdown: vi.fn()}
		const resilient = createResilientExporter({
			exporter, retryPolicy: policy, clock: createFixedClock(0), monotonicClock: {now: () => 0}
		})
		for (let index = 0; index < 101; index++) {
			await expect(resilient.export([span])).resolves.toMatchObject({status: 'success'})
		}
		expect(exporter.export).toHaveBeenCalledTimes(102)
		await resilient.shutdown()
	})

	it('supports a circuit breaker without implicitly enabling retry or backpressure', async() => {
		const exporter = {export: vi.fn().mockRejectedValue(new Error('offline')), shutdown: vi.fn()}
		const resilient = createResilientExporter({
			exporter, breakerThreshold: 1, breakerHalfOpenTimeout: 100,
			clock: createFixedClock(0), monotonicClock: {now: () => 0}
		})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable'})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable'})
		expect(exporter.export).toHaveBeenCalledOnce()
		await resilient.shutdown()
	})

	it('supports backpressure without implicitly enabling retry or a circuit breaker', async() => {
		const exporter = {export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})), shutdown: vi.fn()}
		const resilient = createResilientExporter({
			exporter, tokenBucketRate: 0, tokenBucketBurst: 1,
			clock: createFixedClock(0), monotonicClock: {now: () => 0}
		})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'success'})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'throttled'})
		expect(exporter.export).toHaveBeenCalledOnce()
		await resilient.shutdown()
	})

	it('handles empty, successful, partial, and permanent outcomes', async() => {
		const second = {...span, name: 'second'}
		const exporter = {export: vi.fn()
			.mockResolvedValueOnce({status: 'success', acceptedCount: 1})
			.mockResolvedValueOnce({status: 'partial', acceptedCount: 1})
			.mockResolvedValueOnce({status: 'permanent-failure', acceptedCount: 0, error: new Error('bad')}), shutdown: vi.fn()}
		const resilient = create(exporter)
		await expect(resilient.export([])).resolves.toMatchObject({status: 'success', acceptedCount: 0})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'success'})
		await expect(resilient.export([span, second])).resolves.toMatchObject({status: 'partial', acceptedCount: 1})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'permanent-failure'})
		await resilient.shutdown()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('normalizes a partial result that accepted the full batch to success', async() => {
		const exporter = {
			export: vi.fn(async() => ({status: 'partial' as const, acceptedCount: 1, error: new Error('stale partial marker')})),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = create(exporter)
		await expect(resilient.export([span])).resolves.toEqual({status: 'success', acceptedCount: 1})
	})

	it('snapshots resilient-exporter input before the asynchronous transport hop', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const exporter = {
			export: vi.fn(async(batch: readonly SpanRecord[]) => {
				await gate
				return {status: 'success' as const, acceptedCount: batch.length}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = create(exporter)
		const attributes = {nested: {value: 'before'}}
		const input = {...span, attributes}
		const exporting = resilient.export([input])
		attributes.nested.value = 'after'
		release()

		await expect(exporting).resolves.toMatchObject({status: 'success', acceptedCount: 1})
		expect(exporter.export.mock.calls[0]?.[0]?.[0]?.attributes).toEqual({nested: {value: 'before'}})
		expect(Object.isFrozen(exporter.export.mock.calls[0]?.[0]?.[0]?.attributes)).toBe(true)
	})

	it('rejects unsafe or unbounded resilient-exporter batches before transport', async() => {
		const exporter = {export: vi.fn(), shutdown: vi.fn(async() => undefined)}
		const resilient = create(exporter, {tokenBucketBurst: 20_000})
		const unsafe = {...span, attributes: {} as Record<string, unknown>}
		unsafe.attributes.self = unsafe.attributes

		await expect(resilient.export([unsafe as SpanRecord])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0, error: expect.any(Error)
		})
		await expect(resilient.export(Array.from({length: 10_001}, () => span))).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})
		expect(exporter.export).not.toHaveBeenCalled()
	})

	it('retries retryable results and isolates failure observers and breaker logging', async() => {
		const exporter = {export: vi.fn(async() => ({status: 'retryable' as const, acceptedCount: 0, retryAfterMs: 0, error: new Error('offline')})), shutdown: vi.fn()}
		const onExportFailure = vi.fn(() => { throw new Error('observer') })
		const warn = vi.fn(() => { throw new Error('logger') })
		const resilient = create(exporter, {onExportFailure, logger: {warn}, breakerThreshold: 1})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		expect(exporter.export).toHaveBeenCalledTimes(2)
		expect(onExportFailure).toHaveBeenCalled()
		expect(warn).toHaveBeenCalled()
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
	})

	it('falls back to zero jitter when the randomness source fails without stranding breaker state', async() => {
		const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('randomness unavailable') })
		try {
			const exporter = {
				export: vi.fn(async() => ({status: 'retryable' as const, acceptedCount: 0, error: new Error('offline')})),
				shutdown: vi.fn(async() => undefined)
			}
			const resilient = create(exporter, {
				breakerThreshold: 1,
				retryPolicy: {...policy, baseDelayMs: 1, maxDelayMs: 1, jitter: 1, attemptTimeoutMs: 0}
			})

			await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
			expect(exporter.export).toHaveBeenCalledTimes(2)
			await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
			expect(exporter.export).toHaveBeenCalledTimes(2)
		} finally {
			random.mockRestore()
		}
	})

	it('caps collector retry-after hints at the configured maximum delay', async() => {
		vi.useFakeTimers()
		try {
			const exporter = {
				export: vi.fn()
					.mockResolvedValueOnce({status: 'throttled', acceptedCount: 0, retryAfterMs: 1_000_000})
					.mockResolvedValueOnce({status: 'success', acceptedCount: 1}),
				shutdown: vi.fn()
			}
			const resilient = create(exporter, {
				retryPolicy: {...policy, baseDelayMs: 5, maxDelayMs: 5, attemptTimeoutMs: 0}
			})
			const result = resilient.export([span])
			await vi.advanceTimersByTimeAsync(4)
			expect(exporter.export).toHaveBeenCalledOnce()
			await vi.advanceTimersByTimeAsync(1)
			await expect(result).resolves.toMatchObject({status: 'success', acceptedCount: 1})
		} finally { vi.useRealTimers() }
	})

	it('throttles oversized batches and times out stalled attempts', async() => {
		const throttled = create({export: vi.fn(), shutdown: vi.fn()}, {tokenBucketBurst: 1})
		await expect(throttled.export([span, span])).resolves.toMatchObject({status: 'throttled', acceptedCount: 0})
		const stalled = create({export: vi.fn(async() => await new Promise(() => {})), shutdown: vi.fn()}, {
			retryPolicy: {...policy, maxAttempts: 1, attemptTimeoutMs: 1}
		})
		await expect(stalled.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
	})

	it('estimates span shapes and validates resilience configuration', () => {
		expect(estimateSpanSize(span)).toBeGreaterThan(0)
		expect(estimateSpanSize({...span, attributes: {nested: {value: true}} as never})).toBeGreaterThan(0)
		expect(() => create({} as never, {retryPolicy: {...policy, maxAttempts: 0}})).toThrow()
		expect(() => create({} as never, {retryPolicy: {...policy, maxAttempts: 11}})).toThrow('<= 10')
		expect(() => create({} as never, {tokenBucketBurst: 1_000_001})).toThrow('<= 1000000')
	})

	it('does not retry a malformed acknowledgement after physical delivery', async() => {
		const exporter = {export: vi.fn()
			.mockResolvedValueOnce({status: 'success', acceptedCount: 2})
			.mockResolvedValueOnce({status: 'success', acceptedCount: 1}), shutdown: vi.fn()}
		const resilient = create(exporter)
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		expect(exporter.export).toHaveBeenCalledOnce()
	})

	it('never invokes accessor-backed exporter outcome fields', async() => {
		let acceptedCountReads = 0
		const hostileResult = Object.defineProperty({status: 'success'}, 'acceptedCount', {
			enumerable: true,
			get: () => { acceptedCountReads++; return 1 }
		})
		const exporter = {
			export: vi.fn()
				.mockResolvedValueOnce(hostileResult)
				.mockResolvedValueOnce({status: 'success', acceptedCount: 1}),
			shutdown: vi.fn()
		}
		const resilient = create(exporter)
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		expect(acceptedCountReads).toBe(0)
		expect(exporter.export).toHaveBeenCalledOnce()
	})

	it('does not leave the breaker open when an internal retry recovers', async() => {
		const exporter = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'retryable', acceptedCount: 0, error: new Error('transient')})
				.mockResolvedValue({status: 'success', acceptedCount: 1}),
			shutdown: vi.fn()
		}
		const resilient = create(exporter, {breakerThreshold: 1})

		await expect(resilient.export([span])).resolves.toMatchObject({status: 'success', acceptedCount: 1})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'success', acceptedCount: 1})
		expect(exporter.export).toHaveBeenCalledTimes(3)
	})

	it('does not turn an unknown exporter status into a successful delivery', async() => {
		const exporter = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'unknown', acceptedCount: 1})
				.mockResolvedValueOnce({status: 'success', acceptedCount: 1}),
			shutdown: vi.fn()
		}
		const resilient = create(exporter)
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		expect(exporter.export).toHaveBeenCalledOnce()
	})

	it('retries only the unaccepted suffix and preserves cumulative acceptance', async() => {
		const second = {...span, name: 'second'}
		const exporter = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'retryable', acceptedCount: 1, error: new Error('suffix failed')})
				.mockImplementationOnce(async(spans: readonly SpanRecord[]) => ({status: 'success', acceptedCount: spans.length})),
			shutdown: vi.fn()
		}
		const resilient = create(exporter)
		await expect(resilient.export([span, second])).resolves.toMatchObject({status: 'success', acceptedCount: 2})
		expect(exporter.export.mock.calls[0]?.[0]).toEqual([span, second])
		expect(exporter.export.mock.calls[1]?.[0]).toEqual([second])
	})

	it('reports an already accepted prefix when retries are exhausted', async() => {
		const second = {...span, name: 'second'}
		const exporter = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'retryable', acceptedCount: 1, error: new Error('partial')})
				.mockRejectedValueOnce(new Error('offline')),
			shutdown: vi.fn()
		}
		const resilient = create(exporter)
		await expect(resilient.export([span, second])).resolves.toMatchObject({status: 'retryable', acceptedCount: 1})
		expect(exporter.export.mock.calls[1]?.[0]).toEqual([second])
	})

	it('does not open the transient circuit for permanent payload failures', async() => {
		const exporter = {export: vi.fn()
			.mockResolvedValueOnce({status: 'permanent-failure', acceptedCount: 0, error: new Error('bad payload')})
			.mockResolvedValueOnce({status: 'success', acceptedCount: 1}), shutdown: vi.fn()}
		const resilient = create(exporter, {breakerThreshold: 1})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'permanent-failure'})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'success'})
	})

	it('closes a half-open probe after a permanent payload response', async() => {
		let now = 0
		const exporter = {export: vi.fn()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce({status: 'permanent-failure', acceptedCount: 0, error: new Error('bad payload')})
			.mockResolvedValueOnce({status: 'success', acceptedCount: 1}), shutdown: vi.fn()}
		const resilient = create(exporter, {
			monotonicClock: {now: () => now}, breakerThreshold: 1, breakerHalfOpenTimeout: 10,
			retryPolicy: {...policy, maxAttempts: 1, attemptTimeoutMs: 0}
		})

		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable'})
		now = 10
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'permanent-failure'})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'success'})
		expect(exporter.export).toHaveBeenCalledTimes(3)
	})

	it('releases a half-open probe when the token bucket rejects it', async() => {
		let now = 0
		const exporter = {export: vi.fn().mockRejectedValue(new Error('offline')), shutdown: vi.fn()}
		const resilient = create(exporter, {
			monotonicClock: {now: () => now}, breakerThreshold: 1, breakerHalfOpenTimeout: 10,
			tokenBucketRate: 0, tokenBucketBurst: 1,
			retryPolicy: {...policy, maxAttempts: 1, attemptTimeoutMs: 0}
		})

		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable'})
		now = 10
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'throttled'})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'throttled'})
		expect(exporter.export).toHaveBeenCalledOnce()
	})

	it('transitions an open breaker through half-open back to closed', async() => {
		let now = 0
		const exporter = {export: vi.fn()
			.mockRejectedValueOnce('offline')
			.mockResolvedValue({status: 'success', acceptedCount: 1}), shutdown: vi.fn()}
		const resilient = create(exporter, {
			monotonicClock: {now: () => now}, breakerThreshold: 1, breakerHalfOpenTimeout: 10,
			retryPolicy: {...policy, maxAttempts: 1, attemptTimeoutMs: 0}
		})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable'})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable'})
		now = 10
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'success'})
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'success'})
	})

	it('fences stale closed-state outcomes from an active half-open probe', async() => {
		let now = 0
		type PendingExport = {
			resolve: (result: {status: 'success'; acceptedCount: number}) => void
			reject: (error: Error) => void
		}
		const pending: PendingExport[] = []
		const exporter = {
			export: vi.fn(async() => await new Promise<{status: 'success'; acceptedCount: number}>((resolve, reject) => {
				pending.push({resolve, reject})
			})),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = create(exporter, {
			monotonicClock: {now: () => now}, breakerThreshold: 1, breakerHalfOpenTimeout: 10,
			retryPolicy: {...policy, maxAttempts: 1, attemptTimeoutMs: 0}
		})

		const openingFailure = resilient.export([span])
		const staleSuccess = resilient.export([span])
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		pending[0]!.reject(new Error('offline'))
		await expect(openingFailure).resolves.toMatchObject({status: 'retryable'})

		now = 10
		const halfOpenProbe = resilient.export([span])
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(3))
		pending[1]!.resolve({status: 'success', acceptedCount: 1})
		await expect(staleSuccess).resolves.toMatchObject({status: 'success'})

		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable'})
		expect(exporter.export).toHaveBeenCalledTimes(3)

		pending[2]!.resolve({status: 'success', acceptedCount: 1})
		await expect(halfOpenProbe).resolves.toMatchObject({status: 'success'})
		const afterProbe = resilient.export([span])
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(4))
		pending[3]!.resolve({status: 'success', acceptedCount: 1})
		await expect(afterProbe).resolves.toMatchObject({status: 'success'})
	})

	it('coalesces successful shutdown calls', async() => {
		const exporter = {export: vi.fn(), shutdown: vi.fn(async() => undefined)}
		const resilient = create(exporter)
		await Promise.all([resilient.shutdown(), resilient.shutdown()])
		await resilient.shutdown()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('does not duplicate an indeterminate exporter shutdown after a timeout', async() => {
		vi.useFakeTimers()
		try {
			let release!: () => void
			const shutdownGate = new Promise<void>((resolve) => { release = resolve })
			const exporter = {
				export: vi.fn(),
				shutdown: vi.fn(async() => await shutdownGate)
			}
			const resilient = create(exporter)

			const firstShutdown = expect(resilient.shutdown()).rejects.toThrow(
				'Tracing resilient exporter shutdown timed out'
			)
			await vi.advanceTimersByTimeAsync(10_000)
			await firstShutdown

			const retry = resilient.shutdown()
			await vi.advanceTimersByTimeAsync(0)
			expect(exporter.shutdown).toHaveBeenCalledOnce()
			release()
			await retry
			expect(exporter.shutdown).toHaveBeenCalledOnce()
		} finally { vi.useRealTimers() }
	})

	it('lets exporter shutdown cancel a timed-out physical export before waiting for settlement', async() => {
		let release!: (result: {status: 'success'; acceptedCount: number}) => void
		const physical = new Promise<{status: 'success'; acceptedCount: number}>((resolve) => { release = resolve })
		const exporter = {
			export: vi.fn(async() => await physical),
			shutdown: vi.fn(async() => { release({status: 'success', acceptedCount: 1}) })
		}
		const resilient = create(exporter, {
			tokenBucketBurst: 1,
			retryPolicy: {...policy, maxAttempts: 2, attemptTimeoutMs: 1}
		})

		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		expect(exporter.export).toHaveBeenCalledOnce()
		const shutdown = resilient.shutdown()
		await shutdown
		expect(exporter.shutdown).toHaveBeenCalledOnce()
		await expect(resilient.export([span])).resolves.toMatchObject({status: 'permanent-failure', acceptedCount: 0})
		expect(exporter.export).toHaveBeenCalledOnce()
	})

	it('never retries a timed-out physical export concurrently even when capacity allows it', async() => {
		let release!: (result: {status: 'success'; acceptedCount: number}) => void
		const physical = new Promise<{status: 'success'; acceptedCount: number}>((resolve) => { release = resolve })
		const exporter = {
			export: vi.fn(async() => await physical),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = create(exporter, {
			tokenBucketBurst: 100,
			retryPolicy: {...policy, maxAttempts: 3, attemptTimeoutMs: 1}
		})

		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		expect(exporter.export).toHaveBeenCalledOnce()
		release({status: 'success', acceptedCount: 1})
		await resilient.shutdown()
	})

	it('bounds resilient exporter flush when a physical export never settles', async() => {
		vi.useFakeTimers()
		try {
			const exporter = {
				export: vi.fn(async() => await new Promise<never>(() => undefined)),
				shutdown: vi.fn(async() => undefined)
			}
			const resilient = create(exporter, {
				retryPolicy: {...policy, attemptTimeoutMs: 0}
			})
			void resilient.export([span])
			await vi.advanceTimersByTimeAsync(0)

			const flushing = expect(resilient.flush?.()).rejects.toThrow('Tracing resilient exporter flush timed out')
			await vi.advanceTimersByTimeAsync(10_000)
			await flushing
		} finally { vi.useRealTimers() }
	})

	it('never starts a retry after shutdown completes during backoff', async() => {
		vi.useFakeTimers()
		try {
			const exporter = {
				export: vi.fn()
					.mockResolvedValueOnce({status: 'retryable', acceptedCount: 0, error: new Error('offline')})
					.mockResolvedValueOnce({status: 'success', acceptedCount: 1}),
				shutdown: vi.fn(async() => undefined)
			}
			const resilient = create(exporter, {
				retryPolicy: {...policy, baseDelayMs: 100, maxDelayMs: 100, attemptTimeoutMs: 0}
			})

			const pendingExport = resilient.export([span])
			await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
			await resilient.shutdown()
			await vi.advanceTimersByTimeAsync(100)

			await expect(pendingExport).resolves.toMatchObject({
				status: 'permanent-failure', acceptedCount: 0
			})
			expect(exporter.export).toHaveBeenCalledOnce()
			expect(exporter.shutdown).toHaveBeenCalledOnce()
		} finally { vi.useRealTimers() }
	})

	it('interrupts retry backoff for shutdown drain while admitting one final first attempt', async() => {
		const exporter = {
			export: vi.fn(async() => ({status: 'retryable' as const, acceptedCount: 0, error: new Error('offline')})),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = create(exporter, {
			retryPolicy: {
				...policy,
				maxAttempts: 10,
				baseDelayMs: 2_147_483_647,
				maxDelayMs: 2_147_483_647,
				attemptTimeoutMs: 0
			}
		})

		const active = resilient.export([span])
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		resilient.prepareShutdown?.()
		await expect(active).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		expect(exporter.export).toHaveBeenCalledOnce()

		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		expect(exporter.export).toHaveBeenCalledTimes(2)
		await resilient.shutdown()
	})

	it('releases a cancelled half-open probe when shutdown fails and admission reopens', async() => {
		vi.useFakeTimers()
		try {
			let now = 0
			let rejectShutdown!: (error: Error) => void
			const shutdownGate = new Promise<void>((_resolve, reject) => { rejectShutdown = reject })
			const exporter = {
				export: vi.fn()
					.mockRejectedValueOnce(new Error('offline'))
					.mockRejectedValueOnce(new Error('still offline'))
					.mockResolvedValueOnce({status: 'retryable', acceptedCount: 0, error: new Error('probe failed')})
					.mockResolvedValueOnce({status: 'success', acceptedCount: 1}),
				shutdown: vi.fn(async() => await shutdownGate)
			}
			const resilient = create(exporter, {
				monotonicClock: {now: () => now}, breakerThreshold: 1, breakerHalfOpenTimeout: 10,
				retryPolicy: {...policy, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100, attemptTimeoutMs: 0}
			})

			const initialExport = resilient.export([span])
			await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
			await vi.advanceTimersByTimeAsync(100)
			await expect(initialExport).resolves.toMatchObject({status: 'retryable'})
			now = 10
			const halfOpenExport = resilient.export([span])
			await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(3))
			const shutdown = resilient.shutdown()
			await vi.advanceTimersByTimeAsync(100)
			await expect(halfOpenExport).resolves.toMatchObject({status: 'permanent-failure'})

			rejectShutdown(new Error('shutdown failed'))
			await expect(shutdown).rejects.toThrow('shutdown failed')
			await expect(resilient.export([span])).resolves.toMatchObject({status: 'success'})
			expect(exporter.export).toHaveBeenCalledTimes(4)
		} finally { vi.useRealTimers() }
	})

	it('snapshots retry policy instead of retaining caller-owned configuration', async() => {
		const mutablePolicy = {...policy}
		const exporter = {
			export: vi.fn(async() => ({status: 'retryable' as const, acceptedCount: 0, error: new Error('offline')})),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = createResilientExporter({
			exporter, retryPolicy: mutablePolicy, tokenBucketRate: 100, tokenBucketBurst: 100,
			breakerThreshold: 10, breakerHalfOpenTimeout: 100, clock: createFixedClock(0),
			monotonicClock: {now: () => 0}
		})
		mutablePolicy.maxAttempts = 10

		await expect(resilient.export([span])).resolves.toMatchObject({status: 'retryable'})
		expect(exporter.export).toHaveBeenCalledTimes(2)
	})

	it('does not use unbounded instanceof checks for hostile exporter rejections', async() => {
		let prototypeReads = 0
		const report = vi.fn()
		let hostile!: object
		hostile = new Proxy({}, {
			getPrototypeOf: () => {
				prototypeReads++
				if (prototypeReads > 100) throw new Error('unbounded prototype traversal')
				return hostile
			}
		})
		const resilient = create({
			export: vi.fn(async() => await Promise.reject(hostile)),
			shutdown: vi.fn(async() => undefined)
		}, {
			retryPolicy: {...policy, maxAttempts: 1, attemptTimeoutMs: 0},
			errors: {report}
		})

		await expect(resilient.export([span])).resolves.toMatchObject({
			status: 'retryable', acceptedCount: 0, error: expect.any(Error)
		})
		expect(report).toHaveBeenCalledOnce()
		expect(prototypeReads).toBeLessThanOrEqual(68)
	})
})
