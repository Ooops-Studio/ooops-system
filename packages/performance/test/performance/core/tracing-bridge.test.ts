import type {TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {describe, expect, it, vi} from 'vitest'

import {createPerformanceTracingBridge} from '../../../src/performance/core/tracing-bridge'

describe('createPerformanceTracingBridge', () => {
	const traceId = 'a'.repeat(32)
	const fallbackTraceId = 'c'.repeat(32)
	const spanId = 'b'.repeat(16)

	it('returns empty correlation when tracing is unavailable', async() => {
		const bridge = createPerformanceTracingBridge()
		expect(bridge.getCorrelation()).toEqual({})

		const result = await bridge.withSpan('test', undefined, async() => 'ok')
		expect(result).toBe('ok')
	})

	it('bounds synchronous re-entry from tracing capabilities', () => {
		let bridge!: ReturnType<typeof createPerformanceTracingBridge>
		const getActiveSpan = vi.fn(() => {
			bridge.getCorrelation()
			return undefined
		})
		bridge = createPerformanceTracingBridge({getActiveSpan} as never)

		expect(bridge.getCorrelation()).toEqual({})
		expect(getActiveSpan).toHaveBeenCalledOnce()
	})

	it('recovers tracing capabilities after a synchronous provider failure', async() => {
		const activeSpan = {getContext: () => ({traceId, spanId})}
		const getActiveSpan = vi.fn()
			.mockImplementationOnce(() => { throw new Error('transient active-span failure') })
			.mockReturnValue(activeSpan)
		const currentTraceId = vi.fn()
			.mockImplementationOnce(() => { throw new Error('transient trace-id failure') })
			.mockReturnValue(traceId)
		const inSpan = vi.fn()
			.mockImplementationOnce(() => { throw new Error('transient span failure') })
			.mockImplementation(async(_name, callback) => await callback(activeSpan))
		const bridge = createPerformanceTracingBridge({getActiveSpan, currentTraceId, inSpan} as never)

		expect(bridge.getCorrelation()).toEqual({})
		expect(bridge.getCorrelation()).toEqual({traceId, spanId})
		await expect(bridge.withSpan('first', {createSpan: true}, async(span) => span)).resolves.toBeUndefined()
		await expect(bridge.withSpan('second', {createSpan: true}, async(span) => span)).resolves.toBe(activeSpan)
		expect(getActiveSpan).toHaveBeenCalledTimes(2)
		expect(currentTraceId).toHaveBeenCalledTimes(2)
		expect(inSpan).toHaveBeenCalledTimes(2)
	})

	it('preserves correlation lookups while an enclosing tracer span is active', async() => {
		const activeSpan = {getContext: () => ({traceId, spanId})}
		const bridge = createPerformanceTracingBridge({
			getActiveSpan: () => activeSpan,
			currentTraceId: () => traceId,
			inSpan: async(_name, callback) => await callback(activeSpan)
		} as never)

		await expect(bridge.withSpan(
			'correlated',
			{createSpan: true},
			async() => bridge.getCorrelation()
		)).resolves.toEqual({traceId, spanId})
	})

	it('contains rejected promises from tracing and span capabilities', async() => {
		const rejected = vi.fn(() => Promise.reject(new Error('tracing failed')))
		const span = {
			getContext: rejected,
			setAttribute: rejected,
			addEvent: rejected,
			recordException: rejected,
			setStatus: rejected
		}
		const bridge = createPerformanceTracingBridge({
			currentTraceId: rejected,
			getActiveSpan: () => span
		} as never)

		expect(bridge.getCorrelation()).toEqual({})
		bridge.annotate(span as never, undefined, 1, 'ok')
		bridge.recordError(span as never, new Error('business failed'))
		await Promise.resolve()
		expect(rejected).toHaveBeenCalled()
	})

	it('uses active span correlation and annotates spans', async() => {
		const span = {
			getContext: () => ({traceId, spanId}),
			setAttribute: vi.fn(),
			addEvent: vi.fn(),
			recordException: vi.fn(),
			setStatus: vi.fn(),
			end: vi.fn()
		}
		const tracer = {
			currentTraceId: () => traceId,
			getActiveSpan: () => span,
			inSpan: vi.fn(async(_name, fn) => await fn(span))
		}

		const bridge = createPerformanceTracingBridge(tracer as never)
		expect(bridge.getCorrelation()).toEqual({traceId, spanId})

		const result = await bridge.withSpan('db.query', {
			createSpan: true,
			kind: 'client',
			labels: {env: 'test'},
			http: {method: 'GET', route: '/users/:id', statusCode: 200},
			dbMetadata: {collection: 'users', operation: 'select', queryHash: 'abc'}
		}, async(currentSpan?: TracingSpan) => {
			bridge.annotate(currentSpan, {
				labels: {env: 'test'},
				http: {method: 'GET', route: '/users/:id', statusCode: 200},
				dbMetadata: {collection: 'users', operation: 'select', queryHash: 'abc'}
			}, 42, 'ok')
			bridge.recordError(currentSpan, new Error('boom'))
			bridge.recordError(currentSpan, 'unknown')
			return 'done'
		})

		expect(result).toBe('done')
		expect(tracer.inSpan).toHaveBeenCalled()
		expect(span.setAttribute).toHaveBeenCalledWith('perf.duration_ms', 42)
		expect(span.addEvent).toHaveBeenCalled()
		expect(span.recordException).toHaveBeenCalledTimes(2)
		expect(span.setStatus).toHaveBeenCalled()
	})

	it('reuses the active span when createSpan is disabled and no-ops on missing spans', async() => {
		const activeSpan = {
			getContext: () => ({spanId}),
			setAttribute: vi.fn(),
			addEvent: vi.fn(),
			recordException: vi.fn(),
			setStatus: vi.fn(),
			end: vi.fn()
		}
		const tracer = {
			currentTraceId: () => undefined,
			getActiveSpan: () => activeSpan,
			inSpan: vi.fn()
		}

		const bridge = createPerformanceTracingBridge(tracer as never)
		const result = await bridge.withSpan('http.request', {
			labels: {service: 'api'}
		}, async(currentSpan?: TracingSpan) => currentSpan?.getContext().spanId)

		expect(result).toBe(spanId)
		expect(tracer.inSpan).not.toHaveBeenCalled()
		expect(() => bridge.annotate(undefined, undefined, 1, 'ok')).not.toThrow()
		expect(() => bridge.recordError(undefined, new Error('ignored'))).not.toThrow()
	})

	it('covers optional span attributes and error annotation', async() => {
		const span = {
			getContext: () => ({}),
			setAttribute: vi.fn(),
			addEvent: vi.fn(),
			recordException: vi.fn(),
			setStatus: vi.fn(),
			end: vi.fn()
		}
		const tracer = {currentTraceId: () => undefined, getActiveSpan: () => span, inSpan: vi.fn(async(_name, fn) => await fn(span))}
		const bridge = createPerformanceTracingBridge(tracer as never)
		expect(bridge.getCorrelation()).toEqual({})
		bridge.annotate(span as never, {
			attributes: {custom: true},
			http: {method: 'POST', route: '/jobs/secret', statusCode: 503},
			dbMetadata: {table: 'x'.repeat(100)}
		}, 9, 'error')
		expect(span.setStatus).toHaveBeenCalledWith({code: 'error'})
		expect(span.setAttribute).toHaveBeenCalledWith('http.route', '[url]')
		expect(span.setAttribute).toHaveBeenCalledWith('db.table', '[opaque]')
		await bridge.withSpan('child', {createSpan: true}, async() => 'ok')
	})

	it('never forwards raw business exceptions to tracing spans', () => {
		const recordException = vi.fn()
		const setStatus = vi.fn()
		const bridge = createPerformanceTracingBridge()
		const secret = new Error('password=database-secret')
		secret.stack = 'database-secret-stack'

		bridge.recordError({recordException, setStatus} as never, secret)

		expect(recordException).toHaveBeenCalledOnce()
		const [recorded] = recordException.mock.calls[0] ?? []
		expect(recorded).toBeInstanceOf(Error)
		expect(String(recorded)).not.toContain('database-secret')
		expect(setStatus).toHaveBeenCalledWith({
			code: 'error', description: 'Performance measured operation failed'
		})
	})

	it('redacts sensitive span attributes by key before span creation and annotation', async() => {
		const setAttribute = vi.fn()
		const span = {
			setAttribute, addEvent: vi.fn(), setStatus: vi.fn(),
			recordException: vi.fn(), getContext: () => ({traceId, spanId}), end: vi.fn()
		}
		const inSpan = vi.fn(async(_name, callback) => await callback(span))
		const bridge = createPerformanceTracingBridge({inSpan} as never)
		const attributes = {password: 'short-secret', api_key: 'collector-key', credential: 'short-value', region: 'eu'}

		await bridge.withSpan('sensitive', {createSpan: true, attributes}, async(current) => {
			bridge.annotate(current, {attributes, labels: {authToken: 'token-value'}}, 1, 'ok')
		})

		expect(inSpan).toHaveBeenCalledWith('sensitive', expect.any(Function), {
			attributes: {password: '[redacted]', api_key: '[redacted]', credential: '[redacted]', region: 'eu'}
		})
		expect(setAttribute).toHaveBeenCalledWith('password', '[redacted]')
		expect(setAttribute).toHaveBeenCalledWith('api_key', '[redacted]')
		expect(setAttribute).toHaveBeenCalledWith('credential', '[redacted]')
		expect(setAttribute).toHaveBeenCalledWith('authToken', '[redacted]')
	})

	it('bounds span attribute inspection without invoking accessors', async() => {
		const attributes: Record<string, unknown> = Object.fromEntries(
			Array.from({length: 100_000}, (_, index) => [`attribute_${index}`, index])
		)
		const accessor = vi.fn(() => 'secret')
		Object.defineProperty(attributes, 'getter', {enumerable: true, get: accessor})
		const inSpan = vi.fn(async(_name, callback) => await callback(undefined))
		const bridge = createPerformanceTracingBridge({inSpan} as never)

		await bridge.withSpan('bounded', {createSpan: true, attributes}, async() => undefined)

		const captured = inSpan.mock.calls[0]?.[2]?.attributes
		expect(Object.keys(captured ?? {})).toHaveLength(32)
		expect(accessor).not.toHaveBeenCalled()
	})

	it('redacts oversized span strings before label scanning', async() => {
		const inSpan = vi.fn(async(_name, callback) => await callback(undefined))
		const bridge = createPerformanceTracingBridge({inSpan} as never)

		await bridge.withSpan('bounded', {
			createSpan: true,
			attributes: {payload: 'x'.repeat(1_048_577)}
		}, async() => undefined)

		expect(inSpan).toHaveBeenCalledWith('bounded', expect.any(Function), {
			attributes: {payload: '[redacted]'}
		})
	})

	it('uses active context correlation and cannot skip, duplicate, or replace the measured operation', async() => {
		const operation = vi.fn(async() => 'business-result')
		const skipped = createPerformanceTracingBridge({
			currentTraceId: () => undefined,
			getActiveSpan: () => ({getContext: () => ({traceId, spanId})}),
			inSpan: vi.fn(async() => 'tracer-result')
		} as never)
		expect(skipped.getCorrelation()).toEqual({traceId, spanId})
		await expect(skipped.withSpan('span', {createSpan: true}, operation)).resolves.toBe('business-result')
		expect(operation).toHaveBeenCalledOnce()

		const duplicated = createPerformanceTracingBridge({
			inSpan: vi.fn(async(_name, callback) => {
				await Promise.all([callback(undefined), callback(undefined)])
				return 'tracer-result'
			})
		} as never)
		await expect(duplicated.withSpan('span', {createSpan: true}, operation)).resolves.toBe('business-result')
		expect(operation).toHaveBeenCalledTimes(2)
		const businessError = new Error('business failed')
		const swallowing = createPerformanceTracingBridge({
			inSpan: vi.fn(async(_name, callback) => {
				try { await callback(undefined) } catch { /* broken tracer swallows callback errors */ }
			})
		} as never)
		await expect(swallowing.withSpan('span', {createSpan: true}, async() => { throw businessError })).rejects.toBe(businessError)
	})

	it('falls back to bounded active correlation when the direct trace lookup is broken', () => {
		const bridge = createPerformanceTracingBridge({
			currentTraceId: () => { throw new Error('trace lookup failed') },
			getActiveSpan: () => ({
				getContext: () => ({traceId: fallbackTraceId, spanId})
			})
		} as never)
		expect(bridge.getCorrelation()).toEqual({traceId: fallbackTraceId, spanId})

		const hostile = createPerformanceTracingBridge({
			currentTraceId: () => 'x'.repeat(129),
			getActiveSpan: () => ({
				getContext: () => ({traceId: fallbackTraceId.toUpperCase(), spanId: 'unsafe\nspan'})
			})
		} as never)
		expect(hostile.getCorrelation()).toEqual({traceId: fallbackTraceId})
		const pii = createPerformanceTracingBridge({
			currentTraceId: () => 'person@example.com',
			getActiveSpan: () => ({getContext: () => ({traceId: 'tenant-secret', spanId: 'customer-123'})})
		} as never)
		expect(pii.getCorrelation()).toEqual({})
	})

	it('isolates tracing failures without double-running or replacing measured operations', async() => {
		const operation = vi.fn(async() => 'ok')
		const before = createPerformanceTracingBridge({
			getActiveSpan: () => { throw new Error('active failed') },
			currentTraceId: () => { throw new Error('trace failed') },
			inSpan: async() => { throw new Error('start failed') }
		} as never)
		expect(before.getCorrelation()).toEqual({})
		await expect(before.withSpan('child', {createSpan: true}, operation)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledOnce()
		const attributeOwnKeys = vi.fn(() => { throw new Error('attributes failed') })
		const attributes = new Proxy({}, {ownKeys: attributeOwnKeys}) as Record<string, unknown>
		await expect(before.withSpan('child', {createSpan: true, attributes}, operation)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(2)
		expect(attributeOwnKeys).not.toHaveBeenCalled()
		const optionGetter = vi.fn(() => { throw new Error('options failed') })
		const hostileOptions = new Proxy({}, {get: optionGetter})
		await expect(before.withSpan('child', hostileOptions as never, operation)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(3)
		expect(optionGetter).not.toHaveBeenCalled()
		const nestedGetter = vi.fn(() => { throw new Error('nested metadata failed') })
		const hostileHttp = Object.defineProperty({}, 'route', {enumerable: true, get: nestedGetter})
		await expect(before.withSpan('child', {
			createSpan: true,
			http: hostileHttp as never
		}, operation)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(4)
		expect(nestedGetter).not.toHaveBeenCalled()

		const after = createPerformanceTracingBridge({
			inSpan: async(_name: string, fn: (span?: TracingSpan) => Promise<unknown>) => {
				await fn(undefined)
				throw new Error('finish failed')
			}
		} as never)
		await expect(after.withSpan('child', {createSpan: true}, async() => 42)).resolves.toBe(42)
		const original = new Error('operation failed')
		await expect(after.withSpan('child', {createSpan: true}, async() => { throw original })).rejects.toBe(original)

		const brokenSpan = {
			setAttribute: () => { throw new Error('attribute failed') },
			addEvent: vi.fn(), setStatus: vi.fn(),
			recordException: () => { throw new Error('exception failed') }
		}
		expect(() => after.annotate(brokenSpan as never, undefined, 1, 'ok')).not.toThrow()
		expect(() => after.recordError(brokenSpan as never, original)).not.toThrow()
	})

	it('does not invoke tracer, span, or correlation accessors and proxy traps', async() => {
		const readInSpan = vi.fn(() => vi.fn())
		const accessorTracer = Object.defineProperty({}, 'inSpan', {get: readInSpan})
		const accessorBridge = createPerformanceTracingBridge(accessorTracer as never)
		await expect(accessorBridge.withSpan(
			'safe', {createSpan: true}, async() => 'business-result'
		)).resolves.toBe('business-result')
		expect(readInSpan).not.toHaveBeenCalled()

		const tracerGet = vi.fn(() => vi.fn())
		const proxyBridge = createPerformanceTracingBridge(new Proxy({}, {get: tracerGet}) as never)
		expect(proxyBridge.getCorrelation()).toEqual({})
		await expect(proxyBridge.withSpan(
			'safe', {createSpan: true}, async() => 'business-result'
		)).resolves.toBe('business-result')
		expect(tracerGet).not.toHaveBeenCalled()

		const readTraceId = vi.fn(() => traceId)
		const context = Object.defineProperty({spanId}, 'traceId', {get: readTraceId})
		const contextBridge = createPerformanceTracingBridge({
			getActiveSpan: () => ({getContext: () => context})
		} as never)
		expect(contextBridge.getCorrelation()).toEqual({spanId})
		expect(readTraceId).not.toHaveBeenCalled()

		const spanGetPrototypeOf = vi.fn(() => Object.prototype)
		const proxySpan = new Proxy({}, {getPrototypeOf: spanGetPrototypeOf})
		expect(() => contextBridge.annotate(proxySpan as never, undefined, 1, 'ok')).not.toThrow()
		expect(() => contextBridge.recordError(proxySpan as never, new Error('ignored'))).not.toThrow()
		expect(spanGetPrototypeOf).not.toHaveBeenCalled()
	})

	it('waits for a measured callback even when a broken tracer does not await it', async() => {
		let release!: () => void
		const operation = vi.fn(async() => {
			await new Promise<void>((resolve) => { release = resolve })
			return 'completed'
		})
		const bridge = createPerformanceTracingBridge({
			inSpan: vi.fn(async(_name, callback) => {
				void callback(undefined)
			})
		} as never)
		const result = bridge.withSpan('child', {createSpan: true}, operation)
		await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())
		let settled = false
		void result.finally(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		release()
		await expect(result).resolves.toBe('completed')
	})

	it('does not wait for a tracer lifecycle promise after the measured callback completes', async() => {
		const operation = vi.fn(async() => 'completed')
		const bridge = createPerformanceTracingBridge({
			inSpan: vi.fn((_name, callback) => {
				void callback(undefined)
				return new Promise<void>(() => {})
			})
		} as never)

		await expect(bridge.withSpan('child', {createSpan: true}, operation)).resolves.toBe('completed')
		expect(operation).toHaveBeenCalledOnce()
	})

	it('bounds unresolved tracer lifecycle calls while preserving every operation', async() => {
		const inSpan = vi.fn(() => new Promise<void>(() => undefined))
		const operation = vi.fn(async() => 'completed')
		const bridge = createPerformanceTracingBridge({inSpan} as never)

		const results = await Promise.all(Array.from(
			{length: 1_000},
			async() => await bridge.withSpan('child', {createSpan: true}, operation)
		))

		expect(results).toHaveLength(1_000)
		expect(results.every((result) => result === 'completed')).toBe(true)
		expect(operation).toHaveBeenCalledTimes(1_000)
		expect(inSpan).toHaveBeenCalledOnce()
	})

	it('does not assimilate thenables returned by a tracer lifecycle', async() => {
		const readThen = vi.fn(() => { throw new Error('must not assimilate') })
		const operation = vi.fn(async() => 'completed')
		const bridge = createPerformanceTracingBridge({
			inSpan: vi.fn((_name, callback) => {
				void callback(undefined)
				return Object.defineProperty({}, 'then', {get: readThen})
			})
		} as never)

		await expect(bridge.withSpan('child', {createSpan: true}, operation)).resolves.toBe('completed')
		expect(operation).toHaveBeenCalledOnce()
		expect(readThen).not.toHaveBeenCalled()
	})

	it('does not repeat the operation when a broken tracer invokes its callback late', async() => {
		let invokeLate!: () => void
		const operation = vi.fn(async() => 'completed')
		const bridge = createPerformanceTracingBridge({
			inSpan: vi.fn(async(_name, callback) => {
				invokeLate = () => { void callback(undefined) }
			})
		} as never)

		await expect(bridge.withSpan('child', {createSpan: true}, operation)).resolves.toBe('completed')
		expect(operation).toHaveBeenCalledOnce()
		invokeLate()
		await Promise.resolve()
		expect(operation).toHaveBeenCalledOnce()
	})

	it('preserves a business failure when a broken tracer ignores the callback promise', async() => {
		const failure = new Error('business failed')
		const bridge = createPerformanceTracingBridge({
			inSpan: vi.fn(async(_name, callback) => {
				void callback(undefined)
			})
		} as never)
		await expect(bridge.withSpan('child', {createSpan: true}, async() => {
			throw failure
		})).rejects.toBe(failure)
	})
})
