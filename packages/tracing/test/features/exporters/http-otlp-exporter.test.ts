/**
 * @file Tests for HTTP OTLP exporter.
 */

import {gunzipSync} from 'node:zlib'

import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'

import {createHttpOtlpExporter} from '../../../src/features/exporters/http-otlp-exporter'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('HttpOtlpExporter', () => {

	beforeEach(() => {
		mockFetch.mockReset()
	})

	afterEach(() => {
		vi.clearAllTimers()
	})

	it('should create an HTTP OTLP exporter', () => {

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		expect(exporter).toBeDefined()
		expect(exporter.export).toBeDefined()
		expect(exporter.shutdown).toBeDefined()
	})

	it('does not start an HTTP request when its deadline timer is unavailable', async() => {
		const scheduling = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
			throw new Error('timer unavailable')
		})
		const transport = vi.fn(async() => new Response(null, {status: 200}))
		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', transport
		})
		const record: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}
		try {
			await expect(exporter.export([record])).resolves.toMatchObject({
				status: 'retryable', acceptedCount: 0
			})
			expect(transport).not.toHaveBeenCalled()
		} finally { scheduling.mockRestore() }
	})

	it('rejects Proxy span batches without invoking their traps', async() => {
		const length = vi.fn(() => { throw new Error('length trap executed') })
		const spans = new Proxy([], {get: (_target, key) => key === 'length' ? length() : undefined})
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})

		await expect(exporter.export(spans)).resolves.toMatchObject({status: 'permanent-failure'})
		expect(length).not.toHaveBeenCalled()
		expect(mockFetch).not.toHaveBeenCalled()
	})

	it('does not assimilate thenables returned by a custom transport', async() => {
		const then = vi.fn()
		const transport = vi.fn(() => ({then})) as never
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp', transport})
		const record: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}

		await expect(exporter.export([record])).resolves.toMatchObject({status: 'retryable'})
		expect(then).not.toHaveBeenCalled()
	})

	it('retains abort ownership after a transport rewires AbortController', async() => {
		vi.useFakeTimers()
		const nativeAbort = AbortController.prototype.abort
		let signal: AbortSignal | undefined
		try {
			const transport = vi.fn((_input: unknown, init?: Parameters<typeof fetch>[1]) => {
				signal = init?.signal ?? undefined
				AbortController.prototype.abort = () => { throw new Error('rewired abort') }
				return new Promise<Response>(() => undefined)
			})
			const exporter = createHttpOtlpExporter({
				endpoint: 'https://example.com/otlp', timeoutMs: 5, transport: transport as typeof fetch
			})
			const record: SpanRecord = {
				name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
			}
			const pending = exporter.export([record])
			await vi.advanceTimersByTimeAsync(5)
			await expect(pending).resolves.toMatchObject({status: 'permanent-failure'})
			expect(signal?.aborted).toBe(true)
		} finally {
			AbortController.prototype.abort = nativeAbort
			vi.useRealTimers()
		}
	})

	it('does not start an HTTP request when its deadline fires before scheduling returns', async() => {
		const scheduling = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], _ms?: number, ...args: unknown[]) => {
			Reflect.apply(callback as (...values: unknown[]) => void, undefined, args)
			return {unref: vi.fn()} as never
		}) as typeof setTimeout)
		const transport = vi.fn(async() => new Response(null, {status: 200}))
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp', transport})
		const record: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}
		try {
			await expect(exporter.export([record])).resolves.toMatchObject({status: 'retryable'})
			expect(transport).not.toHaveBeenCalled()
		} finally { scheduling.mockRestore() }
	})

	it('rejects malformed HTTP OTLP configuration', () => {
		let coercions = 0
		const hostile = {[Symbol.toPrimitive]: () => { coercions++; return 1 }}
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', timeoutMs: hostile as never
		})).toThrow('timeoutMs must be between')
		expect(coercions).toBe(0)
		expect(() => createHttpOtlpExporter({endpoint: 'not-a-url'})).toThrow()
		expect(() => createHttpOtlpExporter({endpoint: 'ftp://example.com/traces'})).toThrow('HTTP or HTTPS')
		expect(() => createHttpOtlpExporter({endpoint: 'https://user:secret@example.com/traces'})).toThrow('credentials')
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp',
			timeoutMs: Number.NaN
		})).toThrow('timeoutMs must be between')
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp',
			headers: {authorization: 1 as unknown as string}
		})).toThrow()
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', headers: {'content-type': 'text/plain'}
		})).toThrow('managed by the exporter')
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', timeoutMs: 2_147_483_648
		})).toThrow('2147483647')
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', headers: {'bad header': 'value'}
		})).toThrow('HTTP tokens')
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', headers: {Authorization: 'one', authorization: 'two'}
		})).toThrow('duplicated case-insensitively')
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', headers: {authorization: 'bad\r\nvalue'}
		})).toThrow('invalid')
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', headers: {authorization: 'x'.repeat(100_000)}
		})).toThrow('invalid')
		let getterCalls = 0
		const accessor = Object.defineProperty({}, 'endpoint', {
			enumerable: true,
			get: () => { getterCalls++; return 'https://example.com/otlp' }
		})
		expect(() => createHttpOtlpExporter(accessor as never)).toThrow('closed plain data object')
		expect(getterCalls).toBe(0)
	})

	it('bounds non-cooperative transport timeouts and retains physical request ownership', async() => {
		vi.useFakeTimers()
		try {
			const signals: AbortSignal[] = []
			const transport = vi.fn((_input: unknown, init?: Parameters<typeof fetch>[1]) => {
				if (init?.signal) signals.push(init.signal)
				return new Promise<Response>(() => undefined)
			})
			const exporter = createHttpOtlpExporter({
				endpoint: 'https://example.com/otlp', timeoutMs: 5, transport: transport as typeof fetch
			})
			const span: SpanRecord = {
				name: 'bounded', kind: 'internal',
				context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
			}
			const exports = Array.from({length: 32}, async() => await exporter.export([span]))

			await vi.advanceTimersByTimeAsync(5)
			await expect(Promise.all(exports)).resolves.toEqual(expect.arrayContaining([
				expect.objectContaining({status: 'permanent-failure', acceptedCount: 0})
			]))
			expect(transport).toHaveBeenCalledTimes(16)
			expect(signals).toHaveLength(16)
			expect(signals.every((signal) => signal.aborted)).toBe(true)

			await expect(exporter.export([span])).resolves.toMatchObject({
				status: 'retryable', acceptedCount: 0
			})
			expect(transport).toHaveBeenCalledTimes(16)

			await expect(exporter.shutdown()).resolves.toBeUndefined()
			await expect(exporter.export([span])).resolves.toMatchObject({
				status: 'permanent-failure', acceptedCount: 0
			})
			expect(transport).toHaveBeenCalledTimes(16)
		} finally {
			vi.useRealTimers()
		}
	})

	it('aborts owned requests and permanently closes admission during shutdown', async() => {
		let signal: AbortSignal | undefined
		const transport = vi.fn((_input: unknown, init?: Parameters<typeof fetch>[1]) =>
			new Promise<Response>((_resolve, reject) => {
				signal = init?.signal ?? undefined
				signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
			}))
		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', timeoutMs: 10_000, transport: transport as typeof fetch
		})
		const span: SpanRecord = {
			name: 'shutdown', kind: 'internal',
			context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}
		const pending = exporter.export([span])
		await Promise.resolve()

		await expect(exporter.shutdown()).resolves.toBeUndefined()
		expect(signal?.aborted).toBe(true)
		await expect(pending).resolves.toMatchObject({status: 'retryable', acceptedCount: 0})
		await expect(exporter.export([span])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})
		expect(transport).toHaveBeenCalledOnce()
	})

	it('bounds descriptor inspection before rejecting very wide OTLP headers', () => {
		let descriptorReads = 0
		const headers = new Proxy(
			Object.fromEntries(Array.from({length: 10_000}, (_, index) => [`x-header-${index}`, 'value'])),
			{
				getOwnPropertyDescriptor: (target, key) => {
					descriptorReads++
					return Reflect.getOwnPropertyDescriptor(target, key)
				}
			}
		)
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', headers
		})).toThrow('at most 100 fields')
		expect(descriptorReads).toBeLessThanOrEqual(202)
	})

	it('rejects oversized header names at the snapshot boundary', () => {
		expect(() => createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', headers: {['x'.repeat(1_000_000)]: 'value'}
		})).toThrow('at most 100 fields')
	})

	it('maps public-network policy failures to permanent delivery outcomes', async() => {
		const transport = vi.fn(async() => { throw Object.assign(new Error('private'), {
			code: 'PUBLIC_HTTPS_NON_PUBLIC_ENDPOINT', retryable: false
		}) }) as never
		const exporter = createHttpOtlpExporter({
			endpoint: 'https://collector.example/v1/traces', transport
		})
		const base: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}
		await expect(exporter.export([base])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0,
			error: {code: 'PUBLIC_HTTPS_NON_PUBLIC_ENDPOINT'}
		})
	})

	it('reports collector partial success accurately', async() => {
		mockFetch.mockResolvedValue({
			ok: true, status: 200, statusText: 'OK',
			json: async() => ({partialSuccess: {rejectedSpans: '1'}})
		})
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const base: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}
		await expect(exporter.export([base, {...base, name: 'two'}])).resolves.toMatchObject({
			status: 'partial', acceptedCount: 1, error: expect.any(Error)
		})
	})

	it('does not treat malformed or oversized HTTP 200 bodies as confirmed delivery', async() => {
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const base: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}
		mockFetch.mockResolvedValueOnce(new Response('{invalid', {status: 200}))
		await expect(exporter.export([base])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})

		mockFetch.mockResolvedValueOnce(new Response('x'.repeat(64 * 1_024 + 1), {status: 200}))
		await expect(exporter.export([base])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async() => ({partialSuccess: {rejectedSpans: 'not-a-count'}})
		})
		await expect(exporter.export([base])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async() => ({partialSuccess: 1})
		})
		await expect(exporter.export([base])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})

		let rejectedCountReads = 0
		const partialSuccess = Object.defineProperty({}, 'rejectedSpans', {
			enumerable: true,
			get: () => { rejectedCountReads++; return 0 }
		})
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async() => ({partialSuccess})
		})
		await expect(exporter.export([base])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})
		expect(rejectedCountReads).toBe(0)
	})

	it('does not assimilate thenables returned by collector response methods', async() => {
		const then = vi.fn()
		mockFetch.mockResolvedValueOnce({ok: true, status: 200, json: () => ({then})})
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const record: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}

		await expect(exporter.export([record])).resolves.toMatchObject({status: 'permanent-failure'})
		expect(then).not.toHaveBeenCalled()
	})

	it('bounds zero-byte collector stream reads', async() => {
		const cancel = vi.fn(async() => undefined)
		const read = vi.fn(async() => ({done: false, value: new Uint8Array(0)}))
		mockFetch.mockResolvedValueOnce({
			ok: true,
			body: {getReader: () => ({read, cancel})}
		})
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const span: SpanRecord = {
			name: 'bounded-response', kind: 'internal',
			context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}

		await expect(exporter.export([span])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})
		expect(read).toHaveBeenCalledTimes(4_097)
		expect(cancel).toHaveBeenCalledOnce()
	})

	it('does not invoke accessor-backed stream result fields', async() => {
		const done = vi.fn(() => true)
		const read = vi.fn(async() => Object.defineProperty({}, 'done', {enumerable: true, get: done}))
		mockFetch.mockResolvedValueOnce({
			ok: true, status: 200, body: {getReader: () => ({read})}
		})
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const record: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}

		await expect(exporter.export([record])).resolves.toMatchObject({status: 'permanent-failure'})
		expect(done).not.toHaveBeenCalled()
	})

	it('retains retry-header parsing after a response callback rewires RegExp.test', async() => {
		const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, 'test')!
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 429,
			headers: {get: () => {
				Object.defineProperty(RegExp.prototype, 'test', {
					configurable: true, writable: true, value: () => { throw new Error('rewired RegExp.test') }
				})
				return '1'
			}}
		})
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const record: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}
		let result
		try { result = await exporter.export([record]) }
		finally { Object.defineProperty(RegExp.prototype, 'test', descriptor) }
		expect(result).toMatchObject({status: 'throttled', retryAfterMs: 1_000})
	})

	it('fails closed across hostile JSON-only collector response shapes', async() => {
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const base: SpanRecord = {
			name: 'one', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}
		const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
		const symbolKeyed = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`hidden-${index}`), index]
		))
		const sparse = new Array(1)
		const malformed: unknown[] = [null, 'primitive', Number.NaN, new Date(), cyclic, sparse]
		for (const payload of malformed) {
			mockFetch.mockResolvedValueOnce({ok: true, json: async() => payload})
			await expect(exporter.export([base])).resolves.toMatchObject({status: 'permanent-failure', acceptedCount: 0})
		}
		const enumerateSymbols = vi.spyOn(Object, 'getOwnPropertySymbols')
			.mockImplementation(() => [])
		let symbolResult: Awaited<ReturnType<typeof exporter.export>>
		let enumerationCalls = 0
		try {
			mockFetch.mockResolvedValueOnce({ok: true, json: async() => symbolKeyed})
			symbolResult = await exporter.export([base])
			enumerationCalls = enumerateSymbols.mock.calls.length
		} finally { enumerateSymbols.mockRestore() }
		expect(symbolResult!).toMatchObject({status: 'success', acceptedCount: 1})
		expect(enumerationCalls).toBe(0)

		const oversized = 'x'.repeat(1_000_000)
		const stringify = vi.spyOn(JSON, 'stringify')
		mockFetch.mockResolvedValueOnce({ok: true, json: async() => oversized})
		await expect(exporter.export([base])).resolves.toMatchObject({status: 'permanent-failure', acceptedCount: 0})
		expect(stringify.mock.calls.some(([value]) => value === oversized)).toBe(false)
		stringify.mockRestore()

		mockFetch.mockResolvedValueOnce({ok: true, json: async() => ({})})
		await expect(exporter.export([base])).resolves.toMatchObject({status: 'success', acceptedCount: 1})
		mockFetch.mockResolvedValueOnce({ok: true, json: async() => ({partialSuccess: {}})})
		await expect(exporter.export([base])).resolves.toMatchObject({status: 'success', acceptedCount: 1})
		mockFetch.mockResolvedValueOnce({
			ok: true, json: async() => ({partialSuccess: {rejectedSpans: undefined}})
		})
		await expect(exporter.export([base])).resolves.toMatchObject({status: 'permanent-failure', acceptedCount: 0})
	})

	it('returns a permanent result when a hostile span cannot be serialized', async() => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const invalid: SpanRecord = {
			name: 'invalid', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: cyclic as never, events: []
		}
		await expect(exporter.export([invalid])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})
		expect(mockFetch).not.toHaveBeenCalled()

		await expect(exporter.export(new Array(10_001).fill(invalid))).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})
		const encode = vi.spyOn(TextEncoder.prototype, 'encode')
		const oversized = {...invalid, attributes: {payload: 'x'.repeat(17 * 1_024 * 1_024)}}
		delete (oversized.attributes as Record<string, unknown>).self
		await expect(exporter.export([oversized as SpanRecord])).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0
		})
		expect(encode.mock.calls.every(([value]) => value.length <= 16 * 1_024 * 1_024)).toBe(true)
		encode.mockRestore()
		expect(mockFetch).not.toHaveBeenCalled()
	})

	it('preflights OTLP wrapper amplification before serializing the complete batch', async() => {
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const attributes = {amplified: Array.from({length: 2_000}, () => [])}
		const spans = Array.from({length: 300}, (_, index): SpanRecord => ({
			name: `amplified-${index}`,
			kind: 'internal',
			context: {traceId: 'a'.repeat(32), spanId: index.toString(16).padStart(16, '0').replace(/^0{16}$/u, '0000000000000001')},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes, events: []
		}))
		const stringify = vi.spyOn(JSON, 'stringify')

		await expect(exporter.export(spans)).resolves.toMatchObject({
			status: 'permanent-failure', acceptedCount: 0,
			error: {message: 'OTLP export payload exceeds 16 MiB'}
		})
		expect(stringify.mock.calls.some(([value]) => {
			if (!value || typeof value !== 'object') return false
			const resourceSpans = (value as {resourceSpans?: unknown}).resourceSpans
			if (!Array.isArray(resourceSpans)) return false
			return resourceSpans.some((resource) => {
				const scopeSpans = (resource as {scopeSpans?: unknown}).scopeSpans
				if (!Array.isArray(scopeSpans)) return false
				return scopeSpans.some((scope) => Array.isArray((scope as {spans?: unknown}).spans)
					&& ((scope as {spans: unknown[]}).spans.length > 1))
			})
		})).toBe(false)
		stringify.mockRestore()
		expect(mockFetch).not.toHaveBeenCalled()
	}, 120_000)

	it('should export spans via HTTP POST', async() => {

		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK'
		})

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}
		await exporter.export([span])

		expect(mockFetch).toHaveBeenCalledTimes(1)
		const call = mockFetch.mock.calls[0]
		expect(call?.[0]).toBe('https://example.com/otlp')
		expect(call?.[1]).toMatchObject({
			method: 'POST',
			redirect: 'error',
			headers: {
				'Content-Type': 'application/json'
			}
		})
		expect(call?.[1]?.body).toBeDefined()
	})

	it('should include custom headers', async() => {

		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK'
		})

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp',
			headers: {
				'Authorization': 'Bearer token123',
				'X-Custom-Header': 'value'
			}
		})

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}
		await exporter.export([span])

		expect(mockFetch).toHaveBeenCalledTimes(1)
		const call = mockFetch.mock.calls[0]
		expect(call?.[1]?.headers).toMatchObject({
			'Content-Type': 'application/json',
			'Authorization': 'Bearer token123',
			'X-Custom-Header': 'value'
		})
	})

	it('captures its Fetch transport and isolates request headers from transport mutation', async() => {
		const observedAuthorization: string[] = []
		const capturedFetch = vi.fn(async(
			_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]
		) => {
			const headers = init?.headers as Record<string, string>
			observedAuthorization.push(headers.Authorization ?? '')
			headers.Authorization = 'mutated-by-transport'
			return {ok: true, status: 200} as Response
		})
		const replacementFetch = vi.fn()
		global.fetch = capturedFetch as typeof fetch
		try {
			const exporter = createHttpOtlpExporter({
				endpoint: 'https://example.com/otlp', headers: {Authorization: 'Bearer original'}
			})
			global.fetch = replacementFetch as typeof fetch
			const record: SpanRecord = {
				name: 'captured', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
				status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
			}

			await expect(exporter.export([record])).resolves.toMatchObject({status: 'success'})
			await expect(exporter.export([record])).resolves.toMatchObject({status: 'success'})
			expect(observedAuthorization).toEqual(['Bearer original', 'Bearer original'])
			expect(capturedFetch).toHaveBeenCalledTimes(2)
			expect(replacementFetch).not.toHaveBeenCalled()
		} finally {
			global.fetch = mockFetch
		}
	})

	it('should handle empty spans array', async() => {

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		await exporter.export([])

		expect(mockFetch).not.toHaveBeenCalled()
	})

	it('should throw on HTTP error', async() => {

		mockFetch.mockResolvedValue({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error'
		})

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}
		const result = await exporter.export([span])
		expect(result.status).toBe('retryable')
		expect(result.acceptedCount).toBe(0)
		expect(result.error?.message).toBe('OTLP export failed: HTTP 500')
	})

	it('should handle network errors', async() => {

		mockFetch.mockRejectedValue(new Error('Network error: https://user:secret@example.com/otlp?token=secret'))

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}
		const result = await exporter.export([span])
		expect(result.status).toBe('retryable')
		expect(result.acceptedCount).toBe(0)
		expect(result.error?.message).toBe('OTLP export request failed')
		expect(result.error?.message).not.toContain('secret')
	})

	it('should accept custom timeout option', () => {

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp',
			timeoutMs: 1000
		})

		expect(exporter).toBeDefined()
	})

	it('should use default timeout of 5000ms', () => {

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		expect(exporter).toBeDefined()
	})

	it('should shutdown without error', async() => {

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		await expect(exporter.shutdown()).resolves.toBeUndefined()
	})

	it('should export multiple spans in one request', async() => {

		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK'
		})

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		const span1: SpanRecord = {
			name: 'span1',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}
		const span2: SpanRecord = {
			name: 'span2',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: 'abcdef1234567890',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}
		const span3: SpanRecord = {
			name: 'span3',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: 'fedcba0987654321',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}

		await exporter.export([span1, span2, span3])

		expect(mockFetch).toHaveBeenCalledTimes(1)
		const call = mockFetch.mock.calls[0]
		expect(call?.[1]?.body).toBeDefined()
		// Body should contain all three spans in OTLP format
		const body = call?.[1]?.body as string
		expect(body).toContain('span1')
		expect(body).toContain('span2')
		expect(body).toContain('span3')
	})

	it('should return throttled status with numeric Retry-After', async() => {

		mockFetch.mockResolvedValue({
			ok: false,
			status: 429,
			statusText: 'Too Many Requests',
			headers: {
				get: vi.fn().mockReturnValue('3')
			}
		})

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		const result = await exporter.export([{
			name: 'throttled.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}])

		expect(result.status).toBe('throttled')
		if (result.status === 'throttled') {
			expect(result.retryAfterMs).toBe(3000)
		}
	})

	it.each(['1.5', '1e3', '+3', '-1'])('ignores malformed delta-seconds Retry-After %s', async(retryAfter) => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 429,
			headers: {get: () => retryAfter}
		})
		const exporter = createHttpOtlpExporter({endpoint: 'https://example.com/otlp'})
		const result = await exporter.export([{
			name: 'throttled', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}])

		expect(result.status).toBe('throttled')
		expect(result.retryAfterMs).toBeUndefined()
	})

	it('should return permanent failure for non-retryable HTTP responses', async() => {
		const cancel = vi.fn(async() => undefined)

		mockFetch.mockResolvedValue({
			ok: false,
			status: 400,
			statusText: 'Bad Request',
			headers: {
				get: vi.fn().mockReturnValue(null)
			},
			body: {cancel}
		})

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp'
		})

		const result = await exporter.export([{
			name: 'bad.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}])

		expect(result.status).toBe('permanent-failure')
		expect(result.acceptedCount).toBe(0)
		expect(cancel).toHaveBeenCalledOnce()
	})

	it('should parse date-based Retry-After and send compressed payloads when enabled', async() => {

		const retryAt = new Date(Date.now() + 2000).toUTCString()
		mockFetch.mockResolvedValue({
			ok: false,
			status: 408,
			statusText: 'Request Timeout',
			headers: {
				get: vi.fn().mockImplementation((name: string) => name === 'retry-after' ? retryAt : null)
			}
		})

		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp',
			compress: true
		})

		const result = await exporter.export([{
			name: 'compressed.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			status: {code: 'ok'},
			startTime: Date.now(),
			endTime: Date.now(),
			attributes: {},
			events: []
		}])

		const call = mockFetch.mock.calls.at(-1)
		expect(call?.[1]?.headers).toMatchObject({
			'Content-Encoding': 'gzip'
		})
		expect(call?.[1]?.body).toBeInstanceOf(Uint8Array)
		const decompressed = gunzipSync(Buffer.from(call?.[1]?.body as Uint8Array)).toString('utf8')
		expect(decompressed).toContain('compressed.span')
		expect(result.status).toBe('retryable')
		if (result.status === 'retryable') {
			expect(result.retryAfterMs).toBeGreaterThanOrEqual(0)
		}
	})

	it('uses the injected epoch clock for date-based Retry-After', async() => {
		mockFetch.mockResolvedValue({
			ok: false, status: 429,
			headers: {get: () => new Date(12_000).toUTCString()}
		})
		const exporter = createHttpOtlpExporter({
			endpoint: 'https://example.com/otlp', clock: createFixedClock(10_000)
		})
		const result = await exporter.export([{
			name: 'clocked', kind: 'internal', context: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
			status: {code: 'ok'}, startTime: 0, endTime: 1, attributes: {}, events: []
		}])
		expect(result).toMatchObject({status: 'throttled', retryAfterMs: 2_000})
	})
})
