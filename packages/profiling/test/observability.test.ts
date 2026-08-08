import {describe, expect, it, vi} from 'vitest'

import {createProfilingManager} from '../src/manager'
import {attachProfilingObservability} from '../src/public/observability'
import {emitProfilingTelemetry} from '../src/runtime-capabilities'

describe('profiling observability attachment', () => {
	it('emits every raw event as a frozen snapshot', async() => {
		const runtime = await createProfilingManager({})
		const events: Array<{readonly kind: string}> = []
		const dispose = attachProfilingObservability(runtime, (event) => {
			expect(Object.isFrozen(event)).toBe(true)
			events.push(event)
		})

		emitProfilingTelemetry(runtime, {kind: 'capture_started'})
		emitProfilingTelemetry(runtime, {kind: 'capture_completed'})
		emitProfilingTelemetry(runtime, {kind: 'dropped', reason: 'busy'})
		emitProfilingTelemetry(runtime, {kind: 'capture_failed', reason: 'capture_failed'})
		emitProfilingTelemetry(runtime, {kind: 'export_failed', count: 2})
		emitProfilingTelemetry(runtime, {kind: 'continuous_failed', operation: 'start'})
		emitProfilingTelemetry(runtime, {kind: 'finalization_failed', operation: 'shutdown'})
		emitProfilingTelemetry(runtime, {kind: 'recovered'})

		expect(events.map(({kind}) => kind)).toEqual([
			'capture_started', 'capture_completed', 'dropped', 'capture_failed',
			'export_failed', 'continuous_failed', 'finalization_failed', 'recovered'
		])
		dispose(); dispose()
		await runtime.shutdown()
	})

	it('allows one attachment, isolates listener failures, and supports reattachment', async() => {
		const runtime = await createProfilingManager({})
		const throwing = vi.fn(() => { throw new Error('external failure') })
		const dispose = attachProfilingObservability(runtime, throwing)
		expect(() => emitProfilingTelemetry(runtime, {kind: 'capture_failed', reason: 'capture_failed'})).not.toThrow()
		expect(() => attachProfilingObservability(runtime, vi.fn())).toThrow('PROFILING_OBSERVABILITY_ATTACHED')
		dispose()
		const second = attachProfilingObservability(runtime, vi.fn())
		second()
		await runtime.shutdown()
	})

	it('observes asynchronous listener failures without creating an unhandled rejection', async() => {
		const runtime = await createProfilingManager({})
		let rejectionObserved = false
		const dispose = attachProfilingObservability(runtime, () => ({
			then(_resolve: (value: unknown) => void, reject: (reason: Error) => void) {
				rejectionObserved = true
				reject(new Error('external async failure'))
			}
		}))

		emitProfilingTelemetry(runtime, {kind: 'capture_started'})
		await vi.waitFor(() => expect(rejectionObserved).toBe(true))

		dispose()
		await runtime.shutdown()
	})

	it('rejects a non-function listener', async() => {
		const runtime = await createProfilingManager({})
		expect(() => attachProfilingObservability(runtime, {} as never))
			.toThrow('PROFILING_OBSERVABILITY_LISTENER_INVALID')
		await runtime.shutdown()
	})
})
