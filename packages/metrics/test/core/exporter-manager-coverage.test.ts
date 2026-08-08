import {describe, expect, it, vi} from 'vitest'

import {ExporterManager} from '../../src/core/exporter-manager'
import type {MetricExporterPort, MetricRecord} from '../../src/types'

const batch: MetricRecord[] = [{name: 'metric', type: 'counter', value: 1, labels: {}, timestamp: 1}]

describe('exporter manager circuit breaker', () => {
	it('opens, cools down, and recovers through a half-open attempt', async() => {
		let now = 0
		const exporter: MetricExporterPort = {export: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined)}
		const manager = new ExporterManager({
			exporters: [exporter],
			monotonicClock: {now: () => now},
			circuitBreaker: {failureThreshold: 1, openMs: 100}
		})

		await expect(manager.export(batch)).rejects.toThrow('down')
		await expect(manager.export(batch)).rejects.toThrow('Exporter unavailable')
		now = 50
		await expect(manager.export(batch)).rejects.toThrow('Exporter unavailable')
		expect(manager.getTelemetry()).toMatchObject({
			sinkState: 'unhealthy', lastFailureCode: 'METRICS_EXPORT_FAILURE'
		})
		now = 100
		await expect(manager.export(batch)).resolves.toBeUndefined()
		expect(manager.getTelemetry()).toMatchObject({sinkState: 'healthy'})
		expect(exporter.export).toHaveBeenCalledTimes(2)
	})

	it('admits only one half-open recovery probe at a time', async() => {
		let now = 0
		const probe = Promise.withResolvers<void>()
		const exporter: MetricExporterPort = {
			export: vi.fn()
				.mockRejectedValueOnce(new Error('down'))
				.mockImplementationOnce(async() => await probe.promise)
				.mockResolvedValue(undefined)
		}
		const manager = new ExporterManager({
			exporters: [exporter],
			monotonicClock: {now: () => now},
			maxConcurrency: 2,
			circuitBreaker: {failureThreshold: 1, openMs: 100}
		})

		await expect(manager.export(batch)).rejects.toThrow('down')
		now = 100
		const recovery = manager.export(batch)
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		const concurrentRecovery = manager.export(batch)
		await Promise.resolve()
		expect(exporter.export).toHaveBeenCalledTimes(2)
		probe.resolve()
		await Promise.all([recovery, concurrentRecovery])
		await expect(manager.export(batch)).resolves.toBeUndefined()
		expect(exporter.export).toHaveBeenCalledTimes(3)
	})

	it('fails a bounded concurrency queue overflow', async() => {
		let release: (() => void) | undefined
		const exporter: MetricExporterPort = {
			export: vi.fn()
				.mockImplementationOnce(() => new Promise<void>((resolve) => {release = resolve}))
				.mockResolvedValue(undefined)
		}
		const manager = new ExporterManager({exporters: [exporter], maxConcurrency: 1, maxQueuedBatches: 1})
		const first = manager.export(batch)
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))
		const second = manager.export(batch)
		await vi.waitFor(() => expect(manager.getTelemetry().queueSize).toBe(1))
		await expect(manager.export(batch)).rejects.toThrow('queue overflow')
		expect(manager.getTelemetry().queueSize).toBe(1)
		release?.()
		await first
		await second
		expect(manager.getTelemetry().queueSize).toBe(0)
	})

	it('counts retained metadata and correlation fields against queued bytes', async() => {
		const gate = Promise.withResolvers<void>()
		const exporter: MetricExporterPort = {
			export: vi.fn()
				.mockImplementationOnce(async() => await gate.promise)
				.mockResolvedValue(undefined)
		}
		const manager = new ExporterManager({
			exporters: [exporter], maxConcurrency: 1,
			maxQueuedBatches: 10, maxQueuedBytes: 128, maxBatchBytes: 1024
		})
		const first = manager.export(batch)
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(1))
		const metadataHeavy: MetricRecord[] = [{
			...batch[0]!,
			metadata: {description: 'x'.repeat(256), instrument: 'counter'},
			exemplar: {value: 1, timestamp: 1, tenantId: 't'.repeat(64), userId: 'u'.repeat(64)}
		}]

		await expect(manager.export(metadataHeavy)).rejects.toMatchObject({code: 'export_queue_overflow'})
		expect(manager.getTelemetry().queueSize).toBe(0)
		gate.resolve()
		await first
	})
})
