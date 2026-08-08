import {describe, expect, it, vi} from 'vitest'

import {createHttpNdjsonPerformanceEventExporter} from '../../../../src/performance/public/custom-exporters-http'
import {definePerformanceEventExporter} from '../../../../src/performance/public/custom-exporters-raw'

const record = {recordedAt: 100, source: 'mark' as const, event: {name: 'request', duration: 42, start: 58, end: 100, source: 'mark' as const}}

describe('allowed performance exporters', () => {
	it('preserves custom raw exporter identity and behavior', async() => {
		const exportBatch = vi.fn(async() => undefined)
		const exporter = definePerformanceEventExporter({export: exportBatch})
		await exporter.export([record])
		expect(exportBatch).toHaveBeenCalledWith([record])
	})

	it('posts NDJSON from the custom-only entrypoint', async() => {
		const fetchImpl = vi.fn(async() => ({ok: true, status: 202}))
		const exporter = createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', fetchImpl: fetchImpl as never})
		await exporter.export([record])
		expect(fetchImpl).toHaveBeenCalledWith('https://collector.example/perf', expect.objectContaining({
			method: 'POST', body: `${JSON.stringify(record)}\n`, redirect: 'error'
		}))
		await exporter.export([])
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('releases response bodies after successful and failed HTTP delivery', async() => {
		const successfulCancel = vi.fn(async() => undefined)
		const successful = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: vi.fn(async() => ({
				ok: true, status: 202, body: {cancel: successfulCancel}
			})) as never
		})
		await successful.export([record])
		expect(successfulCancel).toHaveBeenCalledOnce()

		const failedCancel = vi.fn(async() => undefined)
		const failed = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: vi.fn(async() => ({
				ok: false, status: 503, body: {cancel: failedCancel}
			})) as never
		})
		await expect(failed.export([record])).rejects.toMatchObject({code: 'http_server_error'})
		expect(failedCancel).toHaveBeenCalledOnce()
	})

	it('isolates synchronous and asynchronous response-body cleanup failures', async() => {
		for (const cancel of [
			vi.fn(() => { throw new Error('sync cleanup failure') }),
			vi.fn(async() => { throw new Error('async cleanup failure') })
		]) {
			const exporter = createHttpNdjsonPerformanceEventExporter({
				url: 'https://collector.example/perf',
				fetchImpl: vi.fn(async() => ({ok: true, status: 202, body: {cancel}})) as never
			})
			await expect(exporter.export([record])).resolves.toBeUndefined()
			expect(cancel).toHaveBeenCalledOnce()
		}
	})

	it('does not execute response or cleanup accessors after transport settlement', async() => {
		const readOk = vi.fn(() => true)
		const readStatus = vi.fn(() => 202)
		const accessorResponse = Object.defineProperties({}, {
			ok: {enumerable: true, get: readOk},
			status: {enumerable: true, get: readStatus}
		})
		const invalid = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: vi.fn(async() => accessorResponse) as never
		})
		await expect(invalid.export([record])).rejects.toMatchObject({code: 'invalid_fetch_response'})
		expect(readOk).not.toHaveBeenCalled()
		expect(readStatus).not.toHaveBeenCalled()

		const readBody = vi.fn(() => ({cancel: vi.fn()}))
		const response = Object.defineProperty({ok: true, status: 202}, 'body', {get: readBody})
		const successful = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: vi.fn(async() => response) as never
		})
		await expect(successful.export([record])).resolves.toBeUndefined()
		expect(readBody).not.toHaveBeenCalled()

		const readCatch = vi.fn(() => vi.fn())
		const disposal = new Proxy({}, {get: readCatch})
		const cancel = vi.fn(() => disposal)
		const cleanupResponse = {ok: true, status: 202, body: {cancel}}
		const cleanup = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: vi.fn(async() => cleanupResponse) as never
		})
		await expect(cleanup.export([record])).resolves.toBeUndefined()
		expect(cancel).toHaveBeenCalledOnce()
		expect(readCatch).not.toHaveBeenCalled()

		const inheritedDescriptor = vi.fn(() => { throw new Error('must not inspect') })
		const body = Object.create(new Proxy({}, {getOwnPropertyDescriptor: inheritedDescriptor})) as object
		const inheritedCleanup = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: vi.fn(async() => ({ok: true, status: 202, body})) as never
		})
		await expect(inheritedCleanup.export([record])).resolves.toBeUndefined()
		expect(inheritedDescriptor).not.toHaveBeenCalled()

		const getOwnPropertyDescriptor = vi.fn(() => ({configurable: true, enumerable: true, value: true}))
		const proxyResponse = new Proxy({}, {getOwnPropertyDescriptor})
		const proxied = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: vi.fn(async() => proxyResponse) as never
		})
		await expect(proxied.export([record])).rejects.toMatchObject({code: 'invalid_fetch_response'})
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})

	it('snapshots validated transport configuration at construction', async() => {
		const fetchImpl = vi.fn(async() => ({ok: true, status: 202}))
		const headers = {authorization: 'Bearer original', 'Content-Type': 'text/plain'}
		const options = {url: 'https://collector.example/perf', headers, fetchImpl: fetchImpl as never}
		const exporter = createHttpNdjsonPerformanceEventExporter(options)
		options.url = 'file:///tmp/bypassed'
		headers.authorization = 'Bearer mutated'
		await exporter.export([record])
		expect(fetchImpl).toHaveBeenCalledWith('https://collector.example/perf', expect.objectContaining({
			headers: expect.objectContaining({
				authorization: 'Bearer original',
				'content-type': 'application/x-ndjson'
			})
		}))
	})

	it('validates transport configuration and rejects unserializable batches without retry', async() => {
		expect(() => createHttpNdjsonPerformanceEventExporter(null as never)).toThrow('options')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: ''})).toThrow()
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'file:///tmp/perf'})).toThrow('HTTP or HTTPS')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'http://collector.example/perf'})).toThrow('must use HTTPS')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'http://127.0.0.1:4318/perf'})).not.toThrow()
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'http://[::1]:4318/perf'})).not.toThrow()
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', headers: {authorization: 1 as never}})).toThrow('Header value')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', fetchImpl: 1 as never})).toThrow('fetch implementation')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', timeoutMs: 1.5})).toThrow('timeoutMs')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', timeoutMs: 30_001})).toThrow('30000')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'https://user:secret@collector.example/perf'})).toThrow('credentials')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf?api_key=secret'})).toThrow('query parameters')
		expect(() => createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf#secret'})).toThrow('fragments')
		expect(() => createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf', headers: {'content-length': '1'}
		})).toThrow('managed')
		expect(() => createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf', headers: {'x-test': 'unsafe\r\nvalue'}
		})).toThrow('invalid')
		expect(() => createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf', headers: {'X-Token': 'first', 'x-token': 'second'}
		})).toThrow('duplicated case-insensitively')
		const accessor = Object.defineProperty({}, 'url', {
			enumerable: true, get: () => 'https://collector.example/perf'
		})
		expect(() => createHttpNdjsonPerformanceEventExporter(accessor as never)).toThrow('closed plain data object')
		const fetchImpl = vi.fn()
		const exporter = createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', fetchImpl: fetchImpl as never})
		const circular = {...record} as Record<string, unknown>
		circular.self = circular
		await expect(exporter.export([circular as never])).rejects.toMatchObject({
			code: 'event_serialization_failed', retryable: false
		})
		await expect(exporter.export([undefined as never])).rejects.toMatchObject({
			code: 'event_serialization_failed', retryable: false
		})
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('rejects proxy headers and records before invoking ownKeys', async() => {
		const headerOwnKeys = vi.fn(() => ['authorization'])
		const headers = new Proxy({}, {ownKeys: headerOwnKeys}) as Record<string, string>
		expect(() => createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf', headers
		})).toThrow('closed plain data object')
		expect(headerOwnKeys).not.toHaveBeenCalled()

		const recordOwnKeys = vi.fn(() => ['recordedAt', 'source', 'event'])
		const hostileRecord = new Proxy(record, {ownKeys: recordOwnKeys})
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf', fetchImpl: vi.fn() as never
		})
		await expect(exporter.export([hostileRecord])).rejects.toMatchObject({
			code: 'event_serialization_failed', retryable: false
		})
		expect(recordOwnKeys).not.toHaveBeenCalled()
	})

	it('rejects oversized option keys before policy lookup', () => {
		const oversizedKey = 'x'.repeat(1_048_577)
		const setHas = vi.spyOn(Set.prototype, 'has')
		try {
			expect(() => createHttpNdjsonPerformanceEventExporter({
				url: 'https://collector.example/perf', [oversizedKey]: true
			} as never)).toThrow('closed plain data object')
			expect(setHas.mock.calls.some(([value]) => value === oversizedKey)).toBe(false)
		} finally {
			setHas.mockRestore()
		}
	})

	it('bounds direct HTTP exporter batches by count and serialized bytes', async() => {
		const fetchImpl = vi.fn(async() => ({ok: true, status: 202}))
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf', fetchImpl: fetchImpl as never
		})
		await expect(exporter.export(Array.from({length: 257}, () => record)))
			.rejects.toMatchObject({code: 'event_serialization_failed', retryable: false})
		await expect(exporter.export([{
			...record,
			event: {...record.event, labels: {padding: 'x'.repeat(1_100_000)}}
		}])).rejects.toMatchObject({code: 'event_serialization_failed', retryable: false})
		await expect(exporter.export([{
			...record,
			event: {...record.event, labels: {padding: 'x'.repeat(20_000_000)}}
		}])).rejects.toMatchObject({code: 'event_serialization_failed', retryable: false})
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('does not execute accessor-backed records or toJSON hooks', async() => {
		const fetchImpl = vi.fn(async() => ({ok: true, status: 202}))
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf', fetchImpl: fetchImpl as never
		})
		const readRecord = vi.fn(() => record)
		const accessorBatch: unknown[] = []
		Object.defineProperty(accessorBatch, '0', {enumerable: true, get: readRecord})
		Object.defineProperty(accessorBatch, 'length', {value: 1})
		await expect(exporter.export(accessorBatch as never)).rejects.toMatchObject({
			code: 'event_serialization_failed', retryable: false
		})
		expect(readRecord).not.toHaveBeenCalled()

		const toJSON = vi.fn(() => ({leaked: true}))
		await expect(exporter.export([{...record, toJSON} as never])).rejects.toMatchObject({
			code: 'event_serialization_failed', retryable: false
		})
		expect(toJSON).not.toHaveBeenCalled()
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('bounds HTTP delivery with an aborting transport timeout', async() => {
		const fetchImpl = vi.fn((_url: string, init?: Parameters<typeof fetch>[1]) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')))
		}))
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: fetchImpl as never,
			timeoutMs: 5
		})

		await expect(exporter.export([record])).rejects.toMatchObject({
			code: 'fetch_aborted', retryable: true
		})
	})

	it('contains abort-controller failures inside the transport timeout', async() => {
		class BrokenAbortController {
			signal = {} as AbortSignal
			abort(): void { throw new Error('abort failed') }
		}
		vi.stubGlobal('AbortController', BrokenAbortController)
		try {
			const exporter = createHttpNdjsonPerformanceEventExporter({
				url: 'https://collector.example/perf',
				fetchImpl: vi.fn(() => new Promise<Response>(() => {})) as never,
				timeoutMs: 5
			})
			await expect(exporter.export([record])).rejects.toMatchObject({
				code: 'fetch_aborted', retryable: true
			})
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('preserves transport success and body disposal when timeout cleanup fails', async() => {
		const cancel = vi.fn(async() => undefined)
		const timer = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(1 as never)
		const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => { throw new Error('clear failed') })
		try {
			const exporter = createHttpNdjsonPerformanceEventExporter({
				url: 'https://collector.example/perf',
				fetchImpl: vi.fn(async() => ({ok: true, status: 200, body: {cancel}})) as never
			})
			await expect(exporter.export([record])).resolves.toBeUndefined()
			expect(cancel).toHaveBeenCalledOnce()
		} finally {
			timer.mockRestore()
			clear.mockRestore()
		}
	})

	it('bounds fetch implementations that ignore abort signals and rejects malformed responses', async() => {
		const hangingFetch = vi.fn(() => new Promise<Response>(() => {}))
		const hanging = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: hangingFetch as never,
			timeoutMs: 5
		})
		await expect(hanging.export([record])).rejects.toMatchObject({
			code: 'fetch_aborted', retryable: true
		})
		await expect(hanging.export([record])).rejects.toMatchObject({
			code: 'fetch_aborted', retryable: true
		})
		expect(hangingFetch).toHaveBeenCalledOnce()

		const readThen = vi.fn(() => { throw new Error('must not assimilate') })
		const hostileThenable = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: vi.fn(() => Object.defineProperty({}, 'then', {get: readThen})) as never
		})
		await expect(hostileThenable.export([record])).rejects.toMatchObject({
			code: 'invalid_fetch_response', retryable: false
		})
		expect(readThen).not.toHaveBeenCalled()

		for (const response of [
			{ok: 'yes', status: 200},
			{ok: true, status: 0},
			{ok: true, status: 500},
			{ok: false, status: 202}
		]) {
			const malformed = createHttpNdjsonPerformanceEventExporter({
				url: 'https://collector.example/perf',
				fetchImpl: vi.fn(async() => response) as never
			})
			await expect(malformed.export([record])).rejects.toMatchObject({
				code: 'invalid_fetch_response', retryable: false
			})
		}
	})

	it('admits only one timed invocation for a shared active HTTP request', async() => {
		const hangingFetch = vi.fn(() => new Promise<Response>(() => undefined))
		const timer = vi.spyOn(globalThis, 'setTimeout')
		const byteLength = vi.spyOn(Buffer, 'byteLength')
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: hangingFetch as never,
			timeoutMs: 5
		})

		const results = await Promise.allSettled(Array.from(
			{length: 1_000},
			async() => await exporter.export([record])
		))

		expect(results.every((result) => result.status === 'rejected')).toBe(true)
		expect(hangingFetch).toHaveBeenCalledOnce()
		expect(timer).toHaveBeenCalledOnce()
		expect(byteLength.mock.calls.length).toBeLessThan(20)
		timer.mockRestore()
		byteLength.mockRestore()
	})

	it('blocks new requests while response body cleanup is physically unresolved', async() => {
		let release!: () => void
		const cleanup = new Promise<void>((resolve) => { release = resolve })
		const cancel = vi.fn(() => cleanup)
		const fetchImpl = vi.fn(async() => ({ok: true, status: 202, body: {cancel}}))
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: fetchImpl as never
		})

		await expect(exporter.export([record])).resolves.toBeUndefined()
		const blocked = await Promise.allSettled(Array.from(
			{length: 1_000},
			async() => await exporter.export([record])
		))
		expect(blocked.every((result) => result.status === 'rejected')).toBe(true)
		expect(fetchImpl).toHaveBeenCalledOnce()
		expect(cancel).toHaveBeenCalledOnce()

		release()
		await cleanup
		await Promise.resolve()
		await expect(exporter.export([record])).resolves.toBeUndefined()
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('recovers from a never-settling body cleanup without accumulating cleanup calls', async() => {
		vi.useFakeTimers()
		try {
			const cancel = vi.fn(() => new Promise<void>(() => undefined))
			const fetchImpl = vi.fn(async() => ({ok: true, status: 202, body: {cancel}}))
			const exporter = createHttpNdjsonPerformanceEventExporter({
				url: 'https://collector.example/perf', fetchImpl: fetchImpl as never, timeoutMs: 5
			})

			await expect(exporter.export([record])).resolves.toBeUndefined()
			await expect(exporter.export([record])).rejects.toMatchObject({code: 'fetch_aborted'})
			await vi.advanceTimersByTimeAsync(5)
			await expect(exporter.export([record])).resolves.toBeUndefined()
			expect(fetchImpl).toHaveBeenCalledTimes(2)
			expect(cancel).toHaveBeenCalledOnce()
		} finally {
			vi.useRealTimers()
		}
	})

	it('reuses a late successful physical request without duplicating delivery', async() => {
		let resolveFetch!: (response: Response) => void
		const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: fetchImpl as never,
			timeoutMs: 5
		})

		await expect(exporter.export([record])).rejects.toMatchObject({code: 'fetch_aborted'})
		resolveFetch({ok: true, status: 202} as Response)
		await Promise.resolve()
		await expect(exporter.export([record])).resolves.toBeUndefined()
		expect(fetchImpl).toHaveBeenCalledOnce()
	})

	it('starts a new physical request after a timed-out request settles rejected', async() => {
		let attempts = 0
		const fetchImpl = vi.fn((_url: string, init?: Parameters<typeof fetch>[1]) => {
			attempts += 1
			if (attempts > 1) return Promise.resolve({ok: true, status: 202} as Response)
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					setTimeout(() => reject(new DOMException('', 'AbortError')), 1)
				})
			})
		})
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: fetchImpl as never,
			timeoutMs: 5
		})

		await expect(exporter.export([record])).rejects.toMatchObject({code: 'fetch_aborted'})
		await new Promise((resolve) => setTimeout(resolve, 5))
		await expect(exporter.export([record])).resolves.toBeUndefined()
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('starts a new physical request after a timed-out request settles with failure', async() => {
		let resolveFirst!: (response: Response) => void
		const fetchImpl = vi.fn()
			.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve }))
			.mockResolvedValueOnce({ok: true, status: 202} as Response)
		const exporter = createHttpNdjsonPerformanceEventExporter({
			url: 'https://collector.example/perf',
			fetchImpl: fetchImpl as never,
			timeoutMs: 5
		})

		await expect(exporter.export([record])).rejects.toMatchObject({code: 'fetch_aborted'})
		resolveFirst({ok: false, status: 503} as Response)
		await new Promise((resolve) => setTimeout(resolve, 0))
		await expect(exporter.export([record])).resolves.toBeUndefined()
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('classifies retryable, terminal, and network failures', async() => {
		for (const status of [429, 400]) {
			const exporter = createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', fetchImpl: vi.fn(async() => ({ok: false, status})) as never})
			await expect(exporter.export([record])).rejects.toThrow(`status ${status}`)
		}
		const network = createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', fetchImpl: vi.fn(async() => { throw new TypeError('offline') }) as never})
		await expect(network.export([record])).rejects.toThrow()
		const synchronousNetwork = createHttpNdjsonPerformanceEventExporter({url: 'https://collector.example/perf', fetchImpl: vi.fn(() => { throw new TypeError('offline') }) as never})
		await expect(synchronousNetwork.export([record])).rejects.toMatchObject({code: 'fetch_failed', retryable: true})
	})
})
