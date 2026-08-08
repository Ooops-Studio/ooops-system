import {TOK, createContainer} from '@ooopsstudio/core'
import {describe, expect, it, vi} from 'vitest'

import {createErrorHandler} from '../src/core/create-error-handler'
import {collectFinalizationFailures, throwFinalizationFailures} from '../src/core/finalization'
import {registerErrorLifecycleHooks} from '../src/core/lifecycle-hooks'
import {createReportRuntime} from '../src/core/report'
import {snapshotClassificationRegistry} from '../src/features/classification/classify-error'
import {reportAll} from '../src/features/reporters/report-all'
import {registerErrors} from '../src/index-registration'
import {createDevelopmentErrorHandler} from '../src/public/development'
import {createSentryErrorSink} from '../src/sentry'
import {parseSentryDsn} from '../src/sinks/providers/sentry-dsn'
import type {EnrichedError} from '../src/types/normalized-error'
import {inspectErrorCapability} from '../src/utils/capabilities'
import {
	redactEnrichedError,
	redactErrorValue,
	sanitizeErrorDiagnostic
} from '../src/utils/redaction'

import {createFixedClock} from './fixed-clock'

const error: EnrichedError = {
	kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
}

describe('errors coverage branches', () => {
	it('covers stable configuration rejection codes without executing invalid capabilities', () => {
		const invalidCases: Array<[Record<string, unknown>, string]> = [
			[{rethrow: 'yes'}, 'errors_invalid_rethrow'],
			[{deduplicate: 1}, 'errors_invalid_deduplicate'],
			[{clock: {}}, 'errors_invalid_clock'],
			[{observe: true}, 'errors_invalid_observer'],
			[{defaultSource: ' '}, 'errors_invalid_source'],
			[{defaultSource: 'x'.repeat(1_025)}, 'errors_invalid_source'],
			[{classificationRegistry: []}, 'errors_invalid_classification_registry'],
			[{report: true}, 'errors_invalid_reporter'],
			[{flushTimeoutMs: 0}, 'errors_invalid_flush_timeout'],
			[{flushTimeoutMs: 60_001}, 'errors_invalid_flush_timeout'],
			[{shutdownTimeoutMs: 0}, 'errors_invalid_shutdown_timeout'],
			[{shutdownTimeoutMs: 60_001}, 'errors_invalid_shutdown_timeout'],
			[{reportTimeoutMs: 0}, 'errors_invalid_report_timeout'],
			[{reportTimeoutMs: 1.5}, 'errors_invalid_report_timeout'],
			[{reportTimeoutMs: 60_001}, 'errors_invalid_report_timeout'],
			[{sink: {capture: true}}, 'errors_invalid_sink'],
			[{sink: {capture: async() => {}, flush: true}}, 'errors_invalid_sink'],
			[{sink: {capture: async() => {}, close: true}}, 'errors_invalid_sink']
		]

		for (const [options, code] of invalidCases) {
			expect(() => createErrorHandler(options as never)).toThrow(code)
		}
	})

	it('sanitizes single and multiple finalization component failures', async() => {
		const failures = await collectFinalizationFailures([
			undefined,
			async() => { throw new Error('password=first') },
			async() => { throw new Error('token=second') }
		])
		expect(failures).toHaveLength(2)
		expect(() => throwFinalizationFailures([], 'none')).not.toThrow()
		expect(() => throwFinalizationFailures(failures.slice(0, 1), 'single'))
			.toThrow('single')
		let aggregate: AggregateError | undefined
		try { throwFinalizationFailures(failures, 'multiple') } catch(error) {
			aggregate = error as AggregateError
		}
		expect(aggregate).toBeInstanceOf(AggregateError)
		expect(aggregate?.message).toBe('multiple')
		expect(JSON.stringify((aggregate?.errors as Error[]).map((error) => error.message)))
			.not.toMatch(/first|second/u)
	})

	it('sanitizes partial lifecycle registration and multiple disposal failures', async() => {
		const partialDispose = vi.fn()
		expect(() => registerErrorLifecycleHooks({
			registerFlushHook: vi.fn(() => partialDispose),
			registerShutdownHook: vi.fn(() => { throw new Error('token=registration-secret') })
		} as never, {flush: vi.fn(async() => {}), shutdown: vi.fn(async() => {})}))
			.toThrow('errors_lifecycle_registration_failed')
		expect(partialDispose).toHaveBeenCalledOnce()

		const unregister = registerErrorLifecycleHooks({
			registerFlushHook: vi.fn(() => async() => { throw new Error('first') }),
			registerShutdownHook: vi.fn(() => async() => { throw new Error('second') })
		} as never, {flush: vi.fn(async() => {}), shutdown: vi.fn(async() => {})})
		const failure = await unregister().catch((error: unknown) => error as AggregateError)
		expect(failure).toBeInstanceOf(AggregateError)
		expect(failure.message).toBe('Errors lifecycle disposal failed.')
		expect(JSON.stringify((failure.errors as Error[]).map((error) => error.message)))
			.not.toMatch(/first|second/u)
	})

	it('executes every captured report capability with its original receiver', async() => {
		const logger = {
			info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn()
		}
		const tracer = {
			currentTraceId: vi.fn(() => 'trace-safe'),
			recordException: vi.fn(),
			addBreadcrumb: vi.fn()
		}
		const runtime = createReportRuntime({logger: logger as never, tracer: tracer as never})
		for (const severity of ['info', 'warn', 'error', 'fatal'] as const) {
			await runtime.report({...error, severity})
		}
		expect(logger.info).toHaveBeenCalledOnce()
		expect(logger.warn).toHaveBeenCalledOnce()
		expect(logger.error).toHaveBeenCalledOnce()
		expect(logger.fatal).toHaveBeenCalledOnce()
		expect(tracer.currentTraceId).toHaveBeenCalled()
		expect(runtime.state()).toBe('running')
		await runtime.shutdown()
		expect(runtime.state()).toBe('closed')
	})

	it('falls back safely when the configured clock throws and cache data is malformed', async() => {
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(17)
		const report = vi.fn(async() => {})
		const cache = {
			get: vi.fn(async() => 42),
			set: vi.fn(async() => {}),
			delete: vi.fn(async() => {})
		}
		try {
			const handler = createErrorHandler({
				clock: {now: () => { throw new Error('clock unavailable') }},
				deduplicate: true,
				report,
				ports: {cache: cache as never}
			})
			await expect(handler.handle(new Error('clock fallback'))).resolves.toMatchObject({
				timestamp: 17
			})
			expect(report).toHaveBeenCalledOnce()
			expect(cache.get).toHaveBeenCalled()
			await handler.shutdown()
		} finally {
			dateNow.mockRestore()
		}
	})

	it('fails open after a bounded external deduplication timeout', async() => {
		const report = vi.fn(async() => {})
		const observe = vi.fn()
		const handler = createErrorHandler({
			clock: createFixedClock(1),
			deduplicate: true,
			report,
			observe,
			reportTimeoutMs: 1,
			ports: {cache: {get: async() => await new Promise<string>(() => undefined)}}
		})

		await expect(handler.handle(new Error('deduplication timeout'))).resolves.toBeDefined()
		expect(report).toHaveBeenCalledOnce()
		expect(observe).toHaveBeenCalledWith('error:reporter', expect.objectContaining({
			status: 'timeout', reason: 'deduplication_timeout'
		}))
		await expect(handler.shutdown()).rejects.toThrow('deduplication cleanup is still active')
	})

	it('accepts a valid external deduplication entry and reuses completed flush cutoffs', async() => {
		const report = vi.fn(async() => {})
		const handler = createErrorHandler({
			clock: createFixedClock(1),
			deduplicate: true,
			report,
			ports: {cache: {
				get: async() => JSON.stringify({timestamp: 1, count: 1, lastAccess: 1, weightedScore: 1}),
				set: async() => {}
			}}
		})

		await handler.handle(new Error('external duplicate'))
		expect(report).not.toHaveBeenCalled()
		await handler.flush()
		await handler.flush()
		expect(handler.classify(null as never)).toMatchObject({kind: 'UnknownError'})
		await handler.shutdown()
	})

	it('shares one in-flight handler flush and sanitizes its failure', async() => {
		const handler = createErrorHandler({
			clock: createFixedClock(1),
			sink: {
				capture: async() => {},
				flush: async() => { throw new Error('token=flush-secret') }
			}
		})

		const first = handler.flush()
		const shared = handler.flush()
		await expect(first).rejects.toThrow('Errors handler flush failed.')
		await expect(shared).rejects.toThrow('Errors handler flush failed.')
		await expect(handler.shutdown()).rejects.toThrow('Errors shutdown failed.')
	})

	it('rejects re-entrant handler admission before repeating hostile traversal', async() => {
		let handler!: ReturnType<typeof createErrorHandler>
		let nested: Promise<EnrichedError> | undefined
		let reentered = false
		const target = new Error('hostile admission')
		const hostile = new Proxy(target, {
			getOwnPropertyDescriptor(current, key) {
				if (!reentered && key === 'message') {
					reentered = true
					nested = handler.handle(hostile)
				}
				return Reflect.getOwnPropertyDescriptor(current, key)
			}
		})
		handler = createErrorHandler({clock: createFixedClock(1)})

		await expect(handler.handle(hostile)).resolves.toMatchObject({message: 'hostile admission'})
		await expect(nested).resolves.toMatchObject({message: 'Errors handler capacity exceeded.'})
		await handler.shutdown()
		await expect(handler.flush()).resolves.toBeUndefined()
	})

	it('treats throwing capability proxies and malformed encoded DSNs as invalid', () => {
		const hostile = new Proxy({}, {
			getOwnPropertyDescriptor() { throw new Error('descriptor trap') }
		})
		expect(inspectErrorCapability(hostile, 'capture')).toEqual({present: true})

		for (const dsn of [
			'https://bad%ZZ@example.ingest.sentry.io/42',
			'https://public@example.ingest.sentry.io/bad%ZZ',
			'https://public@example.ingest.sentry.io/42?query=forbidden',
			'https://public@example.ingest.sentry.io/42#fragment'
		]) expect(() => parseSentryDsn(dsn)).toThrow('invalid Sentry DSN')
	})

	it('retires invalid lifecycle construction and hostile classification snapshots safely', async() => {
		expect(() => createErrorHandler({
			clock: createFixedClock(1),
			ports: {lifecycle: {registerFlushHook: vi.fn()} as never}
		})).toThrow('errors_lifecycle_registration_failed')
		await Promise.resolve()

		const patterns = new Proxy(['SAFE'], {
			getOwnPropertyDescriptor(target, key) {
				if (key === '0') throw new Error('pattern descriptor trap')
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		const snapshot = snapshotClassificationRegistry({NETWORK: patterns})
		expect(snapshot.NETWORK).toEqual([])
	})

	it('maps hostile Sentry responses to a stable transport error', async() => {
		vi.stubGlobal('fetch', vi.fn(async() => Object.defineProperties({}, {
			ok: {get() { throw new Error('password=response-secret') }},
			status: {value: 200}
		})))
		try {
			const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
			await expect(sink.capture(error)).rejects.toMatchObject({
				code: 'SENTRY_RESPONSE_ERROR', statusCode: 0
			})
			await sink.close?.()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('maps unavailable transports and missing report-runtime sink capabilities safely', async() => {
		vi.stubGlobal('fetch', undefined)
		try {
			const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
			await expect(sink.capture(error)).rejects.toMatchObject({code: 'SENTRY_NETWORK_ERROR'})
		} finally {
			vi.unstubAllGlobals()
		}

		const runtime = createReportRuntime({sink: {} as never})
		await expect(runtime.report(error)).resolves.toBeUndefined()
		await runtime.shutdown()
	})

	it('runs the ordered lifecycle shutdown hook', async() => {
		let shutdownHook: (() => Promise<void>) | undefined
		const shutdown = vi.fn(async() => {})
		const unregister = registerErrorLifecycleHooks({
			registerFlushHook: vi.fn(() => vi.fn()),
			registerShutdownHook: vi.fn((_group, hook) => {
				shutdownHook = async() => { await hook({} as never) }
			})
		} as never, {flush: vi.fn(async() => {}), shutdown})

		await shutdownHook?.()
		expect(shutdown).toHaveBeenCalledOnce()
		await unregister()
	})

	it('registers every preset with both present and absent container ports', async() => {
		const defaultDevelopment = await createDevelopmentErrorHandler()
		await expect(defaultDevelopment.handle(new Error('default development'))).rejects.toBeInstanceOf(Error)
		await defaultDevelopment.shutdown()

		const logger = {error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn()} as never
		const metrics = {increment: vi.fn()} as never
		const tracer = {recordException: vi.fn(), addBreadcrumb: vi.fn()} as never
		const lifecycle = {registerFlushHook: vi.fn(), registerShutdownHook: vi.fn()} as never
		const production = createContainer()
		production.bind(TOK.Clock, createFixedClock(1))
		production.bind(TOK.Logging, logger)
		production.bind(TOK.Metrics, metrics)
		production.bind(TOK.Tracing, tracer)
		production.bind(TOK.Lifecycle, lifecycle)
		await registerErrors(production, {
			preset: 'production',
			options: {sink: {capture: vi.fn(async() => {})}}
		})
		await (production.get(TOK.Errors) as unknown as {handle(error: unknown): Promise<unknown>})
			.handle(new Error('production'))

		const development = createContainer()
		development.bind(TOK.Clock, createFixedClock(1))
		await registerErrors(development, {preset: 'development'})
		development.get(TOK.Errors).report({kind: 'Error', message: 'development'})

		const custom = createContainer()
		custom.bind(TOK.Clock, createFixedClock(1))
		await registerErrors(custom, {preset: 'custom'})
		await (custom.get(TOK.Errors) as unknown as {handle(error: unknown): Promise<unknown>})
			.handle(new Error('custom'))

		expect((logger as {error: ReturnType<typeof vi.fn>}).error).toHaveBeenCalled()
		expect((metrics as {increment: ReturnType<typeof vi.fn>}).increment).toHaveBeenCalled()
	})

	it('keeps report runtime cleanup and all reporter outcomes best-effort', async() => {
		const sink = {capture: vi.fn(async() => { throw new Error('sink token=secret') }), flush: vi.fn(async() => {}), close: vi.fn(async() => {})}
		const runtime = createReportRuntime({
			baseReport: vi.fn(async() => { throw new Error('custom failure') }),
			sink
		})
		await runtime.report(error)
		await runtime.shutdown()
		await runtime.report(error)
		await runtime.flush()
		await runtime.shutdown()
		expect(sink.close).toHaveBeenCalledTimes(1)

		const result = await reportAll(error, {
			logger: {error: vi.fn()} as never,
			metrics: {increment: vi.fn()} as never,
			tracer: {recordException: vi.fn(), addBreadcrumb: vi.fn()} as never,
			sink
		})
		expect(result).toEqual({configured: 4, delivered: 3, failed: 1})
	})

	it('counts and observes an isolated custom reporter failure', async() => {
		const observe = vi.fn()
		const result = await reportAll(error, {
			customReport: vi.fn(async() => { throw new Error('custom token=secret') }),
			observe
		})

		expect(result).toEqual({configured: 1, delivered: 0, failed: 1})
		expect(observe).toHaveBeenCalledWith('error:reporter', expect.objectContaining({
			reporter: 'custom', status: 'error', reason: 'custom token=[REDACTED]'
		}))
		expect(observe).toHaveBeenCalledWith('error:reported', expect.objectContaining({
			delivery: {configured: 1, delivered: 0, failed: 1}
		}))
	})

	it('surfaces asynchronous lifecycle disposer failures for retry', async() => {
		const dispose = vi.fn(async() => { throw new Error('async disposer failure') })
		const unregister = registerErrorLifecycleHooks({
			registerFlushHook: vi.fn(() => vi.fn()),
			registerShutdownHook: vi.fn(() => dispose)
		} as never, {
			flush: vi.fn(async() => {}), shutdown: vi.fn(async() => {})
		})

		await expect(unregister()).rejects.toThrow('lifecycle disposal failed')
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('blocks reporting and concurrent flushes while report runtime shuts down', async() => {
		let releaseFlush!: () => void
		const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
		const sink = {
			capture: vi.fn(async() => {}),
			flush: vi.fn(async() => { await flushGate }),
			close: vi.fn(async() => {})
		}
		const runtime = createReportRuntime({sink})

		const shutdown = runtime.shutdown()
		await vi.waitFor(() => expect(sink.flush).toHaveBeenCalledTimes(1))
		const concurrentFlush = runtime.flush()
		await runtime.report(error)
		releaseFlush()
		await Promise.all([shutdown, concurrentFlush])
		await runtime.flush()

		expect(sink.capture).not.toHaveBeenCalled()
		expect(sink.flush).toHaveBeenCalledTimes(1)
		expect(sink.close).toHaveBeenCalledTimes(1)
	})

	it('covers redaction limits, error values, diagnostics, and status sanitizing', () => {
		const circular: Record<string, unknown> = {authorization: 'Bearer secret'}
		circular.self = circular
		const deep: Record<string, unknown> = {}
		let cursor = deep
		for (let index = 0; index < 9; index += 1) {
			cursor.next = {}
			cursor = cursor.next as Record<string, unknown>
		}
		const value = redactErrorValue({
			userId: 'user-1', email: 'person@example.com', circular, deep,
			list: Array.from({length: 101}, (_value, index) => index)
		}) as Record<string, unknown>
		expect(value.email).toBe('[DROPPED]')
		expect((value.circular as Record<string, unknown>).self).toBe('[Circular]')
		expect(sanitizeErrorDiagnostic({message: 'token=secret'})).toBe('token=[REDACTED]')
		expect(redactEnrichedError({...error, cause: circular, data: {password: 'x'}, context: {phone: '1'}})).toMatchObject({
			data: {password: '[REDACTED]'}, context: {phone: '[DROPPED]'}
		})
	})

	it('keeps redacted payloads JSON-safe and distinguishes shared references from cycles', () => {
		const shared = {message: 'token=secret', count: 1n}
		const value = redactErrorValue({
			first: shared,
			second: shared,
			notFinite: Number.NaN,
			symbol: Symbol('safe'),
			callback: function namedCallback() {},
			missing: undefined
		}) as Record<string, unknown>
		expect(value.first).toEqual({message: 'token=[REDACTED]', count: '1'})
		expect(value.second).toEqual({message: 'token=[REDACTED]', count: '1'})
		expect(() => JSON.stringify(value)).not.toThrow()
		expect(redactErrorValue('x'.repeat(70_000))).toBe('[DROPPED_OVERSIZED]')
	})

	it('serializes Sentry optional metadata and complex tags safely', async() => {
		const fetch = vi.fn().mockResolvedValue({ok: true, status: 200})
		vi.stubGlobal('fetch', fetch)
		const sink = createSentryErrorSink({
			dsn: 'https://public:secret@example.ingest.sentry.io/prefix/42',
			environment: 'https://example.com/env?token=secret',
			release: 'release-1',
			serverName: 'server-1',
			tags: {
				source: 'unknown-source', safe: 'ok', url: 'https://example.com/a?token=secret',
				email: 'person@example.com', uuid: '550e8400-e29b-41d4-a716-446655440000',
				tenant: 'tenant-acme-production', count: '12345', weird: 'not allowed!'
			}
		})
		const circular: Record<string, unknown> = {token: 'secret'}
		circular.self = circular
		await sink.capture({...error, code: 'CODE', source: 'unknown-source', stack: 'Error\n at https://example.com/a?token=secret', context: circular})
		const [, , event] = String(fetch.mock.calls[0]?.[1]?.body).split('\n')
		expect(event).not.toContain('secret')
		vi.unstubAllGlobals()
	})

	it('covers Sentry fallback paths and lifecycle helpers', async() => {
		await createErrorHandler({clock: createFixedClock(1)}).shutdown()
		expect(() => createSentryErrorSink({dsn: 'ftp://public@example.com/42'})).toThrow()
		expect(() => createSentryErrorSink({dsn: 'https://example.com/'})).toThrow()
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		fetch.mockResolvedValueOnce({ok: true, status: 200})
		const sink = createSentryErrorSink({
			dsn: 'https://public@example.com/42',
			tags: {
				empty: ' ', source: 'errors', environment: 'PRODUCTION',
				hex: 'abcdefabcdefabcdef', opaque: 'a'.repeat(70), invalid: 'hello world'
			}
		})
		const nested: Record<string, unknown> = {value: 'text'}
		let cursor = nested
		for (let index = 0; index < 10; index += 1) {
			cursor.child = {}
			cursor = cursor.child as Record<string, unknown>
		}
		await sink.capture({...error, severity: 'warn', data: {list: ['value'], nested}})
		await sink.flush?.()
		await sink.close?.()
		await expect(sink.capture(error)).rejects.toMatchObject({code: 'SENTRY_SINK_CLOSED'})

		fetch.mockRejectedValueOnce(new Error('network token=secret'))
		const networkSink = createSentryErrorSink({dsn: 'https://public@example.com/42'})
		await expect(networkSink.capture(error)).rejects.toMatchObject({code: 'SENTRY_NETWORK_ERROR'})
		vi.unstubAllGlobals()
	})
})
