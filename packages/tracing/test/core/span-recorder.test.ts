import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {SpanRecorder} from '../../src/core/span-recorder'
import {
	isValidSpanContext,
	snapshotSpanAttributesDetailed,
	snapshotSpanValue
} from '../../src/core/span-recorder-safety'
import {createSpanRedaction} from '../../src/features/redaction/span-redaction'

const context = {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1}
const options = (overrides = {}) => ({
	clock: createFixedClock(100), maxAttributes: 2, maxEvents: 1, maxAttrBytes: 100, ...overrides
})

describe('SpanRecorder', () => {
	it('reports span-context validity through the safe snapshot boundary', () => {
		expect(isValidSpanContext(context)).toBe(true)
		expect(isValidSpanContext({...context, spanId: '0'.repeat(16)})).toBe(false)
	})

	it('snapshots bounded arrays without invoking accessors', () => {
		const sparse: unknown[] = [1, 'deleted', undefined]
		delete sparse[1]
		expect(snapshotSpanValue(sparse)).toEqual([1, null, null])
		expect(snapshotSpanValue(Array.from({length: 101}, (_, index) => index))).toEqual([
			...Array.from({length: 100}, (_, index) => index), '[Truncated]'
		])
		let reads = 0
		const accessor = Object.defineProperty([], '0', {
			enumerable: true, configurable: true, get: () => { reads++; return 'secret' }
		})
		Object.defineProperty(accessor, 'length', {value: 1})
		expect(snapshotSpanValue(accessor)).toBeUndefined()
		expect(reads).toBe(0)
		expect(snapshotSpanValue(new Date())).toBeUndefined()
		expect(snapshotSpanValue({[Symbol('hidden')]: true})).toEqual({})
		const cyclic: Record<string, unknown> = {safe: true}
		cyclic.self = cyclic
		expect(snapshotSpanValue(cyclic)).toEqual({safe: true})
	})

	it('ignores symbol-only attribute fields without materializing a symbol-key array', () => {
		const symbols = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`hidden-${index}`), index]
		))
		const enumerateSymbols = vi.spyOn(Object, 'getOwnPropertySymbols')
			.mockImplementation(() => [])
		let valueSnapshot: unknown
		let attributeSnapshot: ReturnType<typeof snapshotSpanAttributesDetailed>
		let enumerationCalls = 0
		try {
			valueSnapshot = snapshotSpanValue(symbols)
			attributeSnapshot = snapshotSpanAttributesDetailed(symbols, 1, 100)
			enumerationCalls = enumerateSymbols.mock.calls.length
		} finally { enumerateSymbols.mockRestore() }
		expect(valueSnapshot).toEqual({})
		expect(attributeSnapshot!).toEqual({attributes: {}, droppedCount: 0})
		expect(enumerationCalls).toBe(0)
	})

	it('bounds descriptor inspection for very wide attribute objects', () => {
		const wide = Object.fromEntries(Array.from({length: 1_000}, (_, index) => [`key-${index}`, index]))
		let descriptorReads = 0
		const observed = new Proxy(wide, {
			getOwnPropertyDescriptor: (target, key) => {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		const snapshot = snapshotSpanAttributesDetailed(observed, 1, 1_000)
		expect(snapshot).toEqual({attributes: undefined, droppedCount: 1})
		expect(descriptorReads).toBe(0)
	})

	it('rejects inherited attribute containers before enumerating prototype fields', () => {
		let getterCalls = 0
		const prototype = Object.defineProperty({}, 'inherited', {
			enumerable: true,
			get: () => { getterCalls++; return 'secret' }
		})
		const attributes = Object.assign(Object.create(prototype) as Record<string, unknown>, {safe: 'value'})

		expect(snapshotSpanAttributesDetailed(attributes, 10, 1_000)).toEqual({
			attributes: undefined,
			droppedCount: 1
		})
		expect(getterCalls).toBe(0)
	})

	it('bounds recursive snapshots before inspecting wide nested values', () => {
		const wide = Object.fromEntries(Array.from({length: 1_000}, (_, index) => [`key-${index}`, index]))
		let objectDescriptorReads = 0
		const observedObject = new Proxy(wide, {
			getOwnPropertyDescriptor: (target, key) => {
				objectDescriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		expect(snapshotSpanValue(observedObject)).toBeUndefined()
		expect(objectDescriptorReads).toBe(0)

		let arrayDescriptorReads = 0
		const observedArray = new Proxy(Array.from({length: 1_000}, (_, index) => index), {
			getOwnPropertyDescriptor: (target, key) => {
				arrayDescriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		expect(snapshotSpanValue(observedArray)).toEqual([
			...Array.from({length: 100}, (_, index) => index), '[Truncated]'
		])
		expect(arrayDescriptorReads).toBeLessThan(110)
	})

	it('rejects oversized nested attribute keys before retaining them', () => {
		const oversizedKey = 'x'.repeat(1_000_000)
		expect(snapshotSpanValue({[oversizedKey]: 'secret', safe: 'value'})).toEqual({safe: 'value'})
	})

	it('shares one string budget across an entire nested attribute graph', () => {
		const snapshot = snapshotSpanValue(Array(100).fill('x'.repeat(16_000)))
		const serialized = JSON.stringify(snapshot)
		expect(serialized.length).toBeLessThan(17_000)
	})

	it('rejects exponentially amplifying shared attribute graphs within a global node budget', () => {
		let value: unknown = 'leaf'
		for (let depth = 0; depth < 8; depth++) value = Array(100).fill(value)

		expect(snapshotSpanValue(value)).toBeUndefined()
	})

	it('records bounded attributes, events, links, parent, resource, and stable finalization', () => {
		const recorder = new SpanRecorder('work', 'server', {...context}, options())
		recorder.setParentContext({...context, spanId: 'c'.repeat(16)})
		recorder.setParentContext(undefined)
		recorder.setResource({service: 'api'})
		recorder.setAttribute('one', 1)
		recorder.setAttribute('one', 2)
		recorder.setAttribute('two', true)
		recorder.setAttribute('three', 3)
		recorder.addEvent('first', {ok: true})
		recorder.addEvent('second')
		for (let index = 1; index <= 129; index++) recorder.addLink({context: {...context, spanId: index.toString(16).padStart(16, '0')}})
		recorder.setStatus({code: 'ok'})
		const record = recorder.end(150)
		expect(record).toMatchObject({durationMs: 50, droppedAttributesCount: 1, droppedEventsCount: 1, droppedLinksCount: 1})
		expect(record.links).toHaveLength(128)
		expect(Object.isFrozen(record)).toBe(true)
		expect(Object.isFrozen(record.events)).toBe(true)
		expect(recorder.end(200)).toBe(record)
		recorder.setAttribute('late', 'ignored'); recorder.addEvent('late'); recorder.addLink({context}); recorder.recordException(new Error('late')); recorder.setStatus({code: 'error'})
		expect(recorder.end()).toBe(record)
	})

	it('clamps an implicit regressed epoch clock without losing the span', () => {
		let now = 100
		const recorder = new SpanRecorder('clock-regression', 'internal', {...context}, options({
			clock: {now: () => now}
		}))
		now = 90

		expect(recorder.end()).toMatchObject({startTime: 100, endTime: 100, durationMs: 0})
		const explicit = new SpanRecorder('explicit-time', 'internal', {...context}, options())
		expect(() => explicit.end(99)).toThrow('must be >= startTime')
	})

	it('truncates strings that can fit and drops values that cannot', () => {
		const recorder = new SpanRecorder('limits', 'internal', {...context}, options({maxAttributes: 5, maxAttrBytes: 45}))
		recorder.setAttribute('message', 'x'.repeat(80))
		recorder.setAttribute('object', {huge: 'x'.repeat(100)} as never)
		const record = recorder.end()
		expect(record.droppedAttributesCount).toBeGreaterThanOrEqual(1)
		expect(JSON.stringify(record.attributes).length).toBeLessThanOrEqual(45)
	})

	it('does not let inherited object keys bypass the attribute-count limit', () => {
		const recorder = new SpanRecorder('prototype-key', 'internal', {...context}, options({
			maxAttributes: 0,
			maxAttrBytes: 1_000
		}))
		recorder.setAttribute('toString', 'must-be-dropped')

		expect(recorder.end().attributes).toEqual({})
	})

	it('records exceptions and applies redaction to span, event, link, resource, and status', () => {
		const redact = vi.fn((attrs: Record<string, unknown>) => Object.fromEntries(Object.keys(attrs).map((key) => [key, 'safe'])))
		const recorder = new SpanRecorder('secure', 'internal', {...context}, options({maxAttributes: 20, maxEvents: 5, maxAttrBytes: 2_000, redactAttributes: redact}))
		recorder.recordException(new Error('secret'), {token: 'secret'})
		recorder.addLink({context, attributes: {token: 'secret'}})
		recorder.setResource({authorization: 'secret'})
		recorder.setStatus({code: 'error', description: 'secret'})
		const record = recorder.end()
		expect(Object.values(record.attributes)).not.toContain('secret')
		expect(record.events[0]?.attributes).toBeDefined()
		expect(record.links?.[0]?.attributes).toEqual({token: 'safe'})
		expect(record.resource).toEqual({authorization: 'safe'})
		expect(record.status.description).toBe('safe')
		expect(record.name).toBe('safe')
	})

	it('redacts sensitive event names before they cross an exporter boundary', () => {
		const recorder = new SpanRecorder('secure', 'internal', {...context}, options({
			maxAttributes: 10,
			maxEvents: 2,
			maxAttrBytes: 2_000,
			redactAttributes: createSpanRedaction()
		}))
		recorder.addEvent('https://example.com/callback?token=raw-secret')

		const record = recorder.end()
		expect(record.events[0]?.name).toBe('[REDACTED]')
		expect(JSON.stringify(record)).not.toContain('raw-secret')
	})

	it('rejects accessor-backed links without executing their fields', () => {
		let reads = 0
		const link = Object.defineProperties({}, {
			context: {enumerable: true, get: () => { reads++; return context }},
			attributes: {enumerable: true, get: () => { reads++; return {token: 'secret'} }}
		})
		const recorder = new SpanRecorder('hostile-link', 'internal', {...context}, options())

		recorder.addLink(link as never)

		expect(reads).toBe(0)
		expect(recorder.end()).toMatchObject({droppedLinksCount: 1})
	})

	it('does not let custom exception attributes overwrite canonical diagnostics', () => {
		const recorder = new SpanRecorder('exception', 'internal', {...context}, options({
			maxAttributes: 20, maxEvents: 3, maxAttrBytes: 2_000
		}))
		recorder.recordException(new TypeError('actual'), {
			'exception.type': 'ForgedError',
			'exception.message': 'forged'
		})
		expect(recorder.end().events[0]?.attributes).toEqual(expect.objectContaining({
			'exception.type': 'TypeError',
			'exception.message': 'actual'
		}))
	})

	it('falls back to full masking when custom redaction throws', () => {
		const report = vi.fn()
		const recorder = new SpanRecorder('fallback', 'internal', {...context}, options({
			maxAttributes: 10, maxEvents: 3, maxAttrBytes: 1_000,
			redactAttributes: () => { throw new Error('redactor') }, errors: {report} as never
		}))
		recorder.setAttribute('password', 'secret')
		recorder.addEvent('event', {token: 'secret'})
		recorder.addLink({context, attributes: {cookie: 'secret'}})
		recorder.setResource({authorization: 'secret'})
		recorder.setStatus({code: 'error', description: 'secret'})
		const record = recorder.end()
		expect(record.attributes).toEqual({password: '***'})
		expect(record.events[0]?.attributes).toEqual({token: '***'})
		expect(record.links?.[0]?.attributes).toEqual({cookie: '***'})
		expect(record.resource).toEqual({authorization: '***'})
		expect(record.status.description).toBe('***')
		expect(report).toHaveBeenCalled()
	})

	it.each([
		['an array', () => []],
		['a non-plain object', () => new Date()]
	])('falls back to masking when a custom redactor returns %s', (_label, redact) => {
		const report = vi.fn()
		const recorder = new SpanRecorder('fallback', 'internal', {...context}, options({
			maxAttributes: 10, maxEvents: 1, maxAttrBytes: 1_000,
			redactAttributes: redact as never, errors: {report} as never
		}))
		recorder.setAttribute('token', 'secret')

		expect(recorder.end().attributes).toEqual({token: '***'})
		expect(report).toHaveBeenCalled()
	})

	it('never invokes accessors or toJSON returned by a hostile custom redactor', () => {
		let accessorCalls = 0
		let toJsonCalls = 0
		const report = vi.fn()
		const recorder = new SpanRecorder('fallback', 'internal', {...context}, options({
			maxAttributes: 10, maxEvents: 3, maxAttrBytes: 1_000,
			redactAttributes: () => Object.defineProperties({}, {
				password: {enumerable: true, get: () => { accessorCalls++; return 'leaked' }},
				toJSON: {enumerable: true, value: () => { toJsonCalls++; return {password: 'leaked'} }}
			}) as never,
			errors: {report} as never
		}))
		recorder.setAttribute('password', 'secret')

		expect(recorder.end().attributes).toEqual({password: '***'})
		expect(accessorCalls).toBe(0)
		expect(toJsonCalls).toBe(0)
		expect(report).toHaveBeenCalled()
	})

	it('reapplies configured count and byte limits after custom redaction', () => {
		const report = vi.fn()
		const recorder = new SpanRecorder('bounded-redaction', 'internal', {...context}, options({
			maxAttributes: 2,
			maxEvents: 2,
			maxAttrBytes: 80,
			redactAttributes: (attributes: Record<string, unknown>) => ({
				...attributes,
				expanded: 'x'.repeat(1_000)
			}),
			errors: {report} as never
		}))
		recorder.setAttribute('token', 'secret')
		recorder.addEvent('event', {password: 'secret'})
		recorder.addLink({context, attributes: {cookie: 'secret'}})
		recorder.setStatus({code: 'error', description: 's'.repeat(1_024)})

		const record = recorder.end()
		const totalBytes = [record.attributes, ...record.events.map((event) => event.attributes),
			...(record.links ?? []).map((link) => link.attributes)]
			.filter((attributes): attributes is Record<string, unknown> => attributes !== undefined)
			.reduce((total, attributes) => total + Buffer.byteLength(JSON.stringify(attributes)), 0)
		expect(totalBytes).toBeLessThanOrEqual(80)
		expect(record.attributes).toEqual({token: '***'})
		expect(record.status.description?.length).toBeLessThanOrEqual(1_024)
		expect(JSON.stringify(record)).not.toContain('secret')
		expect(report).toHaveBeenCalled()
	})

	it('rejects invalid explicit end times', () => {
		const recorder = new SpanRecorder('invalid', 'internal', {...context}, options({startTime: 100}))
		expect(() => recorder.end(Number.NaN)).toThrow('finite non-negative')
		expect(() => recorder.end(Number.MAX_VALUE)).toThrow('finite non-negative')
		expect(() => recorder.end(99)).toThrow('must be >= startTime')
		recorder.setAttribute('recovered', true)
		expect(recorder.end(101)).toMatchObject({endTime: 101, attributes: {recovered: true}})
	})

	it('rejects timestamps that cannot be serialized as safe OTLP epoch milliseconds', () => {
		expect(() => new SpanRecorder('unsafe-start', 'internal', {...context}, options({
			startTime: Number.MAX_VALUE
		}))).toThrow('finite non-negative')
		const timestamps = [100, Number.MAX_VALUE, 101]
		const recorder = new SpanRecorder('unsafe-clock', 'internal', {...context}, options({
			clock: {now: () => timestamps.shift()!}
		}))
		expect(() => recorder.addEvent('unsafe-event')).not.toThrow()
		expect(recorder.end()).toMatchObject({events: [], droppedEventsCount: 1, endTime: 101})
	})

	it('does not let hostile thrown values break exception recording', () => {
		const hostile = {toString: () => { throw new Error('toString') }}
		const recorder = new SpanRecorder('hostile', 'internal', {...context}, options({
			maxAttributes: 10, maxEvents: 3, maxAttrBytes: 1_000
		}))
		expect(() => recorder.recordException(hostile)).not.toThrow()
		expect(recorder.end().attributes['error.message']).toBe('[unavailable]')
		const stringify = vi.spyOn(BigInt.prototype, 'toString')
		const bigintRecorder = new SpanRecorder('bigint', 'internal', {...context}, options({
			maxAttributes: 10, maxEvents: 3, maxAttrBytes: 1_000
		}))
		bigintRecorder.recordException(1n)
		expect(bigintRecorder.end().attributes['error.message']).toBe('[bigint]')
		expect(stringify).not.toHaveBeenCalled()
	})

	it('bounds cyclic prototype traversal while describing exceptions', () => {
		let prototypeReads = 0
		let hostile!: Error
		hostile = new Proxy(new Error('bounded'), {
			getPrototypeOf: () => { prototypeReads++; return hostile }
		})
		const recorder = new SpanRecorder('hostile-prototype', 'internal', {...context}, options({
			maxAttributes: 10, maxEvents: 2, maxAttrBytes: 1_000
		}))

		expect(() => recorder.recordException(hostile)).not.toThrow()
		expect(recorder.end().attributes['error.message']).toBe('bounded')
		expect(prototypeReads).toBe(33)
	})

	it('does not let hostile custom exception attributes escape recording', () => {
		const attributes = new Proxy({}, {ownKeys: () => { throw new Error('ownKeys') }})
		const recorder = new SpanRecorder('hostile-attributes', 'internal', {...context}, options({
			maxAttributes: 10, maxEvents: 3, maxAttrBytes: 1_000
		}))
		expect(() => recorder.recordException(new Error('failure'), attributes)).not.toThrow()
		const record = recorder.end()
		expect(record.status.code).toBe('error')
		expect(record.events).toHaveLength(1)
	})

	it('snapshots caller-owned span metadata before finalization', () => {
		const parent = {...context, spanId: 'c'.repeat(16)}
		const status = {code: 'error' as const, description: 'original'}
		const resource = {service: 'api'}
		const link = {context: {...context, spanId: 'd'.repeat(16)}, attributes: {tenant: 'one'}}
		const recorder = new SpanRecorder('snapshot', 'internal', {...context}, options())

		recorder.setParentContext(parent)
		recorder.setStatus(status)
		recorder.setResource(resource)
		recorder.addLink(link)
		parent.spanId = 'e'.repeat(16)
		status.description = 'mutated'
		resource.service = 'mutated'
		link.context.spanId = 'f'.repeat(16)
		link.attributes.tenant = 'mutated'

		const record = recorder.end()
		expect(record.parentContext?.spanId).toBe('c'.repeat(16))
		expect(record.status.description).toBe('original')
		expect(record.resource).toEqual({service: 'api'})
		expect(record.links?.[0]).toMatchObject({
			context: {spanId: 'd'.repeat(16)},
			attributes: {tenant: 'one'}
		})
	})

	it('rejects unsafe metadata and snapshots nested attribute values', () => {
		const recorder = new SpanRecorder('safe', 'internal', {...context}, options({maxAttributes: 10, maxEvents: 5, maxAttrBytes: 2_000}))
		const nested = {value: {tenant: 'one'}}
		recorder.setAttribute('nested', nested)
		recorder.setAttribute('__proto__', {polluted: true})
		recorder.setAttribute('invalid', BigInt(1))
		recorder.addEvent('', {unsafe: true})
		recorder.addLink({context: {traceId: '0'.repeat(32), spanId: '0'.repeat(16)}})
		nested.value.tenant = 'mutated'
		const record = recorder.end()
		expect(record.attributes.nested).toEqual({value: {tenant: 'one'}})
		expect(Object.prototype).not.toHaveProperty('polluted')
		expect(record).toMatchObject({droppedAttributesCount: 2, droppedEventsCount: 1, droppedLinksCount: 1})
	})

	it('snapshots accessor-backed attributes without invoking user getters', () => {
		let getterCalls = 0
		const attributes = Object.defineProperty({safe: 'kept'}, 'secret', {
			enumerable: true,
			get: () => { getterCalls++; return 'must-not-run' }
		})
		const nested = Object.defineProperty({}, 'value', {
			enumerable: true,
			get: () => { getterCalls++; return 'must-not-run' }
		})
		const recorder = new SpanRecorder('accessors', 'internal', {...context}, options({
			maxAttributes: 10, maxEvents: 2, maxAttrBytes: 1_000
		}))
		recorder.setAttributes(attributes as never)
		recorder.addEvent('event', {nested} as never)
		const record = recorder.end()
		expect(getterCalls).toBe(0)
		expect(record.attributes).toEqual({safe: 'kept'})
		expect(record.events[0]?.attributes).toBeUndefined()
		expect(record.droppedAttributesCount).toBeGreaterThanOrEqual(2)
	})

	it('validates recorder construction bounds and identifiers', () => {
		expect(() => new SpanRecorder('', 'internal', {...context}, options())).toThrow('Span name')
		expect(() => new SpanRecorder('bad\u007fname', 'internal', {...context}, options())).toThrow('Span name')
		expect(() => new SpanRecorder('safe', 'invalid' as never, {...context}, options())).toThrow('span kind')
		expect(() => new SpanRecorder('safe', 'internal', {...context, traceId: '0'.repeat(32)}, options())).toThrow('W3C')
		expect(() => new SpanRecorder('safe', 'internal', {...context, traceFlags: 256}, options())).toThrow('W3C')
		expect(() => new SpanRecorder('safe', 'internal', {...context, traceFlags: -1}, options())).toThrow('W3C')
		expect(() => new SpanRecorder('safe', 'internal', {...context, parentSpanId: '0'.repeat(16)}, options())).toThrow('W3C')
		expect(() => new SpanRecorder('safe', 'internal', {...context, parentSpanId: 'x'.repeat(16)}, options())).toThrow('W3C')
		expect(() => new SpanRecorder('safe', 'internal', {...context, traceState: 'bad\nstate'}, options())).toThrow('W3C')
		expect(() => new SpanRecorder('safe', 'internal', {...context, traceState: 'x'.repeat(513)}, options())).toThrow('W3C')
		expect(() => new SpanRecorder('safe', 'internal', {...context, traceId: 'A'.repeat(32)}, options())).toThrow('W3C')
		let contextReads = 0
		const accessorContext = Object.defineProperty({...context}, 'traceId', {
			enumerable: true,
			get: () => { contextReads++; return context.traceId }
		})
		expect(() => new SpanRecorder('safe', 'internal', accessorContext, options())).toThrow('W3C')
		expect(contextReads).toBe(0)
		expect(() => new SpanRecorder('safe', 'internal', {...context}, options({maxEvents: 10_001}))).toThrow('maxEvents')
		const validOptionalContext = new SpanRecorder('safe', 'internal', {
			...context, parentSpanId: 'c'.repeat(16), traceState: 'vendor=value'
		}, options())
		expect(validOptionalContext.end()).toMatchObject({context: {traceState: 'vendor=value'}})
	})

	it('bounds event, link, and resource attribute payloads', () => {
		const recorder = new SpanRecorder('bounded', 'internal', {...context}, options({
			maxAttributes: 2, maxEvents: 2, maxAttrBytes: 40
		}))
		recorder.addEvent('event', {one: 'ok', two: 'x'.repeat(100), three: 'ignored'})
		recorder.addLink({context, attributes: {one: 'ok', two: 'x'.repeat(100), three: 'ignored'}})
		recorder.setResource({one: 'ok', two: 'x'.repeat(100), three: 'ignored'})
		const record = recorder.end()
		expect(record.events[0]?.attributes).toEqual({one: 'ok', three: 'ignored'})
		// maxAttrBytes is a total span budget, so the later link cannot allocate
		// a second full attribute container after the event consumed the budget.
		expect(record.links?.[0]?.attributes).toBeUndefined()
		expect(record.resource).toEqual({one: 'ok', three: 'ignored'})
		expect(record.droppedAttributesCount).toBeGreaterThanOrEqual(1)
	})
})
