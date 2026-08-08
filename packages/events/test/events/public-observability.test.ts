import type {ManagedEvents} from '@ooopsstudio/core/ports/events'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {attachEventsObservability} from '../../src/events/public/observability'
import {
	registerEventsTelemetry,
	type EventsTelemetryAttachment
} from '../../src/events/telemetry'

afterEach(() => { vi.useRealTimers() })

function target(): {events: ManagedEvents; attachment: () => EventsTelemetryAttachment} {
	const events = {} as ManagedEvents
	let current: EventsTelemetryAttachment | undefined
	registerEventsTelemetry(events, (value) => {
		if (current) throw new Error('EVENTS_OBSERVABILITY_ATTACHED')
		current = value
		return () => { if (current === value) current = undefined }
	})
	return {events, attachment: () => current!}
}

describe('events public observability', () => {
	it('emits frozen raw events and supports idempotent cleanup', () => {
		const runtime = target()
		const listener = vi.fn((event) => expect(Object.isFrozen(event)).toBe(true))
		const dispose = attachEventsObservability(runtime.events, listener)
		runtime.attachment().emit({kind: 'published', result: 'success'})
		expect(listener).toHaveBeenCalledWith({kind: 'published', result: 'success'})
		dispose(); dispose()
		expect(() => attachEventsObservability(runtime.events, listener)).not.toThrow()
	})

	it('bounds tracing and executes business work exactly once', async() => {
		vi.useFakeTimers()
		const runtime = target()
		const operation = vi.fn(async() => 'ok')
		attachEventsObservability(runtime.events, vi.fn(), {
			injectHeaders(carrier) {
				carrier.traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
			},
			inSpan: vi.fn(async() => await new Promise<never>(() => undefined))
		} as never)
		expect(runtime.attachment().traceContext?.()).toEqual({
			traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
		})
		const result = runtime.attachment().withPublish!(operation)
		await vi.advanceTimersByTimeAsync(101)
		await expect(result).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledOnce()
	})

	it('executes business work when a tracing wrapper returns without invoking it', async() => {
		const runtime = target()
		const operation = vi.fn(async() => 'ok')
		attachEventsObservability(runtime.events, vi.fn(), {
			inSpan: vi.fn(async() => undefined)
		} as never)
		await expect(runtime.attachment().withPublish!(operation)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledOnce()
	})

	it('contains rejected listener promises', async() => {
		const runtime = target()
		const listener = vi.fn(() => Promise.reject(new Error('listener rejection')))
		attachEventsObservability(runtime.events, listener)
		expect(() => runtime.attachment().emit({kind: 'retry'})).not.toThrow()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		expect(listener).toHaveBeenCalledOnce()
	})

	it('contains a rejected promise thrown as an observability failure reason', async() => {
		const runtime = target()
		attachEventsObservability(runtime.events, () => { throw Promise.reject(new Error('nested listener rejection')) })
		expect(() => runtime.attachment().emit({kind: 'retry'})).not.toThrow()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('contains rejected promises returned by synchronous header injection', async() => {
		const runtime = target()
		attachEventsObservability(runtime.events, vi.fn(), {
			injectHeaders: vi.fn(() => Promise.reject(new Error('inject rejection')))
		} as never)
		expect(runtime.attachment().traceContext?.()).toBeUndefined()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('contains rejected promises written into trace carrier fields', async() => {
		const runtime = target()
		attachEventsObservability(runtime.events, vi.fn(), {
			injectHeaders: vi.fn((carrier: Record<string, unknown>) => {
				carrier.traceparent = Promise.reject(new Error('traceparent field rejection'))
				carrier.baggage = Promise.reject(new Error('baggage field rejection'))
			})
		} as never)
		expect(runtime.attachment().traceContext?.()).toBeUndefined()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('rejects invalid listeners', () => {
		const runtime = target()
		expect(() => attachEventsObservability(runtime.events, {} as never))
			.toThrow('EVENTS_OBSERVABILITY_LISTENER_INVALID')
	})

	it('contains rejected promise owners at the observability boundary', async() => {
		const runtime = target()
		expect(() => attachEventsObservability(runtime.events, Promise.reject(new Error('listener owner')) as never))
			.toThrow('EVENTS_OBSERVABILITY_LISTENER_INVALID')
		expect(() => attachEventsObservability(Promise.reject(new Error('events owner')) as never, vi.fn()))
			.toThrow('EVENTS_OBSERVABILITY_UNSUPPORTED')
		expect(() => attachEventsObservability(runtime.events, vi.fn(), Promise.reject(new Error('tracing owner')) as never))
			.not.toThrow()
		expect(() => attachEventsObservability(
			Promise.reject(new Error('invalid events owner')) as never,
			Promise.reject(new Error('invalid listener owner')) as never,
			Promise.reject(new Error('invalid tracing owner')) as never
		)).toThrow('EVENTS_OBSERVABILITY_UNSUPPORTED')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('contains every rejected tracing capability before validation short-circuits', async() => {
		const runtime = target()
		expect(() => attachEventsObservability(runtime.events, vi.fn(), {
			injectHeaders: Promise.reject(new Error('inject method rejection')),
			inSpan: Promise.reject(new Error('span method rejection')),
			withExtractedHeaders: Promise.reject(new Error('extract method rejection'))
		} as never)).not.toThrow()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('does not invoke accessors installed by a hostile tracing adapter', () => {
		const runtime = target()
		let invoked = false
		attachEventsObservability(runtime.events, vi.fn(), {injectHeaders(carrier) {
			Object.defineProperty(carrier, 'traceparent', {enumerable: true, get() {
				invoked = true
				throw new Error('hostile trace accessor')
			}})
		}} as never)
		expect(runtime.attachment().traceContext?.()).toBeUndefined()
		expect(invoked).toBe(false)
	})
})
