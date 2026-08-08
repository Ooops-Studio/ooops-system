import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {estimateSpanSize, snapshotSpanExportResult, snapshotSpanRecord} from '../../src/core/processor-utils'
import {BatchingProcessor, SimpleProcessor} from '../../src/core/processors'
import {createResilientExporter} from '../../src/core/transferring'

const span = (name = 'span'): SpanRecord => ({
	name, kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
	startTime: 0, endTime: 1, durationMs: 1, attributes: {}, status: {code: 'ok'}, events: []
})

describe('tracing processors', () => {
	it('rejects Proxy exporters without invoking capability traps', () => {
		const descriptor = vi.fn(() => { throw new Error('descriptor trap executed') })
		const exporter = new Proxy({}, {getOwnPropertyDescriptor: descriptor})

		expect(() => new SimpleProcessor(exporter as never)).toThrow('must provide data-method')
		expect(descriptor).not.toHaveBeenCalled()
	})

	it('does not assimilate thenables returned by custom exporters', async() => {
		const then = vi.fn()
		for (const kind of ['simple', 'batch'] as const) {
			const exporter = {
				export: vi.fn(() => ({then})),
				shutdown: vi.fn(async() => undefined)
			} as never
			const processor = kind === 'simple'
				? new SimpleProcessor(exporter)
				: new BatchingProcessor(exporter, {
					maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000
				}, createFixedClock(0))
			processor.onEnd(span(kind))
			await expect(processor.flush()).rejects.toThrow('must return a native Promise')
		}
		expect(then).not.toHaveBeenCalled()
	})

	it('does not assimilate thenables returned by exporter finalizers', async() => {
		const then = vi.fn()
		const processor = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			flush: vi.fn(() => ({then})),
			shutdown: vi.fn(() => ({then}))
		} as never)

		await expect(processor.flush()).rejects.toThrow('must return a native Promise')
		await expect(processor.shutdown()).rejects.toThrow('Tracing processor shutdown failed')
		expect(then).not.toHaveBeenCalled()
	})

	it('rejects hostile numeric batching values without invoking coercion hooks', () => {
		let coercions = 0
		const hostile = {[Symbol.toPrimitive]: () => { coercions++; return 1 }}
		const exporter = {export: vi.fn(), shutdown: vi.fn()}
		expect(() => new BatchingProcessor(exporter, {
			maxBatch: hostile as never, maxIntervalMs: 1, maxBytes: 1
		}, createFixedClock(0))).toThrow('maxBatch must be between')
		expect(coercions).toBe(0)
	})

	it('tracks direct export success, drop, rejection, flush, and shutdown', async() => {
		const exporter = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'success', acceptedCount: 1})
				.mockResolvedValueOnce({status: 'retryable', acceptedCount: 0, error: new Error('drop')})
				.mockRejectedValueOnce(new Error('offline')),
			shutdown: vi.fn(async() => undefined)
		} as never
		const observer = {onExported: vi.fn(), onDropped: vi.fn(), onExportFailure: vi.fn()}
		const processor = new SimpleProcessor(exporter)
		processor.setObserver(observer)
		processor.onEnd(span('ok'))
		processor.onEnd(span('drop'))
		processor.onEnd(span('reject'))
		await expect(processor.flush()).rejects.toThrow('offline')
		expect(observer.onExported).toHaveBeenCalledWith(1)
		expect(observer.onDropped).toHaveBeenCalledTimes(2)
		expect(observer.onExportFailure).toHaveBeenCalledWith(expect.any(Error))
		await processor.shutdown()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('isolates synchronous exporter and observer failures from span completion', async() => {
		const processor = new SimpleProcessor({
			export: () => { throw new Error('sync') }, shutdown: vi.fn()
		} as never, {
			onExportFailure: () => { throw new Error('observer') },
			onDropped: () => { throw new Error('observer') }
		})
		expect(() => processor.onEnd(span())).not.toThrow()
		await expect(processor.flush()).rejects.toThrow('sync')
	})

	it('observes rejected native promises returned by processor observers', async() => {
		const rejected = () => Promise.reject(new Error('async observer failure'))
		const observer = {
			onExported: vi.fn(rejected), onDropped: vi.fn(rejected),
			onExportFailure: vi.fn(rejected), onPartialDelivery: vi.fn(rejected)
		} as never
		const success = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			shutdown: vi.fn()
		}, observer)
		success.onEnd(span('observer-success'))
		await success.flush()
		const failure = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'retryable' as const, acceptedCount: 0})),
			shutdown: vi.fn()
		}, observer)
		failure.onEnd(span('observer-failure'))
		await expect(failure.flush()).rejects.toThrow('retryable')
		await Promise.resolve()
		expect(observer.onExported).toHaveBeenCalled()
		expect(observer.onExportFailure).toHaveBeenCalled()
		expect(observer.onDropped).toHaveBeenCalled()
	})

	it('preserves a successful direct flush when timer cleanup fails', async() => {
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
			throw new Error('timer cleanup unavailable')
		})
		try {
			const processor = new SimpleProcessor({
				export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
				shutdown: vi.fn(async() => undefined)
			})
			processor.onEnd(span())
			await expect(processor.flush()).resolves.toBeUndefined()
		} finally { cleanup.mockRestore() }
	})

	it('immediately drains an admitted batch when interval scheduling fails', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const scheduling = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 1_234) throw new Error('timer unavailable')
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const exporter = {
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			shutdown: vi.fn(async() => undefined)
		}
		try {
			const processor = new BatchingProcessor(
				exporter, {maxBatch: 2, maxIntervalMs: 1_234, maxBytes: 10_000}, createFixedClock(0)
			)
			expect(() => processor.onEnd(span())).not.toThrow()
			await expect(processor.flush()).resolves.toBeUndefined()
			expect(exporter.export).toHaveBeenCalledOnce()
		} finally { scheduling.mockRestore() }
	})

	it('does not retain an already-fired synchronous interval handle', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const scheduling = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 1_234) {
				Reflect.apply(callback as (...values: unknown[]) => void, undefined, args)
				return {unref: vi.fn()} as never
			}
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const exporter = {
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			shutdown: vi.fn(async() => undefined)
		}
		try {
			const processor = new BatchingProcessor(
				exporter, {maxBatch: 2, maxIntervalMs: 1_234, maxBytes: 10_000}, createFixedClock(0)
			)
			processor.onEnd(span('first'))
			await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(1))
			processor.onEnd(span('second'))
			await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		} finally { scheduling.mockRestore() }
	})

	it('accounts only the unaccepted remainder of partial batches', async() => {
		const exporter = {
			export: vi.fn(async() => ({status: 'partial' as const, acceptedCount: 2, error: new Error('one rejected')})),
			shutdown: vi.fn(async() => undefined)
		}
		const observer = {onExported: vi.fn(), onDropped: vi.fn(), onExportFailure: vi.fn()}
		const processor = new BatchingProcessor(exporter, {maxBatch: 3, maxIntervalMs: 10_000, maxBytes: 10_000}, createFixedClock(0))
		processor.setObserver(observer)
		processor.onEnd(span('a')); processor.onEnd(span('b')); processor.onEnd(span('c'))
		await expect(processor.flush()).rejects.toThrow('one rejected')
		expect(observer.onExported).toHaveBeenCalledWith(2)
		expect(observer.onDropped).toHaveBeenCalledWith(1, expect.any(Error), true)
	})

	it('covers successful manual flushes, immutable rejections, and isolated batch observers', async() => {
		const success = new BatchingProcessor({
			export: vi.fn(async(spans) => ({status: 'success' as const, acceptedCount: spans.length})),
			shutdown: vi.fn()
		}, {maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000}, createFixedClock(0))
		success.onEnd(span())
		await expect(success.flush()).resolves.toBeUndefined()

		const primitive = new BatchingProcessor({
			export: vi.fn(async() => { throw 'offline' }), shutdown: vi.fn()
		} as never, {maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000}, createFixedClock(0))
		primitive.onEnd(span())
		await expect(primitive.flush()).rejects.toThrow('offline')

		const observers = new BatchingProcessor({
			export: vi.fn(async() => ({status: 'partial' as const, acceptedCount: 1})), shutdown: vi.fn()
		}, {maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000}, createFixedClock(0))
		observers.setObserver({
			onExported: () => { throw new Error('observer') },
			onExportFailure: () => { throw new Error('observer') },
			onDropped: () => { throw new Error('observer') }
		})
		observers.onEnd(span('one'))
		observers.onEnd(span('two'))
		await expect(observers.flush()).rejects.toThrow('partial')
	})

	it('validates bounds and permanently closes batching admission after shutdown starts', async() => {
		const config = {maxBatch: 2, maxIntervalMs: 5, maxBytes: 500}
		const clock = createFixedClock(0)
		expect(() => new BatchingProcessor({} as never, {...config, maxBatch: 0}, clock)).toThrow('maxBatch')
		expect(() => new BatchingProcessor({} as never, {...config, maxBatch: 100_001}, clock)).toThrow('maxBatch')
		expect(() => new BatchingProcessor({} as never, {...config, maxIntervalMs: 0}, clock)).toThrow('maxIntervalMs')
		expect(() => new BatchingProcessor({} as never, {...config, maxIntervalMs: 2_147_483_648}, clock)).toThrow('maxIntervalMs')
		expect(() => new BatchingProcessor({} as never, {...config, maxBytes: 0}, clock)).toThrow('maxBytes')
		expect(() => new BatchingProcessor({} as never, {...config, maxBytes: 100_000_001}, clock)).toThrow('maxBytes')
		const exporter = {export: vi.fn(async() => { throw new Error('export') }), shutdown: vi.fn(async() => { throw new Error('shutdown') })}
		const processor = new BatchingProcessor(exporter, config, clock)
		processor.onEnd(span())
		expect(processor.getQueueSize()).toBe(1)
		await expect(processor.shutdown()).rejects.toThrow('Tracing processor shutdown failed')
		processor.onEnd(span('retryable'))
		expect(processor.getQueueSize()).toBe(0)
	})

	it('keeps direct admission closed while finalization remains retryable', async() => {
		const exporter = {
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			shutdown: vi.fn().mockRejectedValueOnce(new Error('shutdown failed')).mockResolvedValue(undefined)
		}
		const processor = new SimpleProcessor(exporter)
		await expect(processor.shutdown()).rejects.toThrow('Tracing processor shutdown failed')
		processor.onEnd(span('retryable'))
		await expect(processor.flush()).resolves.toBeUndefined()
		await expect(processor.shutdown()).resolves.toBeUndefined()
		expect(exporter.export).not.toHaveBeenCalled()
	})

	it('closes a direct exporter even when shutdown drain fails', async() => {
		const exporter = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'retryable', acceptedCount: 0, error: new Error('drain failed')})
				.mockResolvedValueOnce({status: 'success', acceptedCount: 1}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new SimpleProcessor(exporter as never)
		processor.onEnd(span('failed-drain'))
		await expect(processor.shutdown()).rejects.toThrow('Tracing processor shutdown failed')
		expect(exporter.shutdown).toHaveBeenCalledOnce()

		processor.onEnd(span('retryable'))
		await expect(processor.shutdown()).resolves.toBeUndefined()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('closes a batching exporter even when shutdown drain fails', async() => {
		const exporter = {
			export: vi.fn()
				.mockRejectedValueOnce(new Error('drain failed'))
				.mockImplementation(async(spans: readonly SpanRecord[]) => ({status: 'success', acceptedCount: spans.length})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000
		}, createFixedClock(0))
		processor.onEnd(span('failed-drain'))
		await expect(processor.shutdown()).rejects.toThrow('Tracing processor shutdown failed')
		expect(exporter.shutdown).toHaveBeenCalledOnce()

		processor.onEnd(span('retryable'))
		await expect(processor.shutdown()).resolves.toBeUndefined()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('surfaces a completed background export failure to the next explicit flush', async() => {
		const processor = new BatchingProcessor({
			export: vi.fn(async() => ({
				status: 'retryable' as const,
				acceptedCount: 0,
				error: new Error('background export failed')
			})),
			shutdown: vi.fn(async() => undefined)
		}, {maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 10_000}, createFixedClock(0))

		processor.onEnd(span())
		await new Promise<void>((resolve) => setImmediate(resolve))

		await expect(processor.flush()).rejects.toThrow('background export failed')
	})

	it('does not surface a joined background export failure twice', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const failure = new Error('joined background export failed')
		const processor = new BatchingProcessor({
			export: vi.fn(async() => {
				await gate
				return {status: 'retryable' as const, acceptedCount: 0, error: failure}
			}),
			shutdown: vi.fn(async() => undefined)
		}, {maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 10_000}, createFixedClock(0))

		processor.onEnd(span())
		const flush = processor.flush()
		release()

		await expect(flush).rejects.toThrow('joined background export failed')
		await expect(processor.flush()).resolves.toBeUndefined()
	})

	it('drops a single span that exceeds the bounded batch budget', async() => {
		const exporter = {
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			shutdown: vi.fn(async() => undefined)
		}
		const observer = {onDropped: vi.fn(), onExportFailure: vi.fn()}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 2, maxIntervalMs: 10_000, maxBytes: 500
		}, createFixedClock(0))
		processor.setObserver(observer)
		processor.onEnd({...span('too-large'), attributes: {payload: 'x'.repeat(10_000)}})

		expect(processor.getQueueSize()).toBe(0)
		expect(exporter.export).not.toHaveBeenCalled()
		expect(observer.onDropped).toHaveBeenCalledWith(1, expect.any(Error), true)
		await expect(processor.flush()).rejects.toThrow('maximum batch size')
	})

	it('accounts for UTF-8 and event payload bytes when enforcing the batch budget', async() => {
		const exporter = {
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 2, maxIntervalMs: 10_000, maxBytes: 500
		}, createFixedClock(0))
		processor.onEnd({
			...span('event-too-large'),
			events: [{name: 'payload', timestamp: 1, attributes: {text: '😀'.repeat(200)}}]
		})

		expect(processor.getQueueSize()).toBe(0)
		expect(exporter.export).not.toHaveBeenCalled()
		await expect(processor.flush()).rejects.toThrow('maximum batch size')
	})

	it('drains spans queued after a background failure before surfacing that failure', async() => {
		const exporter = {
			export: vi.fn()
				.mockResolvedValueOnce({status: 'retryable', acceptedCount: 0, error: new Error('first failed')})
				.mockImplementation(async(spans: readonly SpanRecord[]) => ({status: 'success', acceptedCount: spans.length})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter as never, {
			maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 10_000
		}, createFixedClock(0))
		processor.onEnd(span('failed'))
		await new Promise<void>((resolve) => setImmediate(resolve))
		processor.onEnd(span('later'))

		await expect(processor.flush()).rejects.toThrow('first failed')
		expect(exporter.export).toHaveBeenCalledTimes(2)
		expect(exporter.export.mock.calls[1]?.[0]).toEqual([expect.objectContaining({name: 'later'})])
	})

	it('estimates primitive, event, link, and complex span shapes', () => {
		expect(estimateSpanSize(span())).toBeGreaterThan(0)
		expect(estimateSpanSize({...span(), attributes: {s: 'text', n: 1, b: true}, events: [{name: 'e', timestamp: 1}], links: [{context: {traceId: 'c'.repeat(32), spanId: 'd'.repeat(16)}}]})).toBeGreaterThan(300)
		expect(estimateSpanSize({...span(), attributes: {nested: {safe: true}} as never})).toBeGreaterThan(0)
		const cyclic = span('cyclic-size')
		;(cyclic.attributes as Record<string, unknown>).self = cyclic.attributes
		expect(estimateSpanSize(cyclic)).toBe(Number.POSITIVE_INFINITY)
		expect(snapshotSpanRecord(undefined as never)).toBeUndefined()
	})

	it('rejects hostile processor record graphs and snapshots JSON edge values deterministically', () => {
		const values: unknown[] = [1, 'deleted', undefined]
		delete values[1]
		const edge = {
			...span('edge'),
			attributes: {finite: 1, nonFinite: Number.NaN, omitted: undefined, values}
		} as never
		expect(snapshotSpanRecord(edge)?.attributes).toEqual({
			finite: 1, nonFinite: null, values: [1, null, null]
		})

		const rejects = (attributes: unknown): void => {
			expect(snapshotSpanRecord({...span(), attributes} as never)).toBeUndefined()
		}
		const symbolObject = {[Symbol('secret')]: true}
		const customArray: unknown[] = []
		Object.defineProperty(customArray, 'secret', {value: true, enumerable: true})
		const accessorArray = Object.defineProperty([], '0', {enumerable: true, get: () => 'secret'})
		Object.defineProperty(accessorArray, 'length', {value: 1})
		expect(snapshotSpanRecord({...span(), attributes: symbolObject} as never)?.attributes).toEqual({})
		rejects(new Date())
		// JSON array indices are the data boundary; custom fields are ignored
		// without invoking an unbounded ownKeys enumeration.
		expect(snapshotSpanRecord({...span(), attributes: customArray} as never)?.attributes).toEqual([])
		rejects(accessorArray)
		rejects(new Array(10_001))
		rejects(Object.fromEntries(Array.from({length: 1_001}, (_, index) => [`k${index}`, index])))
		let descriptorReads = 0
		const wide = new Proxy(Object.fromEntries(Array.from({length: 5_000}, (_, index) => [`k${index}`, index])), {
			getOwnPropertyDescriptor: (target, key) => {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		rejects(wide)
		expect(descriptorReads).toBeLessThan(3_100)
		let deep: unknown = 'leaf'
		for (let depth = 0; depth < 33; depth++) deep = {deep}
		rejects(deep)
	})

	it('does not enumerate symbol fields in span records or exporter results', () => {
		const symbols = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`hidden-${index}`), index]
		))
		const enumerateSymbols = vi.spyOn(Object, 'getOwnPropertySymbols')
			.mockImplementation(() => [])
		let recordSnapshot: SpanRecord | undefined
		let exportResult: ReturnType<typeof snapshotSpanExportResult>
		let enumerationCalls = 0
		try {
			recordSnapshot = snapshotSpanRecord({...span(), attributes: symbols} as never)
			Object.defineProperties(symbols, {
				status: {value: 'success', enumerable: true},
				acceptedCount: {value: 1, enumerable: true}
			})
			exportResult = snapshotSpanExportResult(symbols, 1)
			enumerationCalls = enumerateSymbols.mock.calls.length
		} finally { enumerateSymbols.mockRestore() }
		expect(recordSnapshot?.attributes).toEqual({})
		expect(exportResult!).toMatchObject({status: 'success', acceptedCount: 1})
		expect(enumerationCalls).toBe(0)
	})

	it('bounds and snapshots custom exporter failures before retaining them', async() => {
		let messageReads = 0
		const accessorError = Object.defineProperty(new Error('hidden'), 'message', {
			configurable: true,
			get: () => { messageReads++; return 'secret' }
		})
		const result = snapshotSpanExportResult({
			status: 'retryable', acceptedCount: 0, error: accessorError
		}, 1)
		expect(result.error?.message).toBe('Tracing exporter reported a failure')
		expect(messageReads).toBe(0)

		const hugeFailure = 'x'.repeat(1_000_000)
		const direct = new SimpleProcessor({
			export: async() => { throw hugeFailure }, shutdown: async() => undefined
		})
		direct.onEnd(span('bounded-failure'))
		let failure: unknown
		try { await direct.flush() } catch(error) { failure = error }
		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toHaveLength(1_024)
	})

	it('rejects an oversized aggregate string graph before serialization or UTF-8 allocation', async() => {
		const encode = vi.spyOn(TextEncoder.prototype, 'encode')
		const oversized = {
			...span('oversized-strings'),
			attributes: {payload: 'x'.repeat(16 * 1_024 * 1_024 + 1)}
		} as SpanRecord
		const exporter = {
			export: vi.fn(async(batch: readonly SpanRecord[]) => ({status: 'success' as const, acceptedCount: batch.length})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new SimpleProcessor(exporter)

		expect(snapshotSpanRecord(oversized)).toBeUndefined()
		processor.onEnd(oversized)
		await expect(processor.flush()).rejects.toThrow('unsafe span record')
		expect(encode.mock.calls.every(([value]) => value.length <= 16 * 1_024 * 1_024)).toBe(true)
		expect(exporter.export).not.toHaveBeenCalled()
		encode.mockRestore()
	})

	it('rejects oversized nested keys before regex or serialization work', () => {
		const encode = vi.spyOn(TextEncoder.prototype, 'encode')
		const key = 'x'.repeat(100_000)
		const hostile = {
			...span('oversized-key'), attributes: {[key]: true}
		} as SpanRecord
		expect(snapshotSpanRecord(hostile)).toBeUndefined()
		expect(encode.mock.calls.every(([value]) => value.length <= 1_024)).toBe(true)
		encode.mockRestore()
	})

	it('delivers canonical frozen span records through the processor boundary', async() => {
		const exporter = {export: vi.fn(async(spans) => ({status: 'success' as const, acceptedCount: spans.length})), shutdown: vi.fn()}
		const direct = new SimpleProcessor(exporter)
		const input = Object.freeze({...span('canonical'), attributes: Object.freeze({safe: 'value'}), events: Object.freeze([])})
		direct.onEnd(input)
		await direct.flush()
		expect(exporter.export.mock.calls[0]?.[0]).toEqual([input])
		expect(Object.isFrozen(exporter.export.mock.calls[0]?.[0])).toBe(true)
	})

	it('snapshots processor input before caller mutation can bypass export safety', async() => {
		const exporter = {
			export: vi.fn(async(spans) => ({status: 'success' as const, acceptedCount: spans.length})),
			shutdown: vi.fn(async() => undefined)
		}
		const direct = new SimpleProcessor(exporter)
		const directAttributes = {nested: {value: 'before'}, authorization: undefined as unknown}
		const directInput = {...span('direct-snapshot'), attributes: directAttributes} as SpanRecord
		direct.onEnd(directInput)
		directAttributes.nested.value = 'after'
		directAttributes.authorization = 'Bearer leaked-after-onEnd'
		await direct.flush()
		expect(exporter.export.mock.calls[0]?.[0]?.[0]?.attributes).toEqual({nested: {value: 'before'}})
		expect(Object.isFrozen(exporter.export.mock.calls[0]?.[0]?.[0]?.attributes)).toBe(true)

		const batched = new BatchingProcessor(exporter, {
			maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000
		}, createFixedClock(0))
		const batchAttributes = {value: 'before'}
		const batchInput = {...span('batch-snapshot'), attributes: batchAttributes} as SpanRecord
		batched.onEnd(batchInput)
		batchAttributes.value = 'after'
		await batched.flush()
		expect(exporter.export.mock.calls[1]?.[0]?.[0]?.attributes).toEqual({value: 'before'})
	})

	it('rejects unsafe span records before exporter admission', async() => {
		const exporter = {
			export: vi.fn(async(spans) => ({status: 'success' as const, acceptedCount: spans.length})),
			shutdown: vi.fn(async() => undefined)
		}
		const unsafe = span('unsafe-input')
		;(unsafe.attributes as Record<string, unknown>).self = unsafe.attributes
		const direct = new SimpleProcessor(exporter)
		direct.onEnd(unsafe)
		await expect(direct.flush()).rejects.toThrow('unsafe span record')
		expect(exporter.export).not.toHaveBeenCalled()

		const batched = new BatchingProcessor(exporter, {
			maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000
		}, createFixedClock(0))
		batched.onEnd(unsafe)
		await expect(batched.flush()).rejects.toThrow('unsafe span record')
		expect(exporter.export).not.toHaveBeenCalled()
	})

	it('does not invoke span accessors or toJSON in the processor hot path', async() => {
		let getterCalls = 0
		let toJsonCalls = 0
		const hostile = Object.defineProperties(span('hostile'), {
			name: {enumerable: true, get: () => { getterCalls++; return 'leaked' }},
			toJSON: {enumerable: true, value: () => { toJsonCalls++; return span('leaked') }}
		}) as SpanRecord
		const exporter = {
			export: vi.fn(async(batch: readonly SpanRecord[]) => ({status: 'success' as const, acceptedCount: batch.length})),
			shutdown: vi.fn()
		}
		const processor = new SimpleProcessor(exporter as never)

		processor.onEnd(hostile)
		await expect(processor.flush()).rejects.toThrow('unsafe span record')
		expect(getterCalls).toBe(0)
		expect(toJsonCalls).toBe(0)
		expect(exporter.export).not.toHaveBeenCalled()
	})

	it('coalesces concurrent processor shutdown and remains idempotent', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const exporter = {export: vi.fn(), shutdown: vi.fn(async() => await gate)}
		const processor = new SimpleProcessor(exporter as never)
		const first = processor.shutdown()
		const second = processor.shutdown()
		release()
		await Promise.all([first, second])
		await processor.shutdown()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('accounts for spans ending after shutdown admission has closed', async() => {
		let releaseDirect!: () => void
		const directGate = new Promise<void>((resolve) => { releaseDirect = resolve })
		const directObserver = {onDropped: vi.fn()}
		const direct = new SimpleProcessor({
			export: vi.fn(), shutdown: vi.fn(async() => await directGate)
		} as never, directObserver)
		const directShutdown = direct.shutdown()
		direct.onEnd(span('late-direct'))
		expect(directObserver.onDropped).toHaveBeenCalledWith(1, expect.any(Error))
		releaseDirect()
		await directShutdown

		let releaseBatch!: () => void
		const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve })
		const batchObserver = {onDropped: vi.fn()}
		const batch = new BatchingProcessor({
			export: vi.fn(), shutdown: vi.fn(async() => await batchGate)
		} as never, {maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000}, createFixedClock(0))
		batch.setObserver(batchObserver)
		const batchShutdown = batch.shutdown()
		batch.onEnd(span('late-batch'))
		expect(batchObserver.onDropped).toHaveBeenCalledWith(1, expect.any(Error), true)
		releaseBatch()
		await batchShutdown
	})

	it('surfaces the same export failure to concurrent flush callers', async() => {
		const processor = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'retryable', acceptedCount: 0, error: new Error('offline')})),
			shutdown: vi.fn()
		} as never)
		processor.onEnd(span())
		const [first, second] = await Promise.allSettled([processor.flush(), processor.flush()])
		expect(first.status).toBe('rejected')
		expect(second.status).toBe('rejected')
	})

	it('bounds the queued batch while a previous export is still in flight', async() => {
		let releaseFirst!: () => void
		const firstExport = new Promise<void>((resolve) => { releaseFirst = resolve })
		const exporter = {
			export: vi.fn()
				.mockImplementationOnce(async() => {
					await firstExport
					return {status: 'success' as const, acceptedCount: 2}
				})
				.mockImplementation(async(spans: readonly SpanRecord[]) => ({
					status: 'success' as const, acceptedCount: spans.length
				})),
			shutdown: vi.fn(async() => undefined)
		}
		const observer = {onDropped: vi.fn()}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 2, maxIntervalMs: 10_000, maxBytes: 10_000
		}, createFixedClock(0))
		processor.setObserver(observer)

		processor.onEnd(span('first')); processor.onEnd(span('second'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(1))
		processor.onEnd(span('queued-1')); processor.onEnd(span('queued-2'))
		processor.onEnd(span('must-drop'))

		expect(processor.getQueueSize()).toBe(2)
		expect(observer.onDropped).toHaveBeenCalledWith(1, expect.any(Error), true)
		releaseFirst()
		await expect(processor.flush()).rejects.toThrow('queue capacity exceeded')
		expect(exporter.export).toHaveBeenCalledTimes(2)
	})

	it('coalesces background drain requests and drains the second-stage queue without new traffic', async() => {
		let releaseFirst!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const exporter = {
			export: vi.fn()
				.mockImplementationOnce(async() => {
					await firstGate
					return {status: 'success' as const, acceptedCount: 1}
				})
				.mockImplementation(async(spans: readonly SpanRecord[]) => ({
					status: 'success' as const, acceptedCount: spans.length
				})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 10_000
		}, createFixedClock(0))

		processor.onEnd(span('first'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		processor.onEnd(span('second-stage'))
		for (let index = 0; index < 100; index++) processor.onEnd(span(`overflow-${index}`))
		expect(processor.getQueueSize()).toBe(1)

		releaseFirst()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		expect(exporter.export.mock.calls[1]?.[0]).toEqual([expect.objectContaining({name: 'second-stage'})])
		expect(processor.getQueueSize()).toBe(0)
	})

	it('does not let traffic admitted during an export starve an explicit flush', async() => {
		let releaseFirst!: () => void
		const firstExport = new Promise<void>((resolve) => { releaseFirst = resolve })
		const exporter = {
			export: vi.fn()
				.mockImplementationOnce(async(spans: readonly SpanRecord[]) => {
					await firstExport
					return {status: 'success' as const, acceptedCount: spans.length}
				})
				.mockImplementation(async(spans: readonly SpanRecord[]) => ({
					status: 'success' as const, acceptedCount: spans.length
				})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 100, maxIntervalMs: 10_000, maxBytes: 100_000
		}, createFixedClock(0))
		processor.onEnd(span('before-flush'))
		const flush = processor.flush()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		processor.onEnd(span('during-export'))
		releaseFirst()
		await expect(flush).resolves.toBeUndefined()
		expect(processor.getQueueSize()).toBe(1)
		expect(exporter.export).toHaveBeenCalledTimes(1)
		await expect(processor.flush()).resolves.toBeUndefined()
		expect(exporter.export).toHaveBeenCalledTimes(2)
	})

	it('uses a fixed direct-export barrier so later traffic cannot extend a flush', async() => {
		let releaseFirst!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		let releaseSecond!: () => void
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		const exporter = {
			export: vi.fn()
				.mockImplementationOnce(async() => {
					await firstGate
					return {status: 'success' as const, acceptedCount: 1}
				})
				.mockImplementationOnce(async() => {
					await secondGate
					return {status: 'success' as const, acceptedCount: 1}
				}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new SimpleProcessor(exporter)
		processor.onEnd(span('before-flush'))
		const flush = processor.flush()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		processor.onEnd(span('after-flush'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		releaseFirst()
		await expect(flush).resolves.toBeUndefined()
		releaseSecond()
		await expect(processor.flush()).resolves.toBeUndefined()
	})

	it('does not let a direct flush consume a failure admitted after its barrier', async() => {
		let releaseFirst!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const exporter = {
			export: vi.fn(async(spans: readonly SpanRecord[]) => {
				if (spans[0]?.name === 'before-barrier') {
					await firstGate
					return {status: 'success' as const, acceptedCount: 1}
				}
				return {status: 'retryable' as const, acceptedCount: 0, error: new Error('later failure')}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new SimpleProcessor(exporter)
		processor.onEnd(span('before-barrier'))
		const firstFlush = processor.flush()
		processor.onEnd(span('after-barrier'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		releaseFirst()

		await expect(firstFlush).resolves.toBeUndefined()
		await expect(processor.flush()).rejects.toThrow('later failure')
	})

	it('retains a newer direct failure when an older barrier export fails later', async() => {
		let releaseOlder!: () => void
		const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve })
		const exporter = {
			export: vi.fn(async(spans: readonly SpanRecord[]) => {
				if (spans[0]?.name === 'older') {
					await olderGate
					return {status: 'retryable' as const, acceptedCount: 0, error: new Error('older failure')}
				}
				return {status: 'retryable' as const, acceptedCount: 0, error: new Error('newer failure')}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new SimpleProcessor(exporter)
		processor.onEnd(span('older'))
		const firstFlush = processor.flush()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		processor.onEnd(span('newer'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		releaseOlder()

		await expect(firstFlush).rejects.toThrow('older failure')
		await expect(processor.flush()).rejects.toThrow('newer failure')
	})

	it('retains a newer batching failure while acknowledging an older pending failure', async() => {
		let releaseBarrier!: () => void
		const barrierGate = new Promise<void>((resolve) => { releaseBarrier = resolve })
		const exporter = {
			export: vi.fn(async(spans: readonly SpanRecord[]) => {
				if (spans[0]?.name === 'older-failed') {
					return {status: 'retryable' as const, acceptedCount: 0, error: new Error('older batching failure')}
				}
				await barrierGate
				return {status: 'success' as const, acceptedCount: spans.length}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 100_000
		}, createFixedClock(0))
		processor.onEnd(span('older-failed'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		processor.onEnd(span('barrier'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		const firstFlush = processor.flush()
		const unsafe = span('newer-unsafe')
		;(unsafe.attributes as Record<string, unknown>).self = unsafe.attributes
		processor.onEnd(unsafe)
		releaseBarrier()

		await expect(firstFlush).rejects.toThrow('older batching failure')
		await expect(processor.flush()).rejects.toThrow('unsafe span record')
	})

	it('retains a newer failed batch claimed after an older flush barrier', async() => {
		let releaseOlder!: () => void
		const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve })
		const exporter = {
			export: vi.fn(async(spans: readonly SpanRecord[]) => {
				if (spans[0]?.name === 'older-background') {
					await olderGate
					return {status: 'retryable' as const, acceptedCount: 0, error: new Error('older background failure')}
				}
				return {status: 'retryable' as const, acceptedCount: 0, error: new Error('newer claimed failure')}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 100_000
		}, createFixedClock(0))
		processor.onEnd(span('older-background'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		const firstFlush = processor.flush()
		processor.onEnd(span('newer-claimed'))
		releaseOlder()

		await expect(firstFlush).rejects.toThrow('older background failure')
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		await expect(processor.flush()).rejects.toThrow('newer claimed failure')
	})

	it('does not let a batching flush consume an unsafe record admitted after its barrier', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const exporter = {
			export: vi.fn(async(spans: readonly SpanRecord[]) => {
				await gate
				return {status: 'success' as const, acceptedCount: spans.length}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000
		}, createFixedClock(0))
		processor.onEnd(span('before-barrier'))
		const firstFlush = processor.flush()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		const unsafe = span('after-barrier')
		;(unsafe.attributes as Record<string, unknown>).self = unsafe.attributes
		processor.onEnd(unsafe)
		release()

		await expect(firstFlush).resolves.toBeUndefined()
		await expect(processor.flush()).rejects.toThrow('unsafe span record')
	})

	it('gives concurrent direct flush callers independent admission barriers', async() => {
		let releaseFirst!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		let releaseSecond!: () => void
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		const exporter = {
			export: vi.fn()
				.mockImplementationOnce(async() => {
					await firstGate
					return {status: 'success' as const, acceptedCount: 1}
				})
				.mockImplementationOnce(async() => {
					await secondGate
					return {status: 'success' as const, acceptedCount: 1}
				}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new SimpleProcessor(exporter)

		processor.onEnd(span('first'))
		const firstFlush = processor.flush()
		processor.onEnd(span('second'))
		const secondFlush = processor.flush()
		let secondResolved = false
		void secondFlush.then(() => { secondResolved = true })

		releaseFirst()
		await expect(firstFlush).resolves.toBeUndefined()
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(secondResolved).toBe(false)

		releaseSecond()
		await expect(secondFlush).resolves.toBeUndefined()
	})

	it('bounds concurrent direct exports when an exporter hangs', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const exporter = {
			export: vi.fn(async() => {
				await gate
				return {status: 'success' as const, acceptedCount: 1}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const observer = {onExportFailure: vi.fn(), onDropped: vi.fn()}
		const processor = new SimpleProcessor(exporter, observer, 1)
		processor.onEnd(span('active'))
		processor.onEnd(span('must-drop'))

		expect(exporter.export).toHaveBeenCalledTimes(0)
		expect(observer.onDropped).toHaveBeenCalledWith(1, expect.any(Error))
		release()
		await expect(processor.flush()).rejects.toThrow('capacity exceeded')
		expect(exporter.export).toHaveBeenCalledOnce()
		expect(() => new SimpleProcessor(exporter, undefined, 0)).toThrow('maxActiveExports')
	})

	it('snapshots batching policy instead of retaining caller-owned configuration', async() => {
		const config = {maxBatch: 2, maxIntervalMs: 10_000, maxBytes: 10_000}
		const exporter = {
			export: vi.fn(async(spans: readonly SpanRecord[]) => ({
				status: 'success' as const, acceptedCount: spans.length
			})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, config, createFixedClock(0))
		config.maxBatch = 100
		processor.onEnd(span('one')); processor.onEnd(span('two'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		expect(exporter.export.mock.calls[0]?.[0]).toHaveLength(2)
	})

	it('gives concurrent batching flush callers independent admission barriers', async() => {
		let releaseFirst!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const exporter = {
			export: vi.fn()
				.mockImplementationOnce(async(spans: readonly SpanRecord[]) => {
					await firstGate
					return {status: 'success' as const, acceptedCount: spans.length}
				})
				.mockImplementation(async(spans: readonly SpanRecord[]) => ({
					status: 'success' as const, acceptedCount: spans.length
				})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 100_000
		}, createFixedClock(0))
		processor.onEnd(span('first'))
		const firstFlush = processor.flush()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		processor.onEnd(span('second'))
		const secondFlush = processor.flush()
		releaseFirst()
		await firstFlush
		await secondFlush
		expect(exporter.export).toHaveBeenCalledTimes(2)
		expect(exporter.export.mock.calls[1]?.[0]?.[0]?.name).toBe('second')
	})

	it('does not resolve a concurrent batching barrier before a newly claimed export', async() => {
		let releaseFirst!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		let releaseSecond!: () => void
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		const exporter = {
			export: vi.fn()
				.mockImplementationOnce(async(spans: readonly SpanRecord[]) => {
					await firstGate
					return {status: 'success' as const, acceptedCount: spans.length}
				})
				.mockImplementationOnce(async(spans: readonly SpanRecord[]) => {
					await secondGate
					return {status: 'success' as const, acceptedCount: spans.length}
				}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 100_000
		}, createFixedClock(0))

		processor.onEnd(span('first'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		processor.onEnd(span('second'))
		const firstFlush = processor.flush()
		const secondFlush = processor.flush()
		let secondResolved = false
		void secondFlush.then(() => { secondResolved = true })

		releaseFirst()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2))
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(secondResolved).toBe(false)

		releaseSecond()
		await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([undefined, undefined])
	})

	it('drains a later batching barrier after the export it joined fails', async() => {
		let releaseFirst!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const exporter = {
			export: vi.fn()
				.mockImplementationOnce(async() => {
					await firstGate
					return {status: 'retryable' as const, acceptedCount: 0, error: new Error('first failed')}
				})
				.mockImplementationOnce(async(spans: readonly SpanRecord[]) => ({
					status: 'success' as const, acceptedCount: spans.length
				})),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 100_000
		}, createFixedClock(0))

		processor.onEnd(span('first'))
		const firstFlush = processor.flush()
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())
		processor.onEnd(span('second'))
		const secondFlush = processor.flush()

		releaseFirst()
		await expect(firstFlush).rejects.toThrow('first failed')
		await expect(secondFlush).rejects.toThrow('first failed')
		expect(exporter.export).toHaveBeenCalledTimes(2)
		expect(exporter.export.mock.calls[1]?.[0]?.[0]?.name).toBe('second')
		expect(processor.getQueueSize()).toBe(0)
	})

	it.each([undefined, -1, 2, 0.5])('rejects invalid direct exporter acceptedCount %s', async(acceptedCount) => {
		const observer = {onExportFailure: vi.fn(), onDropped: vi.fn()}
		const processor = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'success', acceptedCount})),
			shutdown: vi.fn()
		} as never, observer)
		processor.onEnd(span())
		await expect(processor.flush()).rejects.toThrow('invalid acceptedCount')
		expect(observer.onExportFailure).toHaveBeenCalled()
		expect(observer.onDropped).toHaveBeenCalled()
	})

	it('isolates every direct processor observer callback', async() => {
		const processor = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'success', acceptedCount: 1})),
			shutdown: vi.fn()
		}, {onExported: () => { throw new Error('observer') }})
		processor.onEnd(span())
		await expect(processor.flush()).resolves.toBeUndefined()

		const rejected = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'partial', acceptedCount: 0})),
			shutdown: vi.fn()
		} as never, {
			onDropped: () => { throw new Error('observer') },
			onExportFailure: () => { throw new Error('observer') }
		})
		rejected.onEnd(span())
		await expect(rejected.flush()).rejects.toThrow('Tracing export partial')
	})

	it('captures exporter capabilities once and rejects accessor-backed methods without invoking them', async() => {
		const originalExport = vi.fn(async(spans: readonly SpanRecord[]) => ({
			status: 'success' as const, acceptedCount: spans.length
		}))
		const originalShutdown = vi.fn(async() => undefined)
		const exporter = {export: originalExport, shutdown: originalShutdown}
		const direct = new SimpleProcessor(exporter)
		exporter.export = vi.fn(async() => { throw new Error('rewired export') })
		exporter.shutdown = vi.fn(async() => { throw new Error('rewired shutdown') })
		direct.onEnd(span('stable'))
		await direct.flush()
		await direct.shutdown()
		expect(originalExport).toHaveBeenCalledOnce()
		expect(originalShutdown).toHaveBeenCalledOnce()

		let getterCalls = 0
		const hostile = Object.defineProperties({}, {
			export: {enumerable: true, get: () => { getterCalls++; return originalExport }},
			shutdown: {enumerable: true, value: originalShutdown}
		})
		expect(() => new SimpleProcessor(hostile as never)).toThrow(/data-method/u)
		expect(getterCalls).toBe(0)
	})

	it('rejects invalid exporter statuses before counting spans as exported and snapshots observers', async() => {
		const originalExported = vi.fn()
		const replacementExported = vi.fn()
		const observer = {onExported: originalExported, onExportFailure: vi.fn(), onDropped: vi.fn()}
		const direct = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'invented', acceptedCount: 1})), shutdown: vi.fn()
		} as never)
		direct.setObserver(observer)
		observer.onExported = replacementExported
		direct.onEnd(span())
		await expect(direct.flush()).rejects.toThrow('invalid status')
		expect(originalExported).not.toHaveBeenCalled()
		expect(replacementExported).not.toHaveBeenCalled()

		const batch = new BatchingProcessor({
			export: vi.fn(async() => ({status: 'invented', acceptedCount: 1})), shutdown: vi.fn()
		} as never, {maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000}, createFixedClock(0))
		batch.setObserver(observer)
		batch.onEnd(span())
		await expect(batch.flush()).rejects.toThrow('invalid status')
		expect(originalExported).not.toHaveBeenCalled()

		let getterCalls = 0
		const accessorObserver = Object.defineProperty({}, 'onExported', {
			enumerable: true, get: () => { getterCalls++; return originalExported }
		})
		expect(() => direct.setObserver(accessorObserver as never)).not.toThrow()
		expect(getterCalls).toBe(0)
	})

	it('snapshots direct processor observers supplied at construction', async() => {
		const original = vi.fn()
		const replacement = vi.fn()
		const observer = {onExported: original}
		const processor = new SimpleProcessor({
			export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
			shutdown: vi.fn(async() => undefined)
		}, observer)
		observer.onExported = replacement

		processor.onEnd(span())
		await processor.flush()
		expect(original).toHaveBeenCalledWith(1)
		expect(replacement).not.toHaveBeenCalled()
	})

	it('does not invoke accessor-backed exporter outcome fields in either processor', async() => {
		let reads = 0
		const makeResult = () => Object.defineProperty({status: 'success'}, 'acceptedCount', {
			enumerable: true,
			get: () => { reads++; return 1 }
		})
		const direct = new SimpleProcessor({
			export: vi.fn(async() => makeResult() as never), shutdown: vi.fn(async() => undefined)
		})
		direct.onEnd(span('direct-accessor-result'))
		await expect(direct.flush()).rejects.toThrow('accessor-backed result')

		const batch = new BatchingProcessor({
			export: vi.fn(async() => makeResult() as never), shutdown: vi.fn(async() => undefined)
		}, {maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 100_000}, createFixedClock(0))
		batch.onEnd(span('batch-accessor-result'))
		await expect(batch.flush()).rejects.toThrow('accessor-backed result')
		expect(reads).toBe(0)
	})

	it('bounds prototype traversal when an exporter rejects with a hostile object', async() => {
		let prototypeReads = 0
		let hostile!: object
		hostile = new Proxy({}, {
			getPrototypeOf: () => {
				prototypeReads++
				if (prototypeReads > 40) throw new Error('unbounded prototype traversal')
				return hostile
			}
		})
		const processor = new SimpleProcessor({
			export: vi.fn(async() => await Promise.reject(hostile)),
			shutdown: vi.fn(async() => undefined)
		} as never)

		processor.onEnd(span('hostile-rejection'))
		await expect(processor.flush()).rejects.toThrow('Tracing exporter threw an opaque value')
		expect(prototypeReads).toBeLessThanOrEqual(33)
	})

	it('does not wait for a configured multi-day retry backoff during processor shutdown', async() => {
		const exporter = {
			export: vi.fn(async() => ({status: 'retryable' as const, acceptedCount: 0, error: new Error('offline')})),
			shutdown: vi.fn(async() => undefined)
		}
		const resilient = createResilientExporter({
			exporter,
			retryPolicy: {
				maxAttempts: 10,
				baseDelayMs: 2_147_483_647,
				multiplier: 1,
				maxDelayMs: 2_147_483_647,
				jitter: 0,
				attemptTimeoutMs: 0
			},
			tokenBucketRate: 100,
			tokenBucketBurst: 100,
			breakerThreshold: 2,
			breakerHalfOpenTimeout: 100,
			clock: createFixedClock(0),
			monotonicClock: {now: () => 0}
		})
		const processor = new SimpleProcessor(resilient)
		processor.onEnd(span('shutdown-backoff'))
		await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce())

		await expect(processor.shutdown()).rejects.toThrow('Tracing processor shutdown failed')
		expect(exporter.export).toHaveBeenCalledOnce()
		await expect(processor.shutdown()).resolves.toBeUndefined()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('bounds a custom exporter that never settles shutdown', async() => {
		vi.useFakeTimers()
		try {
			const exporter = {
				export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 1})),
				shutdown: vi.fn(async() => await new Promise<void>(() => undefined))
			}
			const processor = new SimpleProcessor(exporter)

			const shuttingDown = processor.shutdown()
			const rejected = expect(shuttingDown).rejects.toThrow('Tracing processor shutdown failed')
			await vi.advanceTimersByTimeAsync(15_000)
			await rejected
			processor.onEnd(span('closed-after-timeout'))
			expect(exporter.export).not.toHaveBeenCalled()
		} finally { vi.useRealTimers() }
	})

	it('does not duplicate indeterminate exporter shutdown across processor retries', async() => {
		vi.useFakeTimers()
		try {
			for (const kind of ['simple', 'batch'] as const) {
				let release!: () => void
				const shutdownGate = new Promise<void>((resolve) => { release = resolve })
				const exporter = {
					export: vi.fn(async() => ({status: 'success' as const, acceptedCount: 0})),
					shutdown: vi.fn(async() => await shutdownGate)
				}
				const processor = kind === 'simple'
					? new SimpleProcessor(exporter)
					: new BatchingProcessor(exporter, {
						maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000
					}, createFixedClock(0))

				const first = expect(processor.shutdown()).rejects.toThrow('Tracing processor shutdown failed')
				await vi.advanceTimersByTimeAsync(15_000)
				await first

				const retry = processor.shutdown()
				await vi.advanceTimersByTimeAsync(0)
				expect(exporter.shutdown).toHaveBeenCalledOnce()
				release()
				await retry
				expect(exporter.shutdown).toHaveBeenCalledOnce()
			}
		} finally { vi.useRealTimers() }
	})

	it('bounds public processor flush barriers when custom exports never settle', async() => {
		vi.useFakeTimers()
		try {
			const exporter = {
				export: vi.fn(async() => await new Promise<never>(() => undefined)),
				shutdown: vi.fn(async() => undefined)
			}
			const direct = new SimpleProcessor(exporter)
			const batched = new BatchingProcessor(exporter, {
				maxBatch: 10, maxIntervalMs: 10_000, maxBytes: 10_000
			}, createFixedClock(0))
			direct.onEnd(span('direct-stalled-flush'))
			batched.onEnd(span('batch-stalled-flush'))

			const directFlush = expect(direct.flush()).rejects.toThrow('Tracing processor drain timed out')
			const batchFlush = expect(batched.flush()).rejects.toThrow('Tracing processor drain timed out')
			await vi.advanceTimersByTimeAsync(10_000)
			await Promise.all([directFlush, batchFlush])
		} finally { vi.useRealTimers() }
	})

	it('interrupts an unbounded physical attempt and bounds its failed cleanup', async() => {
		vi.useFakeTimers()
		try {
			const exporter = {
				export: vi.fn(async() => await new Promise<never>(() => undefined)),
				shutdown: vi.fn(async() => undefined)
			}
			const resilient = createResilientExporter({
				exporter,
				retryPolicy: {
					maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0,
					jitter: 0, attemptTimeoutMs: 0
				},
				tokenBucketRate: 100,
				tokenBucketBurst: 100,
				breakerThreshold: 2,
				breakerHalfOpenTimeout: 100,
				clock: createFixedClock(0),
				monotonicClock: {now: () => 0}
			})
			const processor = new SimpleProcessor(resilient)
			processor.onEnd(span('stalled-attempt'))
			await vi.advanceTimersByTimeAsync(0)
			expect(exporter.export).toHaveBeenCalledOnce()

			const shuttingDown = processor.shutdown()
			const rejected = expect(shuttingDown).rejects.toThrow('Tracing processor shutdown failed')
			await vi.advanceTimersByTimeAsync(10_000)
			await rejected
			expect(exporter.shutdown).toHaveBeenCalledOnce()
			await expect(resilient.export([span()])).resolves.toMatchObject({
				status: 'permanent-failure', acceptedCount: 0
			})
		} finally { vi.useRealTimers() }
	})

	it('bounds a stalled direct custom export before invoking its cancellation shutdown', async() => {
		vi.useFakeTimers()
		try {
			let release!: () => void
			const physical = new Promise<void>((resolve) => { release = resolve })
			const exporter = {
				export: vi.fn(async() => {
					await physical
					return {status: 'success' as const, acceptedCount: 1}
				}),
				flush: vi.fn(async() => undefined),
				shutdown: vi.fn(async() => { release() })
			}
			const processor = new SimpleProcessor(exporter)
			processor.onEnd(span('stalled-custom-export'))
			await vi.advanceTimersByTimeAsync(0)
			expect(exporter.export).toHaveBeenCalledOnce()

			const shuttingDown = processor.shutdown()
			const rejected = expect(shuttingDown).rejects.toThrow('Tracing processor shutdown failed')
			await vi.advanceTimersByTimeAsync(10_000)
			await rejected
			expect(exporter.shutdown).toHaveBeenCalledOnce()
			expect(exporter.flush).not.toHaveBeenCalled()
			await expect(processor.shutdown()).resolves.toBeUndefined()
			expect(exporter.shutdown).toHaveBeenCalledOnce()
		} finally { vi.useRealTimers() }
	})

	it('does not start a queued batch after finalization begins', async() => {
		vi.useFakeTimers()
		try {
			let release!: (result: {status: 'success'; acceptedCount: number}) => void
			const physical = new Promise<{status: 'success'; acceptedCount: number}>((resolve) => { release = resolve })
			const exporter = {
				export: vi.fn(async() => await physical),
				flush: vi.fn(async() => undefined),
				shutdown: vi.fn(async() => { release({status: 'success', acceptedCount: 1}) })
			}
			const processor = new BatchingProcessor(exporter, {
				maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 10_000
			}, createFixedClock(0))
			processor.onEnd(span('active'))
			processor.onEnd(span('queued'))
			await vi.advanceTimersByTimeAsync(0)
			expect(exporter.export).toHaveBeenCalledOnce()
			expect(processor.getQueueSize()).toBe(1)

			const shuttingDown = processor.shutdown()
			const rejected = expect(shuttingDown).rejects.toThrow('Tracing processor shutdown failed')
			await vi.advanceTimersByTimeAsync(10_000)
			await rejected
			expect(exporter.export).toHaveBeenCalledOnce()
			expect(exporter.flush).not.toHaveBeenCalled()
			expect(processor.getQueueSize()).toBe(0)
		} finally { vi.useRealTimers() }
	})

	it('keeps batching ownership when an exporter replaces array mutation methods', async() => {
		const nativePush = Array.prototype.push
		const nativeSplice = Array.prototype.splice
		let rewired = false
		const exporter = {
			export: vi.fn(async(spans: readonly SpanRecord[]) => {
				if (!rewired) {
					Object.defineProperty(Array.prototype, 'push', {
						configurable: true,
						value(this: unknown[], value: unknown) {
							if ((value as {name?: unknown})?.name === 'second') throw new Error('poisoned push')
							return nativePush.call(this, value)
						}
					})
					Object.defineProperty(Array.prototype, 'splice', {
						configurable: true,
						value(this: unknown[], start: number, deleteCount?: number) {
							if ((this[0] as {name?: unknown})?.name === 'second') throw new Error('poisoned splice')
							return deleteCount === undefined
								? nativeSplice.call(this, start)
								: nativeSplice.call(this, start, deleteCount)
						}
					})
					rewired = true
				}
				return {status: 'success' as const, acceptedCount: spans.length}
			}),
			shutdown: vi.fn(async() => undefined)
		}
		const processor = new BatchingProcessor(exporter, {
			maxBatch: 1, maxIntervalMs: 10_000, maxBytes: 10_000
		}, createFixedClock(0))

		try {
			processor.onEnd(span('first'))
			await processor.flush()
			expect(() => processor.onEnd(span('second'))).not.toThrow()
			await expect(processor.flush()).resolves.toBeUndefined()
			expect(exporter.export).toHaveBeenCalledTimes(2)
		} finally {
			Object.defineProperty(Array.prototype, 'push', {
				configurable: true, writable: true, value: nativePush
			})
			Object.defineProperty(Array.prototype, 'splice', {
				configurable: true, writable: true, value: nativeSplice
			})
		}
	})
})
