import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {describe, expect, it, vi} from 'vitest'

import {
	reportExportFailure,
	reportExportRetry,
	reportFinalizationFailure,
	reportQueueSize,
	reportSpanDropped,
	reportSpanExported,
	reportTraceStarted
} from '../../src/utils/self-metrics'

describe('tracing self-metrics', () => {
	it('emits exactly the seven approved metric names', () => {
		const increment = vi.fn()
		const record = vi.fn()
		const metrics: MetricsPort = {increment, record}
		reportTraceStarted('server', metrics)
		reportSpanExported(2, metrics)
		reportSpanDropped(3, 'sampling', metrics)
		reportExportRetry(1, metrics)
		reportQueueSize(4, metrics)
		reportExportFailure(metrics)
		reportFinalizationFailure('shutdown', metrics)

		const names = new Set([...increment.mock.calls, ...record.mock.calls].map(([name]) => name))
		expect(names).toEqual(new Set([
			'_traces_started_total',
			'_traces_exported_total',
			'_traces_dropped_total',
			'_traces_export_retries_total',
			'_traces_queue_size',
			'_traces_export_failures_total',
			'_traces_finalization_failures_total'
		]))
		expect(increment).toHaveBeenCalledWith('_traces_started_total', {kind: 'server'})
		expect(increment).toHaveBeenCalledWith('_traces_dropped_total', {reason: 'sampling'}, 3)
		expect(increment).toHaveBeenCalledWith('_traces_finalization_failures_total', {operation: 'shutdown'})
	})

	it('ignores non-positive counters and isolates incomplete or throwing ports', () => {
		const increment = vi.fn()
		const metrics: MetricsPort = {
			increment,
			record: vi.fn(() => { throw new Error('metrics unavailable') })
		}
		reportSpanExported(0, metrics)
		reportSpanDropped(-1, 'test', metrics)
		reportExportRetry(0, metrics)
		expect(increment).not.toHaveBeenCalled()
		expect(() => reportQueueSize(1, metrics)).not.toThrow()
		expect(() => reportTraceStarted('internal', {})).not.toThrow()
		expect(() => reportExportFailure(undefined)).not.toThrow()
	})

	it('observes rejected native promises returned by metric integrations', async() => {
		const metrics = {
			increment: vi.fn(() => Promise.reject(new Error('async increment failure'))),
			record: vi.fn(() => Promise.reject(new Error('async record failure')))
		} as never
		reportSpanExported(1, metrics)
		reportSpanDropped(1, 'test', metrics)
		reportExportRetry(1, metrics)
		reportQueueSize(1, metrics)
		await Promise.resolve()
		await Promise.resolve()
		expect(metrics.increment).toHaveBeenCalledTimes(3)
		expect(metrics.record).toHaveBeenCalledOnce()
	})
})
