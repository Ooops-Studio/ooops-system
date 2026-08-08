import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createMemoryJobsBackend} from '../../src/jobs/features/backends/memory'
import {createCustomJobs} from '../../src/jobs/public/custom'
import {attachJobsObservability} from '../../src/jobs/public/observability'

afterEach(() => { vi.useRealTimers() })

describe('Jobs W3C trace propagation', () => {
	it('persists producer headers internally and restores them for the consumer span', async() => {
		vi.useFakeTimers()
		const extracted = vi.fn(async(_carrier: Record<string, string>, fn: () => unknown) => await fn())
		const tracer = {
			injectHeaders(carrier: Record<string, string>) {
				carrier.traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
			},
			inSpan: vi.fn(async(_name: string, fn: () => unknown) => await fn()),
			withExtractedHeaders: extracted
		} as never
		const backend = createMemoryJobsBackend()
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend, pollIntervalMs: 10})
		attachJobsObservability(runtime.jobs, vi.fn(), tracer)
		runtime.jobs.registerTask({name: 'task'}, async() => undefined)
		const {runId} = await runtime.jobs.enqueue('task')
		const stored = await backend.runs.getRun(runId)
		expect(stored?.traceContext?.traceparent).toContain('0123456789abcdef0123456789abcdef')
		await runtime.jobs.start()
		await vi.advanceTimersByTimeAsync(30)
		expect(extracted).toHaveBeenCalledWith(
			expect.objectContaining({traceparent: stored?.traceContext?.traceparent}), expect.any(Function)
		)
		await runtime.jobs.shutdown()
	})
})
