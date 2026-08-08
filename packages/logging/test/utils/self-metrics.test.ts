import {describe, expect, it, vi} from 'vitest'

import {
	reportLogDropped,
	reportLogRetried,
	reportLogWritten,
	reportQueueSize,
	reportStageFailure
} from '../../src/utils/self-metrics'

const metrics = () => ({increment: vi.fn(), record: vi.fn()})

describe('logging self metrics', () => {
	it('emits the four delivery metrics', () => {
		const port = metrics()
		reportLogWritten(port as never)
		reportLogDropped(port as never, 'closed')
		reportLogRetried(port as never)
		reportQueueSize(3, port as never)
		expect(port.increment).toHaveBeenCalledWith('_logs_written_total', {})
		expect(port.increment).toHaveBeenCalledWith('_logs_dropped_total', {reason: 'closed'})
		expect(port.increment).toHaveBeenCalledWith('_logs_retried_total', {})
		expect(port.record).toHaveBeenCalledWith('_logs_queue_size', 3, {})
	})

	it('emits only sink and finalization failure metrics', () => {
		const port = metrics()
		reportStageFailure(port as never, 'sink')
		reportStageFailure(port as never, 'flush')
		reportStageFailure(port as never, 'shutdown')
		reportStageFailure(port as never, 'enriching')
		expect(port.increment.mock.calls).toEqual([
			['_logs_sink_failures_total', {}],
			['_logs_finalization_failures_total', {operation: 'flush'}],
			['_logs_finalization_failures_total', {operation: 'shutdown'}]
		])
	})

	it('is safe without a metrics port', () => {
		expect(() => {
			reportLogWritten()
			reportLogDropped(undefined, 'closed')
			reportLogRetried()
			reportQueueSize(0)
			reportStageFailure(undefined, 'sink')
		}).not.toThrow()
	})
})
