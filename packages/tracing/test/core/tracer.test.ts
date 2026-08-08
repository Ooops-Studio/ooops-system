import {createAsyncContextStore} from '@ooopsstudio/core/runtime/context'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {createIdGenerator} from '@ooopsstudio/core/utils/tracing'
import {createAlwaysOnSampler} from '@ooopsstudio/core/utils/tracing'
import {describe, expect, it, vi} from 'vitest'

import {createTracer} from '../../src/core/tracer'

function setup(overrides: Record<string, unknown> = {}) {
	let observer: Record<string, (...args: never[]) => void> | undefined
	const processor = {
		onEnd: vi.fn(),
		flush: vi.fn(async() => undefined),
		shutdown: vi.fn(async() => undefined),
		getQueueSize: vi.fn(() => 0),
		setObserver: vi.fn((value) => { observer = value })
	}
	const tracer = createTracer({
		clock: createFixedClock(100),
		contextStore: createAsyncContextStore(),
		idGen: createIdGenerator(),
		sampler: createAlwaysOnSampler(),
		processor,
		...overrides
	} as never)
	return {tracer, processor, getObserver: () => observer!}
}

describe('core managed tracer runtime', () => {
	it('rejects hostile baggage modes without invoking coercion hooks', async() => {
		const {tracer} = setup()
		let coercions = 0
		const hostile = {[Symbol.toPrimitive]: () => { coercions++; return 'replace' }}
		await tracer.inSpan('mode-boundary', async() => {
			tracer.setBaggage({tenant: 'ignored'}, hostile as never)
			expect(tracer.getBaggage()).toEqual({})
		})
		expect(coercions).toBe(0)
	})

	it('does not invoke nested accessors in external-context baggage', () => {
		let getterCalls = 0
		const baggage = Object.defineProperty({}, 'tenant', {
			enumerable: true,
			get: () => { getterCalls++; return 'secret' }
		})
		const current = {spanContext: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}, baggage}
		const {tracer} = setup({contextStore: {get: () => current, run: (_value: unknown, fn: () => unknown) => fn()}})

		expect(tracer.getBaggage()).toEqual({})
		tracer.clearBaggage(['tenant'])
		expect(getterCalls).toBe(0)
	})

	it('rejects oversized selective-clear keys without changing baggage', async() => {
		const {tracer} = setup()
		await tracer.inSpan('baggage', async() => {
			tracer.setBaggage({tenant: 'acme'}, 'replace')
			tracer.clearBaggage(['x'.repeat(1_000_000)])
			expect(tracer.getBaggage()).toEqual({tenant: 'acme'})
		})
	})

	it('finalizes one canonical deeply frozen record', async() => {
		const {tracer, processor} = setup({
			resource: {'service.name': 'api'},
			redactAttributes: (attrs: Record<string, unknown>) => ({...attrs, authorization: '***'})
		})
		await tracer.inSpan('request', async(span) => {
			span.setAttribute('safe', {nested: true})
			span.addEvent('checkpoint', {value: 'ok'})
			span.setAttribute('authorization', 'secret')
		})
		const record = processor.onEnd.mock.calls[0]?.[0]
		expect(record).toMatchObject({name: 'request', attributes: {safe: {nested: true}, authorization: '***'}})
		expect(Object.isFrozen(record)).toBe(true)
		expect(Object.isFrozen(record.attributes)).toBe(true)
		expect(Object.isFrozen(record.events)).toBe(true)
	})

	it('preserves async context, W3C propagation, baggage, and parent relationships', async() => {
		const {tracer, processor} = setup()
		await tracer.inSpan('parent', async(parent) => {
			tracer.setBaggage({tenant: 'acme'}, 'replace')
			const carrier: Record<string, string> = {}
			tracer.injectHeaders(carrier)
			expect(carrier.traceparent).toBeDefined()
			expect(carrier.baggage).toContain('tenant=acme')
			await tracer.withExtractedHeaders(carrier, async() => {
				await tracer.inSpan('child', async(child) => {
					expect(child.getContext().traceId).toBe(parent.getContext().traceId)
					expect(tracer.getBaggage()).toEqual({tenant: 'acme'})
				})
			})
		})
		const [child] = processor.onEnd.mock.calls.map(([record]) => record).filter((record) => record.name === 'child')
		expect(child.parentContext.spanId).toBeDefined()
	})

	it('does not leak ambient baggage into an independent extracted remote trace', async() => {
		const {tracer} = setup()
		const remoteTraceId = 'c'.repeat(32)
		await tracer.inSpan('local', async(local) => {
			tracer.setBaggage({tenant: 'local-tenant'}, 'replace')
			await tracer.withExtractedHeaders({
				traceparent: `00-${remoteTraceId}-${'d'.repeat(16)}-01`
			}, async() => {
				expect(tracer.currentTraceId()).toBe(remoteTraceId)
				expect(tracer.getBaggage()).toEqual({})
				const carrier: Record<string, string> = {}
				tracer.injectHeaders(carrier)
				expect(carrier).not.toHaveProperty('baggage')
			})
			expect(tracer.currentTraceId()).toBe(local.getContext().traceId)
			expect(tracer.getBaggage()).toEqual({tenant: 'local-tenant'})
		})
	})

	it('does not leak ambient baggage into an empty extraction boundary', async() => {
		const {tracer} = setup()
		await tracer.inSpan('local', async() => {
			tracer.setBaggage({tenant: 'local-tenant'}, 'replace')
			await tracer.withExtractedHeaders({}, async() => {
				expect(tracer.currentTraceId()).toBeUndefined()
				expect(tracer.getBaggage()).toEqual({})
				await tracer.inSpan('new-root', async() => {
					expect(tracer.getBaggage()).toEqual({})
				})
			})
			expect(tracer.getBaggage()).toEqual({tenant: 'local-tenant'})
		})
	})

	it('isolates ambient baggage across explicit roots, remote parents, and external spans', async() => {
		const {tracer} = setup()
		const remote = {traceId: 'e'.repeat(32), spanId: 'f'.repeat(16), traceFlags: 1}
		const external = {
			getContext: () => remote,
			setAttribute: () => undefined,
			addEvent: () => undefined,
			recordException: () => undefined,
			setStatus: () => undefined,
			end: () => undefined
		}
		await tracer.inSpan('local', async() => {
			tracer.setBaggage({tenant: 'local-tenant'}, 'replace')
			await tracer.inSpan('remote-child', async() => {
				expect(tracer.getBaggage()).toEqual({})
			}, {parent: remote})
			await tracer.inSpan('explicit-root', async() => {
				expect(tracer.getBaggage()).toEqual({})
			}, {parent: null})
			await tracer.withSpan(external, async() => {
				expect(tracer.currentTraceId()).toBe(remote.traceId)
				expect(tracer.getBaggage()).toEqual({})
			})
			expect(tracer.getBaggage()).toEqual({tenant: 'local-tenant'})
		})
	})

	it('isolates recorded attributes and parenting from custom sampler mutation', async() => {
		const mutationResults: boolean[] = []
		const {tracer, processor} = setup({
			sampler: {
				decide: (parent: Record<string, unknown> | undefined, _name: string, attributes?: Record<string, unknown>) => {
					if (parent) mutationResults.push(Reflect.set(parent, 'traceId', '0'.repeat(32)))
					const nested = attributes?.nested
					if (nested && typeof nested === 'object') {
						mutationResults.push(Reflect.set(nested, 'value', 'mutated-by-sampler'))
					}
					return 'record-and-sample'
				}
			}
		})
		await tracer.inSpan('parent', async() => {
			await tracer.inSpan('child', async() => undefined, {attributes: {nested: {value: 'original'}}})
		})

		const child = processor.onEnd.mock.calls.map(([record]) => record).find((record) => record.name === 'child')
		expect(mutationResults).toEqual([false, false])
		expect(child.attributes).toEqual({nested: {value: 'original'}})
		expect(child.context.traceId).not.toBe('0'.repeat(32))
		expect(child.parentContext.traceId).toBe(child.context.traceId)
	})

	it('keeps forceFlush independent from admission', async() => {
		const {tracer, processor} = setup()
		await tracer.forceFlush()
		await tracer.inSpan('after-flush', async() => undefined)
		expect(processor.flush).toHaveBeenCalledOnce()
		expect(processor.onEnd).toHaveBeenCalledOnce()
	})

	it('preserves forceFlush success when deadline cleanup fails', async() => {
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
			throw new Error('timer cleanup unavailable')
		})
		try {
			const {tracer, processor} = setup()
			await expect(tracer.forceFlush()).resolves.toBeUndefined()
			expect(processor.flush).toHaveBeenCalledOnce()
		} finally { cleanup.mockRestore() }
	})

	it('bounds a forceFlush operation that never settles without closing admission', async() => {
		vi.useFakeTimers()
		try {
			const {tracer, processor} = setup()
			processor.flush.mockImplementation(async() => await new Promise<void>(() => undefined))
			const flushing = tracer.forceFlush()
			const rejected = expect(flushing).rejects.toThrow('Tracing forceFlush timed out')

			await vi.advanceTimersByTimeAsync(10_000)
			await rejected
			expect(tracer.getStatus().state).toBe('running')
			tracer.startSpan('still-admitted').end()
			expect(processor.onEnd).toHaveBeenCalledOnce()

			const retry = expect(tracer.forceFlush()).rejects.toThrow('Tracing forceFlush timed out')
			await vi.advanceTimersByTimeAsync(10_000)
			await retry
			expect(processor.flush).toHaveBeenCalledOnce()
		} finally { vi.useRealTimers() }
	})

	it('does not assimilate thenables returned by a custom processor', async() => {
		const then = vi.fn()
		const {tracer, processor} = setup()
		processor.flush.mockImplementation(() => ({then}) as never)
		processor.shutdown.mockImplementation(() => ({then}) as never)

		await expect(tracer.forceFlush()).rejects.toThrow('must return a native Promise')
		await expect(tracer.shutdown()).rejects.toThrow('must return a native Promise')
		expect(then).not.toHaveBeenCalled()
	})

	it('does not assimilate thenables returned by a custom context store', async() => {
		const then = vi.fn()
		const {tracer} = setup({
			contextStore: {
				get: () => undefined,
				run: (_value: unknown, fn: () => unknown) => {
					fn()
					return {then}
				}
			}
		})

		await expect(tracer.inSpan('hostile-context', async() => undefined))
			.rejects.toThrow('must return a native Promise')
		expect(then).not.toHaveBeenCalled()
	})

	it('drains accepted manual spans, rejects later admission, and closes idempotently', async() => {
		const {tracer, processor} = setup()
		const active = tracer.startSpan('active')
		const first = tracer.shutdown()
		expect(tracer.getStatus()).toMatchObject({state: 'draining', activeSpans: 1})
		tracer.startSpan('late').end()
		expect(processor.shutdown).not.toHaveBeenCalled()
		active.end()
		await Promise.all([first, tracer.shutdown()])
		expect(processor.shutdown).toHaveBeenCalledOnce()
		expect(tracer.getStatus()).toMatchObject({state: 'closed', activeSpans: 0, sinkState: 'closed'})
	})

	it('keeps failed finalization retryable without reopening admission', async() => {
		const {tracer, processor} = setup()
		processor.shutdown.mockRejectedValueOnce(new Error('close failed')).mockResolvedValue(undefined)
		await expect(tracer.shutdown()).rejects.toThrow('close failed')
		expect(tracer.getStatus()).toMatchObject({state: 'draining', sinkState: 'unhealthy'})
		tracer.startSpan('late').end()
		await tracer.shutdown()
		expect(processor.shutdown).toHaveBeenCalledTimes(2)
		expect(processor.onEnd).not.toHaveBeenCalled()
	})

	it('finalizes the processor after an active-span drain timeout and does not repeat the wait', async() => {
		vi.useFakeTimers()
		try {
			const {tracer, processor} = setup()
			const active = tracer.startSpan('never-ended-during-drain')
			const closing = tracer.shutdown()
			const rejected = expect(closing).rejects.toThrow('Tracing active span drain timed out')

			await vi.advanceTimersByTimeAsync(10_000)
			await rejected
			expect(processor.shutdown).toHaveBeenCalledOnce()
			expect(tracer.getStatus()).toMatchObject({state: 'draining', activeSpans: 1})

			await expect(tracer.shutdown()).resolves.toBeUndefined()
			expect(processor.shutdown).toHaveBeenCalledOnce()
			expect(tracer.getStatus()).toMatchObject({state: 'closed', activeSpans: 1, sinkState: 'closed'})
			active.end()
			expect(tracer.getStatus().activeSpans).toBe(0)
		} finally { vi.useRealTimers() }
	})

	it('bounds and single-flights a custom processor shutdown that never settles', async() => {
		vi.useFakeTimers()
		try {
			const {tracer, processor} = setup()
			processor.shutdown.mockImplementation(async() => await new Promise<void>(() => undefined))

			const firstShutdown = expect(tracer.shutdown()).rejects.toThrow('Tracing processor shutdown timed out')
			await vi.advanceTimersByTimeAsync(30_000)
			await firstShutdown
			expect(processor.shutdown).toHaveBeenCalledOnce()
			expect(tracer.getStatus().state).toBe('draining')
			await expect(tracer.forceFlush()).rejects.toThrow('unavailable after shutdown admission closes')
			expect(processor.flush).not.toHaveBeenCalled()

			const retry = expect(tracer.shutdown()).rejects.toThrow('Tracing processor shutdown timed out')
			await vi.advanceTimersByTimeAsync(30_000)
			await retry
			expect(processor.shutdown).toHaveBeenCalledOnce()
		} finally { vi.useRealTimers() }
	})

	it('drains an active forceFlush before processor cleanup and still cleans up after timeout', async() => {
		vi.useFakeTimers()
		try {
			const {tracer, processor} = setup()
			processor.flush.mockImplementation(async() => await new Promise<void>(() => undefined))
			const flushing = expect(tracer.forceFlush()).rejects.toThrow('Tracing forceFlush timed out')
			await vi.advanceTimersByTimeAsync(0)

			const shuttingDown = expect(tracer.shutdown()).rejects.toThrow('Tracing active forceFlush drain timed out')
			expect(processor.shutdown).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(10_000)
			await Promise.all([flushing, shuttingDown])
			expect(processor.shutdown).toHaveBeenCalledOnce()
		} finally { vi.useRealTimers() }
	})

	it('does not start a queued forceFlush after shutdown closes admission', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const {tracer, processor} = setup()
		processor.flush.mockImplementationOnce(async() => await gate)
		const firstFlush = tracer.forceFlush()
		const queuedFlush = tracer.forceFlush()
		await vi.waitFor(() => expect(processor.flush).toHaveBeenCalledOnce())
		const shutdown = tracer.shutdown()
		release()

		await expect(firstFlush).resolves.toBeUndefined()
		await expect(shutdown).resolves.toBeUndefined()
		await expect(queuedFlush).resolves.toBeUndefined()
		expect(processor.flush).toHaveBeenCalledOnce()
		expect(processor.shutdown).toHaveBeenCalledOnce()
	})

	it('does not create detached observability records after shutdown admission closes', async() => {
		const {tracer, processor} = setup()
		await tracer.shutdown()

		tracer.recordException(new Error('late'), {traceId: 'a'.repeat(32)})
		await tracer.withExtractedHeaders({
			traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
		}, async() => {
			tracer.addBreadcrumb({category: 'late', message: 'late', level: 'info'})
			tracer.linkExternal({traceId: 'c'.repeat(32), spanId: 'd'.repeat(16)})
		})

		expect(processor.onEnd).not.toHaveBeenCalled()
	})

	it('maps processor telemetry to bounded frozen status without raw errors', () => {
		const {tracer, getObserver} = setup()
		const observer = getObserver()
		observer.onRetry()
		observer.onSinkState('degraded')
		expect(tracer.getStatus()).toMatchObject({retriedTotal: 1, sinkState: 'degraded'})
		observer.onExportFailure(Object.assign(new Error('secret'), {code: 'REMOTE_UNAVAILABLE'}))
		const failed = tracer.getStatus()
		expect(failed).toMatchObject({sinkState: 'unhealthy', lastFailureCode: 'REMOTE_UNAVAILABLE'})
		expect(Object.isFrozen(failed)).toBe(true)
		expect(JSON.stringify(failed)).not.toContain('secret')
		observer.onExported(1)
		expect(tracer.getStatus()).toMatchObject({sinkState: 'healthy'})
		expect(tracer.getStatus()).not.toHaveProperty('lastFailureCode')
	})

	it('rejects removed per-span and extraction policy bags deterministically', async() => {
		const {tracer} = setup()
		expect(() => tracer.startSpan('legacy', {sample: true} as never)).toThrow('closed plain data object')
		await expect((tracer.withExtractedHeaders as never)({}, async() => undefined, {format: 'b3'}))
			.resolves.toBeUndefined()
	})
})
