import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import type {MetricExporterPort} from '../../src/types'
import {
	createMetricKey,
	estimateBatchBytes,
	estimateMetricRecordSize,
	formatErrorMessage,
	getExporterName,
	retryWithBackoff
} from '../../src/utils/helpers'

describe('helpers', () => {

	describe('getExporterName', () => {

		it('should return constructor name', () => {

			class TestExporter implements MetricExporterPort {
				async export() {}
				async flush() {}
				async shutdown() {}
			}

			const exporter = new TestExporter()
			expect(getExporterName(exporter)).toBe('TestExporter')
		})

		it('should return constructor name or Object for plain objects', () => {

			const exporter = {
				export: async() => {},
				flush: async() => {},
				shutdown: async() => {}
			}

			// Plain objects have constructor.name === 'Object'
			const name = getExporterName(exporter as MetricExporterPort)
			expect(['Object', 'unknown']).toContain(name)
		})

		it('does not execute an exporter-owned constructor getter', () => {
			const getter = vi.fn(() => class SecretExporter {})
			const exporter = Object.defineProperty({
				export: async() => {}, flush: async() => {}, shutdown: async() => {}
			}, 'constructor', {get: getter})

			expect(getExporterName(exporter as MetricExporterPort)).toBe('Object')
			expect(getter).not.toHaveBeenCalled()
		})

		it('falls back safely for nameless and hostile exporter objects', () => {
			expect(getExporterName(Object.create(null) as MetricExporterPort)).toBe('unknown')
			expect(getExporterName(Object.create({}) as MetricExporterPort)).toBe('unknown')
			expect(getExporterName(Object.create({constructor: 1}) as MetricExporterPort)).toBe('unknown')
			const hostile = new Proxy({}, {
				getPrototypeOf: () => { throw new Error('hostile prototype') }
			})
			expect(getExporterName(hostile as MetricExporterPort)).toBe('unknown')
			class NamelessExporter {}
			Object.defineProperty(NamelessExporter, 'name', {value: ''})
			expect(getExporterName(new NamelessExporter() as MetricExporterPort)).toBe('unknown')
			class LongNamedExporter {}
			Object.defineProperty(LongNamedExporter, 'name', {value: 'x'.repeat(129)})
			expect(getExporterName(new LongNamedExporter() as MetricExporterPort)).toBe('unknown')
		})
	})

	describe('formatErrorMessage', () => {

		it('should return message without context', () => {

			expect(formatErrorMessage('Test error')).toBe('Test error')
		})

		it('should format message with context', () => {

			expect(formatErrorMessage('Test error', {
				operation: 'export',
				exporter: 'test'
			})).toBe('Test error (operation=export, exporter=test)')
		})

		it('should handle empty context', () => {

			expect(formatErrorMessage('Test error', {})).toBe('Test error')
		})
	})

	describe('createMetricKey', () => {

		it('should create key from name and labels', () => {

			const key = createMetricKey('test_metric', {env: 'test', service: 'api'})

			expect(JSON.parse(key)).toEqual([
				'test_metric',
				[
					['env', 'test'],
					['service', 'api']
				]
			])
		})

		it('should sort labels for consistent keys', () => {

			const key1 = createMetricKey('test_metric', {env: 'test', service: 'api'})
			const key2 = createMetricKey('test_metric', {service: 'api', env: 'test'})

			expect(key1).toBe(key2)
		})

		it('should handle empty labels', () => {

			const key = createMetricKey('test_metric', {})

			expect(JSON.parse(key)).toEqual(['test_metric', []])
		})

		it('should not collide when label values contain separators', () => {

			const key1 = createMetricKey('test_metric', {a: 'b,c=d'})
			const key2 = createMetricKey('test_metric', {a: 'b', c: 'd'})

			expect(key1).not.toBe(key2)
		})
	})

	describe('estimateMetricRecordSize', () => {

		it('should estimate size for simple record', () => {

			const size = estimateMetricRecordSize({
				name: 'test_metric',
				labels: {env: 'test'}
			})

			expect(size).toBeGreaterThan(0)
		})

		it('should include exemplar size', () => {

			const sizeWithExemplar = estimateMetricRecordSize({
				name: 'test_metric',
				labels: {env: 'test'},
				exemplar: {
					traceId: 'trace123',
					spanId: 'span456'
				}
			})

			const sizeWithoutExemplar = estimateMetricRecordSize({
				name: 'test_metric',
				labels: {env: 'test'}
			})

			expect(sizeWithExemplar).toBeGreaterThan(sizeWithoutExemplar)
		})

		it('measures metric records using UTF-8 bytes', () => {
			expect(estimateMetricRecordSize({name: '🚀', labels: {x: '😀'}})).toBe(65)
		})

		it('should account for label keys and values', () => {

			const sizeSmall = estimateMetricRecordSize({
				name: 'test',
				labels: {a: 'b'}
			})

			const sizeLarge = estimateMetricRecordSize({
				name: 'test',
				labels: {
					veryLongLabelName: 'veryLongLabelValue',
					anotherVeryLongLabelName: 'anotherVeryLongLabelValue'
				}
			})

			expect(sizeLarge).toBeGreaterThan(sizeSmall)
		})

		it('accounts for every retained metadata and exemplar string', () => {
			const base = estimateMetricRecordSize({name: 'metric', labels: {}})
			const enriched = estimateMetricRecordSize({
				name: 'metric',
				labels: {},
				metadata: {
					description: 'd'.repeat(128), unit: 'milliseconds',
					instrument: 'counter', temporality: 'delta', monotonic: true
				},
				exemplar: {
					traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
					tenantId: 'tenant'.repeat(16), userId: 'user'.repeat(16)
				}
			})

			expect(enriched - base).toBeGreaterThan(300)
		})
	})

	describe('estimateBatchBytes', () => {

		it('should return 0 for empty batch', () => {

			expect(estimateBatchBytes([])).toBe(0)
		})

		it('should sum individual record sizes', () => {

			const batch = [
				{name: 'metric1', labels: {env: 'test'}},
				{name: 'metric2', labels: {env: 'test'}}
			]

			const size = estimateBatchBytes(batch)

			expect(size).toBeGreaterThan(0)
		})

		it('should handle exemplars in batch', () => {

			const batch = [
				{
					name: 'metric1',
					labels: {env: 'test'},
					exemplar: {traceId: 'trace1', spanId: 'span1'}
				},
				{
					name: 'metric2',
					labels: {env: 'test'}
				}
			]

			const size = estimateBatchBytes(batch)

			expect(size).toBeGreaterThan(0)
		})
	})

	describe('retryWithBackoff', () => {
		it('uses the platform timer bound when maxDelayMs is omitted', async() => {
			const operation = vi.fn()
				.mockRejectedValueOnce(new Error('retry'))
				.mockResolvedValue('ok')
			const resultPromise = retryWithBackoff({
				operation,
				config: {maxRetries: 1, baseDelayMs: 1}
			})
			await vi.advanceTimersByTimeAsync(1)
			await expect(resultPromise).resolves.toBe('ok')
		})

		it('rejects invalid direct retry configuration', async() => {
			await expect(retryWithBackoff({
				operation: async() => 'unused', config: {maxRetries: -1, baseDelayMs: 1}
			})).rejects.toThrow('maxRetries')
			await expect(retryWithBackoff({
				operation: async() => 'unused', config: {maxRetries: 0, baseDelayMs: Number.NaN}
			})).rejects.toThrow('baseDelayMs')
			await expect(retryWithBackoff({
				operation: async() => 'unused', config: {maxRetries: 11, baseDelayMs: 1}
			})).rejects.toThrow('between 0 and 10')
		})

		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('should succeed on first attempt', async() => {

			const operation = vi.fn().mockResolvedValue('success')

			const result = await retryWithBackoff({
				operation,
				config: {
					maxRetries: 3,
					baseDelayMs: 10,
					multiplier: 2
				}
			})

			expect(result).toBe('success')
			expect(operation).toHaveBeenCalledTimes(1)
		})

		it('should retry on failure and eventually succeed', async() => {

			let attemptCount = 0
			const operation = vi.fn().mockImplementation(async() => {
				attemptCount++
				if (attemptCount < 3) {
					throw new Error('Temporary failure')
				}
				return 'success'
			})

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 3,
					baseDelayMs: 10,
					multiplier: 2
				}
			})

			// Advance timers to allow retries
			await vi.advanceTimersByTimeAsync(100)
			const result = await promise

			expect(result).toBe('success')
			expect(operation).toHaveBeenCalledTimes(3)
		})

		it('should not retry when shouldRetry returns false', async() => {

			const operation = vi.fn().mockRejectedValue(new Error('Non-retryable error'))
			const shouldRetry = vi.fn().mockReturnValue(false)

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 3,
					baseDelayMs: 10,
					multiplier: 2
				},
				shouldRetry
			})

			// Ensure promise rejection is handled
			promise.catch(() => {
				// Silently catch to prevent unhandled rejection
			})

			await expect(promise).rejects.toThrow('Non-retryable error')
			expect(operation).toHaveBeenCalledTimes(1)
			expect(shouldRetry).toHaveBeenCalled()
		})

		it('does not sleep or emit retry hooks after the final failed attempt', async() => {
			const operation = vi.fn().mockRejectedValue(new Error('Persistent failure'))
			const shouldRetry = vi.fn().mockReturnValue(true)
			const onRetry = vi.fn()
			const onError = vi.fn()

			await expect(retryWithBackoff({
				operation,
				config: {
					maxRetries: 0,
					baseDelayMs: 10,
					multiplier: 2
				},
				shouldRetry,
				onRetry,
				onError
			})).rejects.toThrow('Persistent failure')

			expect(operation).toHaveBeenCalledTimes(1)
			expect(shouldRetry).not.toHaveBeenCalled()
			expect(onRetry).not.toHaveBeenCalled()
			expect(onError).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
		})

		it('should call onError when all retries exhausted', async() => {

			const operation = vi.fn().mockRejectedValue(new Error('Persistent failure'))
			const onError = vi.fn()

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 2,
					baseDelayMs: 10,
					multiplier: 2
				},
				onError
			})

			// Ensure promise rejection is handled
			promise.catch(() => {
				// Silently catch to prevent unhandled rejection
			})

			// Advance timers to allow retries
			await vi.advanceTimersByTimeAsync(100)
			await expect(promise).rejects.toThrow('Persistent failure')

			expect(operation).toHaveBeenCalledTimes(3) // initial + 2 retries
			// onError is called during retries
			// With maxRetries=2, the loop runs for attempt=0,1,2 (3 attempts total)
			// During attempts 0 and 1, canRetry is true, so onError is called with
			// (error, attempt, {retrying: 'true'})
			// When attempt=2, canRetry is false, so the error is thrown immediately
			// without calling onError
			// After the loop completes (if it doesn't throw), onError is called with
			// (lastError, config.maxRetries, {retriesExhausted: 'true'})
			// However, when attempt=2 throws, the function exits before the exhausted call
			// So we only get onError calls for attempts 0 and 1
			expect(onError).toHaveBeenCalled()
			// Verify that onError was called during retries
			const allCalls = onError.mock.calls
			expect(allCalls.length).toBeGreaterThanOrEqual(2) // At least 2 retry calls
			// All calls should have retrying: 'true' in context
			allCalls.forEach((call) => {
				expect(call[2]).toHaveProperty('retrying', 'true')
			})
		})

		it('should call onError during retries', async() => {

			let attemptCount = 0
			const operation = vi.fn().mockImplementation(async() => {
				attemptCount++
				if (attemptCount < 2) {
					throw new Error('Temporary failure')
				}
				return 'success'
			})
			const onError = vi.fn()

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 3,
					baseDelayMs: 10,
					multiplier: 2
				},
				onError
			})

			// Advance timers to allow retries
			await vi.advanceTimersByTimeAsync(100)
			await promise

			expect(onError).toHaveBeenCalledWith(
				expect.any(Error),
				expect.any(Number),
				expect.objectContaining({retrying: 'true'})
			)
		})

		it('should call onRetry callback before retrying', async() => {

			let attemptCount = 0
			const operation = vi.fn().mockImplementation(async() => {
				attemptCount++
				if (attemptCount < 2) {
					throw new Error('Temporary failure')
				}
				return 'success'
			})
			const onRetry = vi.fn()

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 3,
					baseDelayMs: 10,
					multiplier: 2
				},
				onRetry
			})

			// Advance timers to allow retries
			await vi.advanceTimersByTimeAsync(100)
			await promise

			expect(onRetry).toHaveBeenCalledWith(0, expect.any(Error))
		})

		it('keeps awaited retry backoff timers referenced', async() => {
			vi.useRealTimers()
			const originalSetTimeout = globalThis.setTimeout
			const unref = vi.fn()
			const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
				const timer = originalSetTimeout(...args)
				if (timer && typeof timer === 'object') {
					Object.assign(timer, {unref})
				}
				return timer
			}) as typeof setTimeout)
			const operation = vi.fn()
				.mockRejectedValueOnce(new Error('Temporary failure'))
				.mockResolvedValueOnce('success')

			try {
				await expect(retryWithBackoff({
					operation,
					config: {
						maxRetries: 1,
						baseDelayMs: 1,
						maxDelayMs: 1,
						multiplier: 1
					}
				})).resolves.toBe('success')
			} finally {
				setTimeoutSpy.mockRestore()
			}

			expect(unref).not.toHaveBeenCalled()
		})

		it('should retry transient HTTP 429 errors', async() => {

			let attemptCount = 0
			const operation = vi.fn().mockImplementation(async() => {
				attemptCount++
				if (attemptCount < 2) {
					throw new Error('429 Too Many Requests')
				}
				return 'success'
			})

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 3,
					baseDelayMs: 10,
					multiplier: 2
				}
			})

			// Advance timers to allow retries
			await vi.advanceTimersByTimeAsync(100)
			await promise

			expect(operation).toHaveBeenCalledTimes(2)
		})

		it('keeps retry observer failures isolated and reports exhaustion', async() => {
			vi.useRealTimers()
			const error = new Error('always fails')
			await expect(retryWithBackoff({
				operation: async() => { throw error },
				config: {maxRetries: 1, baseDelayMs: 1, jitter: true},
				onRetry: () => { throw new Error('observer failure') },
				onError: () => { throw new Error('diagnostic failure') }
			})).rejects.toThrow('always fails')
		})

		it('does not execute retry metadata getters on thrown values', async() => {
			const getter = vi.fn(() => 10_000)
			const hostile = Object.defineProperty({}, 'retryAfterMs', {get: getter})
			const operation = vi.fn()
				.mockRejectedValueOnce(hostile)
				.mockResolvedValueOnce('success')
			const promise = retryWithBackoff({
				operation,
				config: {maxRetries: 1, baseDelayMs: 1}
			})

			await vi.advanceTimersByTimeAsync(1)
			await expect(promise).resolves.toBe('success')
			expect(getter).not.toHaveBeenCalled()
		})

		it('handles primitive and proxy retry failures without inspecting traps', async() => {
			const hostile = new Proxy({}, {
				getOwnPropertyDescriptor: () => { throw new Error('metadata trap') }
			})
			const operation = vi.fn()
				.mockRejectedValueOnce(null)
				.mockRejectedValueOnce(hostile)
				.mockResolvedValueOnce('success')
			const promise = retryWithBackoff({
				operation,
				config: {maxRetries: 2, baseDelayMs: 1}
			})

			await vi.advanceTimersByTimeAsync(3)
			await expect(promise).resolves.toBe('success')
		})

		it('should cap delay at maxDelayMs', async() => {

			const operation = vi.fn().mockRejectedValue(new Error('Failure'))

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 5,
					baseDelayMs: 100,
					maxDelayMs: 200, // Cap at 200ms
					multiplier: 2
				}
			})

			// Ensure promise rejection is handled
			promise.catch(() => {
				// Silently catch to prevent unhandled rejection
			})

			// Advance timers - delays should be capped at 200ms
			await vi.advanceTimersByTimeAsync(1000)
			await expect(promise).rejects.toThrow()

			// Verify operation was called multiple times (retries happened)
			expect(operation).toHaveBeenCalledTimes(6) // initial + 5 retries
		})

		it('should apply jitter when enabled', async() => {

			const operation = vi.fn().mockRejectedValue(new Error('Failure'))

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 1,
					baseDelayMs: 100,
					multiplier: 2,
					jitter: true,
					jitterFactor: 0.3
				}
			})

			// Ensure promise rejection is handled
			promise.catch(() => {
				// Silently catch to prevent unhandled rejection
			})

			// Advance timers
			await vi.advanceTimersByTimeAsync(500)
			await expect(promise).rejects.toThrow()

			expect(operation).toHaveBeenCalledTimes(2)
		})

		it('should handle shouldRetry callback that checks attempt number', async() => {

			const operation = vi.fn().mockRejectedValue(new Error('Failure'))
			const shouldRetry = vi.fn().mockImplementation((_error, attempt) => attempt < 1)

			const promise = retryWithBackoff({
				operation,
				config: {
					maxRetries: 3,
					baseDelayMs: 10,
					multiplier: 2
				},
				shouldRetry
			})

			// Ensure promise rejection is handled
			promise.catch(() => {
				// Silently catch to prevent unhandled rejection
			})

			// Advance timers
			await vi.advanceTimersByTimeAsync(100)
			await expect(promise).rejects.toThrow()

			// Should only retry once (attempt 0), then shouldRetry returns false
			expect(operation).toHaveBeenCalledTimes(2) // initial + 1 retry
			expect(shouldRetry).toHaveBeenCalled()
		})
	})
})
