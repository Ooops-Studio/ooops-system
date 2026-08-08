import {describe, expect, it, vi} from 'vitest'

import {ExporterManager} from '../../src/core/exporter-manager'
import type {MetricExporterPort, MetricRecord} from '../../src/types'

const records: MetricRecord[] = [{name: 'test_metric', type: 'counter', value: 1, labels: {}, timestamp: 1}]

describe('ExporterManager', () => {
	it('rejects exporter fan-out above the hard ceiling', () => {
		expect(() => new ExporterManager({
			exporters: Array.from({length: 33}, () => ({export: vi.fn()}))
		})).toThrow('at most 32')
	})

	it('rejects sparse, accessor-backed, and oversized metric batches without invoking accessors', async() => {
		const exporter = {export: vi.fn()}
		const manager = new ExporterManager({exporters: [exporter]})
		await expect(manager.export(new Array(1) as never)).rejects.toThrow('bounded dense array')
		const getter = vi.fn(() => ({name: 'secret', type: 'counter', value: 1, labels: {}, timestamp: 1}))
		const batch = Object.defineProperty([], '0', {enumerable: true, get: getter})
		Object.defineProperty(batch, 'length', {value: 1})
		await expect(manager.export(batch as never)).rejects.toThrow('bounded dense array')
		expect(getter).not.toHaveBeenCalled()
		await expect(manager.export([{
			name: 'metric', type: 'counter', value: 1, timestamp: 1,
			labels: Object.fromEntries(Array.from({length: 257}, (_, index) => [`label_${index}`, 'value']))
		}])).rejects.toThrow('bounded string data fields')
		const largeLabels = Object.fromEntries(Array.from(
			{length: 256},
			(_, index) => [`label_${index}`, 'x'.repeat(4_096)]
		))
		await expect(manager.export(Array.from({length: 17}, (_, index) => ({
			name: `large_metric_${index}`, type: 'counter' as const, value: 1,
			labels: largeLabels, timestamp: 1
		})))).rejects.toThrow('16777216-byte snapshot limit')
	})
	it('exports to all configured exporters and flushes them', async() => {
		const first: MetricExporterPort = {export: vi.fn(), flush: vi.fn(), shutdown: vi.fn()}
		const second: MetricExporterPort = {export: vi.fn(), flush: vi.fn(), shutdown: vi.fn()}
		const manager = new ExporterManager({exporters: [first, second]})
		await manager.export(records)
		await manager.flush()
		expect(first.export).toHaveBeenCalledWith(records)
		expect(second.export).toHaveBeenCalledWith(records)
		expect(first.flush).toHaveBeenCalled()
	})

	it('keeps a complete histogram family in one default delivery batch', async() => {
		const metadata = {instrument: 'histogram' as const, temporality: 'cumulative' as const}
		const histogram: MetricRecord[] = [
			{name: 'latency_sum', type: 'gauge', value: 1, labels: {}, timestamp: 1, metadata},
			{name: 'latency_count', type: 'counter', value: 1, labels: {}, timestamp: 1, metadata},
			{name: 'latency_bucket', type: 'counter', value: 1, labels: {le: '1'}, timestamp: 1, metadata},
			{name: 'latency_bucket', type: 'counter', value: 0, labels: {le: '+Inf'}, timestamp: 1, metadata}
		]
		const exportBatch = vi.fn(async(batch: ReadonlyArray<MetricRecord>) => {
			const parts = batch.filter(({metadata: item}) => item?.instrument === 'histogram')
			if (parts.length > 0 && parts.length !== histogram.length) {
				throw Object.assign(new Error('split histogram family'), {retryable: false})
			}
		})
		const manager = new ExporterManager({exporters: [{export: exportBatch}]})
		const counters = Array.from({length: 9_999}, (_, index): MetricRecord => ({
			name: 'counter', type: 'counter', value: 1, labels: {id: String(index)}, timestamp: 1
		}))

		await expect(manager.export([...counters, ...histogram])).resolves.toBeUndefined()
		expect(exportBatch).toHaveBeenCalledOnce()
	})

	it('does not finalize an accepted multi-chunk export between chunks', async() => {
		const firstChunk = Promise.withResolvers<void>()
		const secondChunk = Promise.withResolvers<void>()
		const exporter: MetricExporterPort = {
			export: vi.fn()
				.mockImplementationOnce(async() => await firstChunk.promise)
				.mockImplementationOnce(async() => await secondChunk.promise),
			flush: vi.fn()
		}
		const manager = new ExporterManager({exporters: [exporter], maxBatchSize: 1})
		const exporting = manager.export([records[0]!, {...records[0]!, name: 'second_metric'}])
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(1))
		const flushing = manager.flush()

		firstChunk.resolve()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		expect(exporter.flush).not.toHaveBeenCalled()

		secondChunk.resolve()
		await exporting
		await flushing
		expect(exporter.flush).toHaveBeenCalledOnce()
	})

	it('does not finalize an export whose callback synchronously re-enters shutdown', async() => {
		const exportGate = Promise.withResolvers<void>()
		let manager: ExporterManager
		let shuttingDown: Promise<void> | undefined
		const exporter: MetricExporterPort = {
			export: vi.fn(async() => {
				shuttingDown = manager.shutdown()
				await exportGate.promise
			}),
			flush: vi.fn(),
			shutdown: vi.fn()
		}
		manager = new ExporterManager({exporters: [exporter]})

		const exporting = manager.export(records)
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		await Promise.resolve()

		expect(exporter.flush).not.toHaveBeenCalled()
		expect(exporter.shutdown).not.toHaveBeenCalled()

		exportGate.resolve()
		await exporting
		await shuttingDown
		expect(exporter.flush).toHaveBeenCalledOnce()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
		expect(manager.getTelemetry().state).toBe('closed')
	})

	it('coalesces flush into an active shutdown lifecycle sequence', async() => {
		const flushGate = Promise.withResolvers<void>()
		const shutdownGate = Promise.withResolvers<void>()
		const exporter: MetricExporterPort = {
			export: vi.fn(),
			flush: vi.fn(async() => await flushGate.promise),
			shutdown: vi.fn(async() => await shutdownGate.promise)
		}
		const manager = new ExporterManager({exporters: [exporter]})

		const shuttingDown = manager.shutdown()
		await vi.waitFor(() => expect(exporter.flush).toHaveBeenCalledOnce())
		const flushing = manager.flush()
		await Promise.resolve()
		expect(exporter.flush).toHaveBeenCalledOnce()

		flushGate.resolve()
		await vi.waitFor(() => expect(exporter.shutdown).toHaveBeenCalledOnce())
		expect(exporter.flush).toHaveBeenCalledOnce()
		shutdownGate.resolve()
		await Promise.all([shuttingDown, flushing])
	})

	it('does not duplicate an active batch when a different batch is exported concurrently', async() => {
		const firstDelivery = Promise.withResolvers<void>()
		const first = records[0]!
		const second = {...first, name: 'second_metric'}
		const exporter: MetricExporterPort = {
			export: vi.fn().mockImplementationOnce(async() => await firstDelivery.promise)
		}
		const manager = new ExporterManager({exporters: [exporter], maxConcurrency: 2})

		const firstExport = manager.export([first])
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		const secondExport = manager.export([second])
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		firstDelivery.resolve()

		await Promise.all([firstExport, secondExport])
		expect(exporter.export).toHaveBeenNthCalledWith(1, [first])
		expect(exporter.export).toHaveBeenNthCalledWith(2, [second])
	})

	it('does not drain a retained failed batch on behalf of a different batch', async() => {
		const first = records[0]!
		const second = {...first, name: 'second_metric'}
		const committed = vi.fn().mockResolvedValue(undefined)
		const failing = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('temporary'), {retryable: false}))
			.mockResolvedValue(undefined)
		const manager = new ExporterManager({
			exporters: [{export: committed}, {export: failing}],
			retryConfig: {maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1}
		})

		await expect(manager.export([first])).rejects.toThrow('temporary')
		await expect(manager.export([second])).resolves.toBeUndefined()

		expect(committed).toHaveBeenNthCalledWith(1, [first])
		expect(committed).toHaveBeenNthCalledWith(2, [second])
		expect(failing).toHaveBeenNthCalledWith(1, [first])
		expect(failing).toHaveBeenNthCalledWith(2, [second])
		expect(manager.getTelemetry().queueSize).toBe(1)

		await expect(manager.export([first])).resolves.toBeUndefined()
		expect(committed).toHaveBeenCalledTimes(2)
		expect(failing).toHaveBeenNthCalledWith(3, [first])
	})

	it('single-flights concurrent retries of the same retained delivery', async() => {
		const retryDelivery = Promise.withResolvers<void>()
		const exporter: MetricExporterPort = {
			export: vi.fn()
				.mockRejectedValueOnce(Object.assign(new Error('temporary'), {retryable: false}))
				.mockImplementationOnce(async() => await retryDelivery.promise)
		}
		const manager = new ExporterManager({exporters: [exporter], maxConcurrency: 2})

		await expect(manager.export(records)).rejects.toThrow('temporary')
		const firstRetry = manager.export(records)
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		const concurrentRetry = manager.export(records)
		await Promise.resolve()

		expect(exporter.export).toHaveBeenCalledTimes(2)
		retryDelivery.resolve()
		await Promise.all([firstRetry, concurrentRetry])
		expect(exporter.export).toHaveBeenCalledTimes(2)
	})

	it('isolates exporter batches from mutations by another exporter', async() => {
		const first: MetricExporterPort = {export: vi.fn((batch) => {
			const mutable = batch[0] as MetricRecord
			mutable.value = 999
			mutable.labels.environment = 'mutated'
		})}
		const second: MetricExporterPort = {export: vi.fn()}
		const manager = new ExporterManager({exporters: [first, second]})
		const input: MetricRecord[] = [{
			name: 'isolated_metric', type: 'counter', value: 1,
			labels: {environment: 'production'}, timestamp: 1
		}]

		await manager.export(input)

		expect(second.export).toHaveBeenCalledWith([
			expect.objectContaining({value: 1, labels: {environment: 'production'}})
		])
		expect(input[0]).toMatchObject({value: 1, labels: {environment: 'production'}})
	})

	it('retries transient exporter failures and reports health', async() => {
		const exporter: MetricExporterPort = {
			export: vi.fn().mockRejectedValueOnce(Object.assign(new Error('temporary'), {retryable: true})).mockResolvedValue(undefined)
		}
		const manager = new ExporterManager({
			exporters: [exporter],
			retryConfig: {maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1}
		})
		await manager.export(records)
		expect(exporter.export).toHaveBeenCalledTimes(2)
		expect(manager.getTelemetry()).toMatchObject({sinkState: 'healthy'})
	})

	it('does not expose arbitrary exporter error text through status', async() => {
		const exporter: MetricExporterPort = {
			export: vi.fn().mockRejectedValue(new Error('Authorization: Bearer super-secret-token'))
		}
		const manager = new ExporterManager({exporters: [exporter]})

		await expect(manager.export(records)).rejects.toThrow('super-secret-token')

		expect(manager.getTelemetry()).toMatchObject({
			sinkState: 'unhealthy', lastFailureCode: 'METRICS_EXPORT_FAILURE'
		})
		expect(JSON.stringify(manager.getTelemetry())).not.toContain('super-secret-token')
	})

	it('does not expose exporter finalization errors through logger diagnostics', async() => {
		const logger = {
			level: 'error' as const,
			trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
			context: vi.fn().mockReturnThis()
		}
		const exporter: MetricExporterPort = {
			export: vi.fn().mockResolvedValue(undefined),
			shutdown: vi.fn().mockRejectedValue(new Error('Authorization: Bearer finalization-secret'))
		}
		const manager = new ExporterManager({exporters: [exporter], logger})

		await expect(manager.shutdown()).rejects.toThrow('Metrics exporter shutdown failed')

		expect(logger.error).toHaveBeenCalledWith('metrics.exporter_finalization_failed', {
			exporter: 'Object', operation: 'shutdown', error: 'metrics_exporter_shutdown_failed'
		})
		expect(JSON.stringify(logger.error.mock.calls)).not.toContain('finalization-secret')
	})

	it('uses a fresh immutable snapshot for each retry attempt', async() => {
		const observed: MetricRecord[] = []
		const exporter: MetricExporterPort = {export: vi.fn(async(batch) => {
			observed.push({...batch[0]!, labels: {...batch[0]!.labels}})
			if (observed.length === 1) {
				batch[0]!.value = 999
				batch[0]!.labels.environment = 'mutated'
				throw Object.assign(new Error('temporary'), {retryable: true})
			}
		})}
		const manager = new ExporterManager({
			exporters: [exporter],
			retryConfig: {maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1}
		})

		await manager.export([{
			name: 'retry_metric', type: 'counter', value: 1,
			labels: {environment: 'production'}, timestamp: 1
		}])

		expect(observed).toEqual([
			expect.objectContaining({value: 1, labels: {environment: 'production'}}),
			expect.objectContaining({value: 1, labels: {environment: 'production'}})
		])
	})

	it('retries only the failed subset from a partial export', async() => {
		const first = records[0]!
		const second: MetricRecord = {...first, name: 'second_metric'}
		const exporter: MetricExporterPort = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'partial', failedRecords: [second]})
				.mockResolvedValueOnce({status: 'success'})
		}
		const manager = new ExporterManager({
			exporters: [exporter],
			retryConfig: {maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1}
		})

		await manager.export([first, second])

		expect(exporter.export).toHaveBeenNthCalledWith(1, [first, second])
		expect(exporter.export).toHaveBeenNthCalledWith(2, [second])
		expect(manager.getTelemetry()).toMatchObject({sinkState: 'healthy'})
	})

	it('retains only the undelivered subset after a partial retry is exhausted', async() => {
		const first = records[0]!
		const second: MetricRecord = {...first, name: 'second_metric'}
		const exporter: MetricExporterPort = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'partial', failedRecords: [second]})
				.mockRejectedValueOnce(Object.assign(new Error('still unavailable'), {retryable: true}))
				.mockResolvedValueOnce({status: 'success'})
		}
		const manager = new ExporterManager({
			exporters: [exporter],
			retryConfig: {maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1}
		})

		await expect(manager.export([first, second])).rejects.toThrow('still unavailable')
		await expect(manager.export([first, second])).resolves.toBeUndefined()

		expect(exporter.export).toHaveBeenNthCalledWith(1, [first, second])
		expect(exporter.export).toHaveBeenNthCalledWith(2, [second])
		expect(exporter.export).toHaveBeenNthCalledWith(3, [second])
	})

	it('validates bounded exporter configuration', () => {
		const exporter: MetricExporterPort = {export: vi.fn()}
		expect(() => new ExporterManager(null as never)).toThrow('options must be an object')
		expect(() => new ExporterManager({exporters: null as never})).toThrow('must be an array')
		expect(() => new ExporterManager({exporters: [{} as never]})).toThrow('provide export')
		expect(() => new ExporterManager({exporters: [{export: vi.fn(), flush: true as never}]}))
			.toThrow('flush must be a function')
		expect(() => new ExporterManager({exporters: [{export: vi.fn(), shutdown: true as never}]}))
			.toThrow('shutdown must be a function')
		expect(() => new ExporterManager({exporters: [exporter], onRetry: true as never})).toThrow('onRetry')
		expect(() => new ExporterManager({exporters: [exporter], onExportFailure: true as never})).toThrow('onExportFailure')
		expect(() => new ExporterManager({exporters: [exporter], circuitBreaker: null as never})).toThrow('circuitBreaker')
		expect(() => new ExporterManager({exporters: [exporter], monotonicClock: {} as never})).toThrow('monotonic clock')
		expect(() => new ExporterManager({exporters: [exporter], operationTimeoutMs: Number.NaN})).toThrow('operationTimeoutMs')
		expect(() => new ExporterManager({exporters: [exporter], operationTimeoutMs: 1.5})).toThrow('operationTimeoutMs')
		expect(() => new ExporterManager({exporters: [exporter], operationTimeoutMs: 2_147_483_648})).toThrow('operationTimeoutMs')
		expect(() => new ExporterManager({exporters: [exporter], circuitBreaker: {failureThreshold: 0, openMs: 1}}))
			.toThrow('failureThreshold')
		expect(() => new ExporterManager({exporters: [exporter], circuitBreaker: {failureThreshold: 1, openMs: 0}}))
			.toThrow('openMs')
		expect(() => new ExporterManager({exporters: [exporter, exporter]})).toThrow('must be unique')
		expect(() => new ExporterManager({exporters: [exporter], maxBatchSize: 0})).toThrow('maxBatchSize')
		expect(() => new ExporterManager({exporters: [exporter], maxQueuedBatches: 0})).toThrow('maxQueuedBatches')
		expect(() => new ExporterManager({exporters: [exporter], maxBatchSize: 100_001})).toThrow('maxBatchSize')
		expect(() => new ExporterManager({exporters: [exporter], maxBatchBytes: 16 * 1024 * 1024 + 1})).toThrow('maxBatchBytes')
		expect(() => new ExporterManager({exporters: [exporter], maxConcurrency: 65})).toThrow('maxConcurrency')
		expect(() => new ExporterManager({exporters: [exporter], maxQueuedBatches: 100_001})).toThrow('maxQueuedBatches')
		expect(() => new ExporterManager({exporters: [exporter], maxQueuedBytes: 64 * 1024 * 1024 + 1})).toThrow('maxQueuedBytes')
		expect(() => new ExporterManager({
			exporters: [exporter],
			retryConfig: {maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: Number.NaN}
		})).toThrow('multiplier')
		const exporters = vi.fn(() => [exporter])
		const accessorOptions = Object.defineProperty({}, 'exporters', {enumerable: true, get: exporters})
		expect(() => new ExporterManager(accessorOptions as never)).toThrow('stable known data fields')
		expect(exporters).not.toHaveBeenCalled()
		const maxRetries = vi.fn(() => 1)
		const accessorRetry = Object.defineProperty({}, 'maxRetries', {enumerable: true, get: maxRetries})
		expect(() => new ExporterManager({exporters: [exporter], retryConfig: accessorRetry as never}))
			.toThrow('retryConfig must expose stable')
		expect(maxRetries).not.toHaveBeenCalled()
	})

	it('snapshots exporter methods without invoking accessors and preserves their receiver', async() => {
		const exportOriginal = vi.fn(function(this: {marker: string}) {
			expect(this.marker).toBe('original')
		})
		const flushOriginal = vi.fn(function(this: {marker: string}) {
			expect(this.marker).toBe('original')
		})
		const shutdownOriginal = vi.fn(function(this: {marker: string}) {
			expect(this.marker).toBe('original')
		})
		const exporter = {
			marker: 'original', export: exportOriginal, flush: flushOriginal, shutdown: shutdownOriginal
		}
		const manager = new ExporterManager({exporters: [exporter]})
		const replacement = vi.fn()
		exporter.export = replacement
		exporter.flush = replacement
		exporter.shutdown = replacement

		await manager.export(records)
		await manager.flush()
		await manager.shutdown()

		expect(exportOriginal).toHaveBeenCalledOnce()
		expect(flushOriginal).toHaveBeenCalled()
		expect(shutdownOriginal).toHaveBeenCalledOnce()
		expect(replacement).not.toHaveBeenCalled()
		expect(manager.getTelemetry()).toMatchObject({state: 'closed', sinkState: 'closed'})

		const getter = vi.fn(() => exportOriginal)
		const accessorExporter = Object.create(null) as MetricExporterPort
		Object.defineProperty(accessorExporter, 'export', {enumerable: true, get: getter})
		expect(() => new ExporterManager({exporters: [accessorExporter]})).toThrow('provide export')
		expect(getter).not.toHaveBeenCalled()
	})

	it('does not inherit optional capabilities added to the original prototype later', async() => {
		class MutablePrototypeExporter {
			export = vi.fn()
		}
		const exporter = new MutablePrototypeExporter()
		const manager = new ExporterManager({exporters: [exporter]})
		const lateFlush = vi.fn()
		Object.defineProperty(MutablePrototypeExporter.prototype, 'flush', {
			configurable: true,
			value: lateFlush
		})
		try {
			await manager.flush()
			expect(lateFlush).not.toHaveBeenCalled()
		} finally {
			delete (MutablePrototypeExporter.prototype as {flush?: unknown}).flush
		}
	})

	it('snapshots mutable retry and circuit breaker configuration', async() => {
		const retryConfig = {maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1}
		const circuitBreaker = {failureThreshold: 2, openMs: 10}
		const exporter: MetricExporterPort = {
			export: vi.fn().mockRejectedValueOnce(Object.assign(new Error('temporary'), {retryable: true}))
		}
		const manager = new ExporterManager({exporters: [exporter], retryConfig, circuitBreaker})
		retryConfig.maxRetries = 0
		circuitBreaker.failureThreshold = 1
		await manager.export(records)
		expect(exporter.export).toHaveBeenCalledTimes(2)
	})

	it('retains sole shutdown ownership after an operation timeout', async() => {
		vi.useFakeTimers()
		try {
			let releaseShutdown!: () => void
			const exporter: MetricExporterPort = {
				export: vi.fn().mockResolvedValue(undefined),
				flush: vi.fn().mockResolvedValue(undefined),
				shutdown: vi.fn(() => new Promise<void>((resolve) => { releaseShutdown = resolve }))
			}
			const manager = new ExporterManager({exporters: [exporter], operationTimeoutMs: 10})

			const first = manager.shutdown()
			const firstTimeout = expect(first).rejects.toThrow('Metrics exporter shutdown timed out after 10ms')
			await vi.advanceTimersByTimeAsync(20)
			await firstTimeout
			expect(manager.getTelemetry().state).toBe('draining')
			await expect(manager.export(records)).rejects.toThrow('draining')

			const second = manager.shutdown()
			const secondTimeout = expect(second).rejects.toThrow('Metrics exporter shutdown timed out after 10ms')
			await vi.advanceTimersByTimeAsync(20)
			await secondTimeout
			expect(exporter.shutdown).toHaveBeenCalledOnce()

			releaseShutdown()
			await vi.waitFor(() => expect(manager.getTelemetry().state).toBe('closed'))
		} finally {
			vi.useRealTimers()
		}
	})

	it('keeps a late timed-out shutdown failure draining and permits a serialized retry', async() => {
		vi.useFakeTimers()
		try {
			let rejectShutdown!: (error: Error) => void
			const exporter: MetricExporterPort = {
				export: vi.fn().mockResolvedValue(undefined),
				flush: vi.fn().mockResolvedValue(undefined),
				shutdown: vi.fn()
					.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectShutdown = reject }))
					.mockResolvedValueOnce(undefined)
			}
			const manager = new ExporterManager({exporters: [exporter], operationTimeoutMs: 10})
			const shutdown = manager.shutdown()
			const timeout = expect(shutdown).rejects.toThrow('Metrics exporter shutdown timed out after 10ms')
			await vi.advanceTimersByTimeAsync(20)
			await timeout

			rejectShutdown(new Error('late failure'))
			await vi.waitFor(() => expect(manager.getTelemetry()).toMatchObject({
				state: 'draining',
				lastFailureCode: 'METRICS_EXPORT_FAILURE'
			}))
			await expect(manager.shutdown()).resolves.toBeUndefined()
			expect(exporter.shutdown).toHaveBeenCalledTimes(2)
			expect(manager.getTelemetry().state).toBe('closed')
		} finally {
			vi.useRealTimers()
		}
	})
})
