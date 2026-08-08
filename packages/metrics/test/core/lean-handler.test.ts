import {afterEach, describe, expect, it, vi} from 'vitest'

import {createLeanMetricsHandler} from '../../src/core/lean-handler'
import type {MetricRecord} from '../../src/types'
import {createFixedClock} from '../support/fixed-clock'

const baseOptions = () => ({
	exporters: [{export: vi.fn(async() => undefined)}],
	labelLimits: {maxLabels: 10, maxCardinality: 100},
	flushIntervalMs: 1_000,
	clock: createFixedClock(1),
	selfMetrics: false
})

describe('createLeanMetricsHandler', () => {
	afterEach(() => vi.useRealTimers())

	it('keeps normal flush admission open and emits the later cumulative value', async() => {
		const gate = Promise.withResolvers<void>()
		const exported: MetricRecord[][] = []
		const exporter = {
			export: vi.fn(async(batch: ReadonlyArray<MetricRecord>) => {
				exported.push([...batch])
				if (exported.length === 1) await gate.promise
			})
		}
		const handler = createLeanMetricsHandler({...baseOptions(), exporters: [exporter]})
		handler.counter('concurrent_counter', 1)

		const firstFlush = handler.flush()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		expect(handler.getStatus().state).toBe('running')
		handler.counter('concurrent_counter', 1)
		gate.resolve()
		await firstFlush
		await handler.flush()

		expect(exported.flat().filter(({name}) => name === 'concurrent_counter').map(({value}) => value))
			.toEqual([1, 2])
		await handler.shutdown()
	})

	it('uses millisecond-scaled default buckets for the public timer API', async() => {
		const exported: MetricRecord[][] = []
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{export: async(batch) => { exported.push([...batch]) }}]
		})

		handler.timer('request_duration_ms', 25)
		await handler.flush()

		expect(exported.flat()).toEqual(expect.arrayContaining([
			expect.objectContaining({
				name: 'request_duration_ms_bucket',
				value: 1,
				labels: {le: '25'}
			})
		]))
		await handler.shutdown()
	})

	it('closes admission before concurrent idempotent shutdown', async() => {
		const gate = Promise.withResolvers<void>()
		const exported: MetricRecord[][] = []
		const shutdown = vi.fn(async() => gate.promise)
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{
				export: vi.fn(async(batch: ReadonlyArray<MetricRecord>) => { exported.push([...batch]) }),
				shutdown
			}]
		})
		handler.counter('accepted', 1)
		const first = handler.shutdown()
		const second = handler.shutdown()
		await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
		handler.counter('rejected_after_shutdown', 1)
		gate.resolve()
		await Promise.all([first, second])
		await handler.shutdown()

		expect(shutdown).toHaveBeenCalledOnce()
		expect(exported.flat().some(({name}) => name === 'accepted')).toBe(true)
		expect(exported.flat().some(({name}) => name === 'rejected_after_shutdown')).toBe(false)
		expect(handler.getStatus()).toMatchObject({
			state: 'closed',
			activeSeries: 0
		})
	})

	it('exports an accepted write when its clock re-enters shutdown', async() => {
		const exported: MetricRecord[][] = []
		let handler: ReturnType<typeof createLeanMetricsHandler> | undefined
		let reenter = false
		let reentered = false
		let shutdown: Promise<void> | undefined
		const clock = {
			now: () => {
				if (reenter && !reentered) {
					reentered = true
					shutdown = handler?.shutdown()
				}
				return 1
			}
		}
		handler = createLeanMetricsHandler({
			...baseOptions(),
			clock,
			exporters: [{export: async(batch) => { exported.push([...batch]) }}]
		})

		reenter = true
		handler.counter('accepted_during_reentrant_shutdown', 1)
		await shutdown

		expect(exported.flat()).toEqual(expect.arrayContaining([
			expect.objectContaining({name: 'accepted_during_reentrant_shutdown', value: 1})
		]))
		expect(handler.getStatus().state).toBe('closed')
	})

	it('does not redeliver a delta flush whose clock re-enters shutdown', async() => {
		const exported: MetricRecord[][] = []
		let handler: ReturnType<typeof createLeanMetricsHandler> | undefined
		let reenter = false
		let reentered = false
		let shutdown: Promise<void> | undefined
		const clock = {
			now: () => {
				if (reenter && !reentered) {
					reentered = true
					shutdown = handler?.shutdown()
				}
				return 1
			}
		}
		handler = createLeanMetricsHandler({
			...baseOptions(),
			clock,
			defaultTemporality: 'delta',
			exporters: [{export: async(batch) => { exported.push([...batch]) }}]
		})
		handler.counter('single_delivery_during_reentrant_shutdown', 1)

		reenter = true
		const flushing = handler.flush()
		await vi.waitFor(() => expect(shutdown).toBeDefined())
		await Promise.all([flushing, shutdown!])

		expect(exported.flat().filter(
			({name, value}) => name === 'single_delivery_during_reentrant_shutdown' && value === 1
		)).toHaveLength(1)
		expect(handler.getStatus().state).toBe('closed')
	})

	it('leaves a timed-out flush fenced until the retained operation settles', async() => {
		vi.useFakeTimers()
		const gate = Promise.withResolvers<void>()
		const exporter = vi.fn(async() => gate.promise)
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{export: exporter}],
			flushTimeoutMs: 10
		})
		handler.increment('hanging_export', {}, 1)
		const assertion = expect(handler.flush()).rejects.toThrow('Metrics flush timed out after 10ms')
		await vi.advanceTimersByTimeAsync(10)
		await assertion
		expect(handler.getStatus()).toMatchObject({state: 'running', lastFailureCode: 'METRICS_FINALIZATION_FAILURE'})
		handler.counter('accepted_after_flush_timeout', 1)

		gate.resolve()
		await handler.flush()
		expect(exporter).toHaveBeenCalledOnce()
		expect(handler.getStatus().lastFailureCode).toBeUndefined()
		await handler.shutdown()
	})

	it('keeps a delivery failure retryable without reopening admission during shutdown', async() => {
		const exportBatch = vi.fn()
			.mockRejectedValueOnce(new Error('temporary export failure'))
			.mockResolvedValue(undefined)
		const handler = createLeanMetricsHandler({...baseOptions(), exporters: [{export: exportBatch}]})
		handler.increment('retryable_metric', {}, 1)

		await expect(handler.flush()).rejects.toThrow('temporary export failure')
		expect(handler.getStatus().state).toBe('running')
		await expect(handler.flush()).resolves.toBeUndefined()
		expect(exportBatch).toHaveBeenCalledTimes(2)
		await handler.shutdown()
	})

	it('retries only unfinished exporter shutdown operations', async() => {
		let firstClosed = false
		const firstFlush = vi.fn(async() => {
			if (firstClosed) throw new Error('flush after close')
		})
		const firstShutdown = vi.fn(async() => { firstClosed = true })
		const secondFlush = vi.fn(async() => undefined)
		const secondShutdown = vi.fn()
			.mockRejectedValueOnce(new Error('close failed'))
			.mockResolvedValue(undefined)
		const firstExport = vi.fn(async() => undefined)
		const secondExport = vi.fn(async() => undefined)
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [
				{export: firstExport, flush: firstFlush, shutdown: firstShutdown},
				{export: secondExport, flush: secondFlush, shutdown: secondShutdown}
			]
		})
		handler.counter('shutdown_retry_total', 1)

		await expect(handler.shutdown()).rejects.toThrow('failed for 1 exporter')
		expect(handler.getStatus().state).toBe('draining')
		await expect(handler.shutdown()).resolves.toBeUndefined()
		expect(firstShutdown).toHaveBeenCalledOnce()
		expect(secondShutdown).toHaveBeenCalledTimes(2)
		expect(firstFlush).toHaveBeenCalledOnce()
		expect(secondFlush).toHaveBeenCalledTimes(2)
		expect(firstExport).toHaveBeenCalledOnce()
		expect(secondExport).toHaveBeenCalledOnce()
		expect(handler.getStatus().state).toBe('closed')
	})

	it('validates fixed bootstrap configuration', () => {
		const base = baseOptions()
		expect(() => createLeanMetricsHandler(null as never)).toThrow('options must be an object')
		expect(() => createLeanMetricsHandler({...base, selfMetrics: 'yes' as never}))
			.toThrow('selfMetrics must be a boolean')
		expect(() => createLeanMetricsHandler({...base, flushIntervalMs: 1.5}))
			.toThrow('safe integer')
		expect(() => createLeanMetricsHandler({...base, exporterOperationTimeoutMs: 2_147_483_648}))
			.toThrow('must not exceed')
	})

	it('emits only the retained bounded drop metric names', async() => {
		const exported: Array<ReadonlyArray<{name: string}>> = []
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{export: async(batch) => { exported.push(batch) }}],
			labelLimits: {maxLabels: 1, maxCardinality: 1},
			selfMetrics: true
		})
		handler.increment('bounded_metric', {first: 'a', second: 'dropped'}, 1)
		handler.increment('bounded_metric', {first: 'b'}, 1)
		await handler.flush()

		const names = exported.flat().map(({name}) => name)
		expect(names).toContain('_metrics_dropped_total')
		expect(names).not.toContain('_metrics_label_drop_total')
		expect(names).not.toContain('_metrics_cardinality_dropped_total')
		await handler.shutdown()
	})

	it('keeps retained development-scale histogram cardinality exportable under byte pressure', async() => {
		const exported: MetricRecord[][] = []
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{export: async(batch) => { exported.push([...batch]) }}],
			labelLimits: {maxLabels: 20, maxCardinality: 1_000},
			selfMetrics: true
		})
		const padding = 'x'.repeat(200)
		for (let series = 0; series < 400; series += 1) {
			handler.histogram('bounded_histogram', 1, Object.fromEntries([
				['series', String(series)],
				...Array.from({length: 19}, (_, index) => [`padding_${index}`, padding])
			]))
		}

		await expect(handler.flush()).resolves.toBeUndefined()
		const exportedSeries = exported.flat().filter(({name}) => name === 'bounded_histogram_count').length
		expect(exportedSeries).toBeGreaterThan(0)
		expect(exportedSeries).toBeLessThan(400)
		expect(handler.getStatus().droppedTotal).toBeGreaterThan(0)
		await handler.shutdown()
	}, 15_000)

	it('drops series beyond the managed snapshot byte budget without wedging flush', async() => {
		const exported: MetricRecord[][] = []
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{export: async(batch) => { exported.push([...batch]) }}],
			labelLimits: {maxLabels: 20, maxCardinality: 200, maxLabelValueLength: 1_000},
			selfMetrics: true
		})
		const padding = 'x'.repeat(1_000)
		for (let series = 0; series < 300; series += 1) {
			handler.histogram(series < 150 ? 'first_histogram' : 'second_histogram', 1, Object.fromEntries([
				['series', String(series)],
				...Array.from({length: 19}, (_, index) => [`padding_${index}`, padding])
			]))
		}

		await expect(handler.flush()).resolves.toBeUndefined()
		const exportedSeries = exported.flat().filter(({name}) => name.endsWith('_count')).length
		expect(exportedSeries).toBeGreaterThan(0)
		expect(exportedSeries).toBeLessThan(300)
		expect(handler.getStatus().droppedTotal).toBeGreaterThan(0)
		await handler.shutdown()
	}, 15_000)

	it('drops a single histogram family that cannot fit the managed byte ceiling', async() => {
		const exported: MetricRecord[][] = []
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{export: async(batch) => { exported.push([...batch]) }}],
			labelLimits: {maxLabels: 256, maxCardinality: 1, maxLabelValueLength: 4_096},
			selfMetrics: true,
			instruments: [{
				name: 'oversized_histogram', instrument: 'histogram',
				histogramBuckets: Array.from({length: 256}, (_, index) => index + 1)
			}]
		})
		const labels = Object.fromEntries(Array.from(
			{length: 256}, (_, index) => [`label_${index}`, 'x'.repeat(4_096)]
		))

		handler.histogram('oversized_histogram', 1, labels)
		await expect(handler.flush()).resolves.toBeUndefined()

		expect(handler.getStatus().droppedTotal).toBeGreaterThan(0)
		expect(exported.flat().some(({name}) => name === 'oversized_histogram_count')).toBe(false)
		await handler.shutdown()
	})

	it('keeps self-metric label conflicts observational', async() => {
		const exported: MetricRecord[][] = []
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{export: async(batch) => { exported.push([...batch]) }}],
			resourceLabels: {instrument: 'resource'},
			selfMetrics: true
		})

		expect(() => handler.counter('application_counter', 1)).not.toThrow()
		await expect(handler.flush()).resolves.toBeUndefined()
		expect(exported.flat()).toEqual(expect.arrayContaining([
			expect.objectContaining({name: 'application_counter', value: 1})
		]))
		await handler.shutdown()
	})

	it('keeps self-metric name conflicts from blocking flush', async() => {
		const exported: MetricRecord[][] = []
		const handler = createLeanMetricsHandler({
			...baseOptions(),
			exporters: [{export: async(batch) => { exported.push([...batch]) }}],
			selfMetrics: true
		})

		handler.counter('_metrics_queue_size', 1)
		await expect(handler.flush()).resolves.toBeUndefined()
		expect(exported.flat()).toEqual(expect.arrayContaining([
			expect.objectContaining({name: '_metrics_queue_size', type: 'counter', value: 1})
		]))
		await handler.shutdown()
	})
})
