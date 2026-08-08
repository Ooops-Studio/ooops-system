import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {describe, expect, it, vi} from 'vitest'

import {createCustomMetrics} from '../../src/public/custom'
import {createRecordingMetricsExporter} from '../support/recording-exporter'

describe('custom metrics preset', () => {
	it('creates only the managed contract and exports configured instruments', async() => {
		const exporter = createRecordingMetricsExporter()
		const metrics = await createCustomMetrics({
			clock: createSystemClock(),
			destinations: [{provider: 'custom', exporter}],
			instruments: [{name: 'request_duration_ms', instrument: 'timer'}]
		})
		metrics.counter('requests_total', 2, {route: '/'})
		metrics.timer('request_duration_ms', 12, {route: '/'})
		await metrics.flush()
		expect(exporter.getMetricsByName('requests_total').length).toBeGreaterThan(0)
		expect(exporter.getMetricsByName('request_duration_ms_count').length).toBeGreaterThan(0)
		expect(Object.keys(metrics).sort()).toEqual([
			'counter', 'flush', 'gauge', 'getStatus', 'histogram', 'increment',
			'record', 'shutdown', 'timer', 'upDownCounter'
		].sort())
		expect('destroy' in metrics).toBe(false)
		expect('observe' in metrics).toBe(false)
		expect('register' in metrics).toBe(false)
		await metrics.shutdown()
	})

	it('supports bounded two-destination partial fan-out', async() => {
		const first = createRecordingMetricsExporter()
		const second = createRecordingMetricsExporter()
		const metrics = await createCustomMetrics({
			clock: createSystemClock(),
			destinations: [
				{provider: 'custom', exporter: first},
				{provider: 'custom', exporter: second}
			],
			selfMetrics: false
		})
		metrics.gauge('queue_depth', 3)
		await metrics.flush()
		expect(first.getMetricsByName('queue_depth')).toHaveLength(1)
		expect(second.getMetricsByName('queue_depth')).toHaveLength(1)
		await metrics.shutdown()
	})

	it('retries a partial fan-out only on the destination that did not commit', async() => {
		const firstExport = vi.fn(async() => undefined)
		const secondExport = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('temporary'), {retryable: false}))
			.mockResolvedValue(undefined)
		const metrics = await createCustomMetrics({
			clock: createSystemClock(),
			destinations: [
				{provider: 'custom', exporter: {export: firstExport}},
				{provider: 'custom', exporter: {export: secondExport}}
			],
			temporality: 'delta',
			selfMetrics: false,
			delivery: {
				flushIntervalMs: 60_000,
				operationTimeoutMs: 1_000,
				retry: {maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1}
			}
		})
		metrics.counter('partial_total', 1)

		await expect(metrics.flush()).rejects.toThrow('temporary')
		expect(metrics.getStatus()).toMatchObject({queueSize: 1, sinkState: 'unhealthy'})
		await expect(metrics.flush()).resolves.toBeUndefined()
		expect(firstExport).toHaveBeenCalledOnce()
		expect(secondExport).toHaveBeenCalledTimes(2)
		expect(metrics.getStatus()).toMatchObject({queueSize: 0, sinkState: 'healthy'})

		metrics.counter('partial_total', 1)
		await metrics.flush()
		expect(firstExport).toHaveBeenCalledTimes(2)
		expect(secondExport).toHaveBeenCalledTimes(3)
		await metrics.shutdown()
	})

	it('rejects zero, more than two, unknown and accessor-backed destinations', async() => {
		const exporter = createRecordingMetricsExporter()
		await expect(createCustomMetrics({clock: createSystemClock(), destinations: []}))
			.rejects.toThrow('between one and two')
		await expect(createCustomMetrics({
			clock: createSystemClock(),
			destinations: Array.from({length: 3}, () => ({provider: 'custom' as const, exporter}))
		})).rejects.toThrow('between one and two')
		await expect(createCustomMetrics({
			clock: createSystemClock(),
			destinations: [{provider: 'statsd'} as never]
		})).rejects.toThrow('unsupported')
		const getter = vi.fn(() => 'custom')
		const hostile = Object.defineProperty({}, 'provider', {enumerable: true, get: getter})
		await expect(createCustomMetrics({
			clock: createSystemClock(), destinations: [hostile as never]
		})).rejects.toThrow('unsupported')
		expect(getter).not.toHaveBeenCalled()

		const exportGetter = vi.fn(() => async() => undefined)
		const hostileExporter = Object.defineProperty({}, 'export', {
			enumerable: true,
			get: exportGetter
		})
		await expect(createCustomMetrics({
			clock: createSystemClock(),
			destinations: [{provider: 'custom', exporter: hostileExporter as never}]
		})).rejects.toThrow('provide export')
		expect(exportGetter).not.toHaveBeenCalled()
	})

	it('bounds hostile custom-exporter prototype traversal', async() => {
		let prototypeReads = 0
		const createHostile = (): object => new Proxy({}, {
			getPrototypeOf: () => {
				prototypeReads += 1
				if (prototypeReads > 200) throw new Error('unbounded exporter traversal')
				return createHostile()
			}
		})

		await expect(createCustomMetrics({
			clock: createSystemClock(),
			destinations: [{provider: 'custom', exporter: createHostile() as never}]
		})).rejects.toThrow('provide export')
		// Three exporter capabilities plus the optional scrape capability are
		// each independently bounded to 32 prototype levels.
		expect(prototypeReads).toBeLessThanOrEqual(128)
	})

	it('captures the injected clock without executing accessors or trusting later mutation', async() => {
		const getter = vi.fn(() => () => 1)
		const accessorClock = Object.defineProperty({}, 'now', {enumerable: true, get: getter})
		await expect(createCustomMetrics({
			clock: accessorClock as never,
			destinations: [{provider: 'custom', exporter: createRecordingMetricsExporter()}]
		})).rejects.toThrow('requires a clock')
		expect(getter).not.toHaveBeenCalled()

		const exporter = createRecordingMetricsExporter()
		const clock = {now: () => 1}
		const metrics = await createCustomMetrics({
			clock,
			destinations: [{provider: 'custom', exporter}],
			selfMetrics: false
		})
		clock.now = () => { throw new Error('mutated clock executed') }
		metrics.counter('stable_clock_total', 1)
		await metrics.flush()
		expect(exporter.getMetricsByName('stable_clock_total')).toHaveLength(1)
		await metrics.shutdown()
	})

	it('does not execute optional scrape accessors on custom exporters', async() => {
		const scrapeGetter = vi.fn(() => () => ({body: 'leaked 1\n', contentType: 'text/plain'}))
		const shutdown = vi.fn(async() => undefined)
		const exporter = Object.defineProperty({
			export: async() => undefined,
			shutdown
		}, 'getPrometheusScrape', {enumerable: true, get: scrapeGetter})

		const metrics = await createCustomMetrics({
			clock: createSystemClock(),
			destinations: [{provider: 'custom', exporter: exporter as never}],
			selfMetrics: false
		})

		expect(scrapeGetter).not.toHaveBeenCalled()
		expect('getPrometheusScrape' in metrics).toBe(false)
		await metrics.shutdown()
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('snapshots a stable custom scrape capability against later mutation', async() => {
		const exporter = {
			export: async() => undefined,
			getPrometheusScrape: () => ({body: 'original 1\n', contentType: 'text/plain'})
		}
		const metrics = await createCustomMetrics({
			clock: createSystemClock(),
			destinations: [{provider: 'custom', exporter}],
			selfMetrics: false
		})
		exporter.getPrometheusScrape = () => { throw new Error('mutated scrape executed') }

		expect('getPrometheusScrape' in metrics && metrics.getPrometheusScrape().body)
			.toBe('original 1\n')
		await metrics.shutdown()
	})

	it('returns a frozen status without raw failures', async() => {
		const metrics = await createCustomMetrics({
			clock: createSystemClock(),
			destinations: [{provider: 'custom', exporter: createRecordingMetricsExporter()}]
		})
		const status = metrics.getStatus()
		expect(Object.isFrozen(status)).toBe(true)
		expect(status).toEqual(expect.objectContaining({
			state: 'running', queueSize: 0, activeSeries: 0,
			droppedTotal: 0, retriedTotal: 0, sinkState: 'healthy'
		}))
		expect('lastError' in status).toBe(false)
		await metrics.shutdown()
		expect(metrics.getStatus().state).toBe('closed')
	})
})
