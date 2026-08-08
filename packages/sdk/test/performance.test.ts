import {describe, expect, it, vi} from 'vitest'

import {
	instrumentFetchHandler,
	measureAsyncOperation,
	recordPerformanceMetric,
	type FetchLikeResponse
} from '../src/performance'
import {capturePerformanceMethod} from '../src/performance-port-method'

describe('fetch performance instrumentation', () => {
	it('keeps generic measured operations authoritative and executes them once', async() => {
		const asyncOperation = vi.fn(async() => 'async-result')
		const never = new Promise<never>(() => undefined)
		const performance = {
			measureAsync: vi.fn(() => never)
		}

		await expect(measureAsyncOperation(performance, 'async', asyncOperation)).resolves.toBe('async-result')
		expect(asyncOperation).toHaveBeenCalledOnce()
	})

	it('preserves independent unresolved instrumentation calls and every operation', async() => {
		const measureAsync = vi.fn(() => new Promise<void>(() => undefined))
		const operation = vi.fn(async() => 'ok')
		const performance = {measureAsync} as never

		const results = await Promise.all(Array.from(
			{length: 1_000},
			async() => await measureAsyncOperation(performance, 'operation', operation)
		))

		expect(results).toHaveLength(1_000)
		expect(results.every((result) => result === 'ok')).toBe(true)
		expect(operation).toHaveBeenCalledTimes(1_000)
		expect(measureAsync).toHaveBeenCalledTimes(1_000)
	})

	it('observes rejected promises returned by generic sync and async measurement boundaries', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('telemetry failed')))
		try {
			const performance = {
				record: (() => rejected) as never,
				measureAsync: (() => rejected) as never
			}
			recordPerformanceMetric(performance, 'count', 1)
			await expect(measureAsyncOperation(performance, 'async', async() => 'ok')).resolves.toBe('ok')
			expect(speciesReads).toBeGreaterThanOrEqual(2)
		} finally {
			await rejected.catch(() => undefined)
		}
	})

	it('bounds generic labels without invoking accessors', async() => {
		let accessorReads = 0
		const labels = Object.defineProperties({
			safe: 'x'.repeat(300), token: 'private', request_id: 'customer-123',
			key: 'private', bearer: 'private', private_key: 'private'
		}, {
			authorization: {enumerable: true, get() { accessorReads += 1; return 'Bearer private' }}
		})
		const measured: Array<[string, Record<string, string> | undefined]> = []
		const recorded: Array<[string, number, Record<string, string> | undefined]> = []
		const performance = {
			async measureAsync(name: string, operation: () => Promise<string>, current?: Record<string, string>) {
				measured.push([name, current])
				return await operation()
			},
			record(name: string, value: number, current?: Record<string, string>) {
				recorded.push([name, value, current])
			}
		}

		await expect(measureAsyncOperation(performance, 'safe.metric', async() => 'ok', labels)).resolves.toBe('ok')
		recordPerformanceMetric(performance, 'safe.metric', 1, labels)

		expect(accessorReads).toBe(0)
		expect(measured).toEqual([['safe.metric', {safe: 'x'.repeat(256)}]])
		expect(recorded).toEqual([['safe.metric', 1, {safe: 'x'.repeat(256)}]])
	})

	it('does not deliver unbounded or sensitive metric names', async() => {
		const measureAsync = vi.fn()
		const record = vi.fn()
		const operation = vi.fn(async() => 'ok')
		for (const unsafeName of ['metric?token=private', `metric${'x'.repeat(1_000)}`]) {
			await expect(measureAsyncOperation({measureAsync}, unsafeName, operation)).resolves.toBe('ok')
			recordPerformanceMetric({record}, unsafeName, 1)
		}

		expect(operation).toHaveBeenCalledTimes(2)
		expect(measureAsync).not.toHaveBeenCalled()
		expect(record).not.toHaveBeenCalled()
	})
	it('captures only stable data methods and preserves inherited receivers', () => {
		const prototype = {
			measureAsync(this: {value: string}) { return this.value }
		}
		const port = Object.assign(Object.create(prototype) as object, {value: 'bound'})
		const captured = capturePerformanceMethod(port as never, 'measureAsync')
		expect(captured?.('metric' as never)).toBe('bound')
		expect(capturePerformanceMethod(undefined, 'measureAsync')).toBeUndefined()
		expect(capturePerformanceMethod(1 as never, 'measureAsync')).toBeUndefined()
		expect(capturePerformanceMethod({}, 'measureAsync')).toBeUndefined()
		const accessor = Object.defineProperty({}, 'measureAsync', {get: expect.unreachable})
		expect(capturePerformanceMethod(accessor, 'measureAsync')).toBeUndefined()
		const {proxy, revoke} = Proxy.revocable({}, {})
		revoke()
		expect(capturePerformanceMethod(proxy, 'measureAsync')).toBeUndefined()
		let cyclic: object
		let prototypeReads = 0
		cyclic = new Proxy({}, {getPrototypeOf: () => {
			prototypeReads += 1
			return cyclic
		}})
		expect(capturePerformanceMethod(cyclic, 'measureAsync')).toBeUndefined()
		expect(prototypeReads).toBe(32)
	})
	it('falls back without a performance port', async() => {
		const handler = instrumentFetchHandler(async() => ({status: 204}), {route: '/health'})
		await expect(handler({method: 'GET'})).resolves.toEqual({status: 204})
	})

	it('redacts encoded or delimiter-bearing server routes before telemetry delivery', async() => {
		const routes: string[] = []
		const performance = {measureRequest: async(_name: string, operation: () => Promise<FetchLikeResponse>, metadata: {route: string}) => {
			routes.push(metadata.route)
			return await operation()
		}}
		for (const route of [
			'/projects/%3Ftoken%3Dprivate', '/projects/secret=private', '/projects/secret\\private',
			'https://private.example/projects', '//private.example/projects',
			"/projects/'private'", '/projects/πprivate'
		]) {
			await instrumentFetchHandler(async() => ({status: 200}), {route, performance})({})
		}

		expect(routes).toEqual(Array.from({length: 7}, () => '/redacted'))
		expect(JSON.stringify(routes)).not.toContain('private')
	})

	it('records request and response sizes from callbacks and headers', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const handler = instrumentFetchHandler(async() => ({status: 201, headers: {'content-length': '9'}}), {
			route: '/projects/:id', hostKind: 'api', runtime: 'node',
			performance: {
				measureRequest: async(_name, fn, nextMetadata) => {
					metadata.push(nextMetadata)
					return await fn()
				}
			}
		})
		await handler({headers: {'content-length': '4'}})
		expect(metadata[0]).toMatchObject({method: 'GET', requestSize: 4, responseSize: 9, hostKind: 'api', runtime: 'node'})
	})

	it('uses header getters and ignores malformed content lengths', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const handler = instrumentFetchHandler(async() => ({status: 200, headers: {get: () => 'invalid'}}), {
			route: '/health',
			performance: {measureRequest: async(_name, fn, nextMetadata) => {
				metadata.push(nextMetadata)
				return await fn()
			}}
		})
		await handler({method: 'POST', headers: {get: () => '3'}})
		expect(metadata[0]).toMatchObject({method: 'POST', requestSize: 3})
		expect(metadata[0]).not.toHaveProperty('responseSize')
	})

	it('handles absent and empty headers without recording sizes', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const handler = instrumentFetchHandler(async() => ({status: 200}), {
			route: '/plain',
			performance: {measureRequest: async(_name, fn, nextMetadata) => {
				metadata.push(nextMetadata)
				return await fn()
			}}
		})
		await handler({headers: {}})
		expect(metadata[0]).not.toHaveProperty('requestSize')
		expect(metadata[0]).not.toHaveProperty('responseSize')
	})

	it('parses content lengths strictly and case-insensitively', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const performance = {measureRequest: async(_name: string, fn: () => Promise<unknown>, next: Record<string, unknown>) => {
			metadata.push(next)
			return await fn()
		}}
		await instrumentFetchHandler(async() => ({status: 200, headers: {'Content-Length': '9'}}), {
			route: '/', performance
		})({headers: {'Content-Length': '4'}})
		await instrumentFetchHandler(async() => ({status: 200}), {route: '/', performance})({
			headers: {'content-length': '10garbage'}
		})
		await instrumentFetchHandler(async() => ({status: 200}), {route: '/', performance})({
			headers: {'content-length': '1000000000000000'}
		})
		expect(metadata[0]).toMatchObject({requestSize: 4, responseSize: 9})
		expect(metadata[1]).not.toHaveProperty('requestSize')
		expect(metadata[2]).not.toHaveProperty('requestSize')
	})

	it('isolates size readers and measurement-port failures without double-running handlers', async() => {
		const handler = vi.fn(async() => ({status: 200}))
		const before = instrumentFetchHandler(handler, {
			route: '/',
			getRequestSize: () => { throw new Error('size failed') },
			performance: {measureRequest: async() => { throw new Error('measurement failed') }}
		})
		await expect(before({})).resolves.toEqual({status: 200})
		expect(handler).toHaveBeenCalledOnce()

		const after = instrumentFetchHandler(handler, {
			route: '/',
			performance: {measureRequest: async(_name, fn) => {
				await fn()
				throw new Error('finalization failed')
			}}
		})
		await expect(after({})).resolves.toEqual({status: 200})
		expect(handler).toHaveBeenCalledTimes(2)
		const swallowed = instrumentFetchHandler(handler, {
			route: '/', performance: {measureRequest: async() => undefined as never}
		})
		await expect(swallowed({})).resolves.toEqual({status: 200})
		expect(handler).toHaveBeenCalledTimes(3)

		const authoritative = instrumentFetchHandler(async() => ({status: 201}), {
			route: '/',
			performance: {measureRequest: async(_name, fn) => { await fn(); return {status: 599} }}
		})
		await expect(authoritative({})).resolves.toEqual({status: 201})

		const businessFailure = new Error('request failed')
		const swallowingPort = instrumentFetchHandler(async() => { throw businessFailure }, {
			route: '/',
			performance: {measureRequest: async(_name, fn) => {
				try { await fn() } catch { return {status: 200} }
				return {status: 200}
			}}
		})
		await expect(swallowingPort({})).rejects.toBe(businessFailure)

		const duplicated = vi.fn(async() => ({status: 202}))
		const duplicatingPort = instrumentFetchHandler(duplicated, {
			route: '/',
			performance: {measureRequest: async(_name, fn) => { await fn(); return await fn() }}
		})
		await expect(duplicatingPort({})).resolves.toEqual({status: 202})
		expect(duplicated).toHaveBeenCalledOnce()

		let release!: (value: {status: number}) => void
		const detachedHandler = vi.fn(() => new Promise<{status: number}>((resolve) => { release = resolve }))
		const detached = instrumentFetchHandler(detachedHandler, {
			route: '/', performance: {measureRequest: async(_name, fn) => { void fn() }}
		})({})
		await Promise.resolve()
		let settled = false
		void detached.then(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		release({status: 206})
		await expect(detached).resolves.toEqual({status: 206})
		expect(detachedHandler).toHaveBeenCalledOnce()

		const hangingPortHandler = vi.fn(async() => ({status: 207}))
		const hangingPort = instrumentFetchHandler(hangingPortHandler, {
			route: '/',
			performance: {measureRequest: async(_name, fn) => {
				await fn()
				return await new Promise<never>(() => {})
			}}
		})
		await expect(hangingPort({})).resolves.toEqual({status: 207})
		expect(hangingPortHandler).toHaveBeenCalledOnce()

		const readThen = vi.fn(() => { throw new Error('must not assimilate') })
		const thenableHandler = vi.fn(async() => ({status: 208}))
		const hostileThenablePort = instrumentFetchHandler(thenableHandler, {
			route: '/', performance: {measureRequest: ((_name, fn) => {
				void fn()
				return Object.defineProperty({}, 'then', {get: readThen})
			}) as never}
		})
		await expect(hostileThenablePort({})).resolves.toEqual({status: 208})
		expect(thenableHandler).toHaveBeenCalledOnce()
		expect(readThen).not.toHaveBeenCalled()
	})

	it('does not inspect response metadata at the expense of handler success', async() => {
		const response = {get status(): number { throw new Error('status failed') }}
		const handler = instrumentFetchHandler(async() => response, {
			route: '/', performance: {measureRequest: async(_name, fn) => await fn()}
		})
		await expect(handler({})).resolves.toBe(response)
	})

	it('isolates hostile metadata accessors and preserves rejected handler errors', async() => {
		const failure = new Error('business failure')
		const measureRequest = vi.fn(async(_name, fn, metadata) => {
			expect(metadata).toMatchObject({method: 'GET', route: '/unsafe'})
			return await fn()
		})
		const request = {
			get method(): string { throw new Error('method failed') },
			get headers(): never { throw new Error('headers failed') }
		}
		const wrapped = instrumentFetchHandler(async() => {
			throw failure
		}, {route: '/unsafe', performance: {measureRequest}})

		await expect(wrapped(request)).rejects.toBe(failure)
		expect(measureRequest).toHaveBeenCalledOnce()
	})

	it('falls back exactly once when instrumentation options have hostile getters', async() => {
		const handler = vi.fn(async() => ({status: 200}))
		const options = {
			performance: {measureRequest: vi.fn()},
			get route(): string { throw new Error('route failed') }
		}

		await expect(instrumentFetchHandler(handler, options)({})).resolves.toEqual({status: 200})
		const methodAccessor = Object.defineProperty({}, 'measureRequest', {
			get: () => { throw new Error('measureRequest failed') }
		})
		await expect(instrumentFetchHandler(handler, {
			route: '/', performance: methodAccessor
		})({})).resolves.toEqual({status: 200})
		expect(handler).toHaveBeenCalledTimes(2)
	})

	it('does not invoke Proxy traps or metadata accessors at fetch boundaries', async() => {
		const handler = vi.fn(async() => ({status: 200}))
		const optionDescriptor = vi.fn(() => ({configurable: true, enumerable: true, value: '/'}))
		const proxyOptions = new Proxy({}, {getOwnPropertyDescriptor: optionDescriptor})
		await expect(instrumentFetchHandler(handler, proxyOptions as never)({})).resolves.toEqual({status: 200})
		expect(optionDescriptor).not.toHaveBeenCalled()

		const prototypeDescriptor = vi.fn(() => { throw new Error('must not inspect') })
		const performance = Object.create(new Proxy({}, {getOwnPropertyDescriptor: prototypeDescriptor}))
		await expect(instrumentFetchHandler(handler, {route: '/', performance})({})).resolves.toEqual({status: 200})
		expect(prototypeDescriptor).not.toHaveBeenCalled()

		const readMethod = vi.fn(() => 'POST')
		const readRequestHeaders = vi.fn(() => ({'content-length': '4'}))
		const request = Object.defineProperties({}, {
			method: {get: readMethod}, headers: {get: readRequestHeaders}
		})
		const readStatus = vi.fn(() => 503)
		const readResponseHeaders = vi.fn(() => ({'content-length': '9'}))
		const response = Object.defineProperties({}, {
			status: {get: readStatus}, headers: {get: readResponseHeaders}
		})
		const metadata: Array<Record<string, unknown>> = []
		const wrapped = instrumentFetchHandler(async() => response as never, {
			route: '/safe', performance: {measureRequest: async(_name, fn, next) => {
				metadata.push(next)
				return await fn()
			}}
		})
		await expect(wrapped(request as never)).resolves.toBe(response)
		expect(metadata[0]).toMatchObject({method: 'GET', route: '/safe'})
		expect(metadata[0]).not.toHaveProperty('statusCode')
		for (const accessor of [readMethod, readRequestHeaders, readStatus, readResponseHeaders]) {
			expect(accessor).not.toHaveBeenCalled()
		}
	})

	it('reads native Request and Response metadata through native brand-checked getters', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const wrapped = instrumentFetchHandler(async() => new Response(null, {
			status: 202, headers: {'content-length': '9'}
		}), {
			route: '/native', performance: {measureRequest: async(_name, fn, next) => {
				metadata.push(next)
				return await fn()
			}}
		})
		await wrapped(new Request('https://example.test/native', {
			method: 'POST', headers: {'content-length': '4'}
		}) as never)
		expect(metadata[0]).toMatchObject({
			method: 'POST', route: '/native', requestSize: 4, statusCode: 202, responseSize: 9
		})
	})

	it('accepts safe size callbacks and rejects invalid or hostile response metadata', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const performance = {measureRequest: async(_name: string, fn: () => Promise<FetchLikeResponse>, next: Record<string, unknown>) => {
			metadata.push(next)
			return await fn()
		}}
		const response = {
			status: 202,
			get headers(): never { throw new Error('response headers failed') }
		}
		await instrumentFetchHandler(async() => response, {
			name: 'custom.request', route: '/', performance,
			getRequestSize: () => 5,
			getResponseSize: () => -1
		})({})
		await instrumentFetchHandler(async() => ({status: 200}), {
			route: '/', performance,
			getRequestSize: () => Number.MAX_SAFE_INTEGER + 1,
			getResponseSize: () => 7
		})({})

		expect(metadata[0]).toMatchObject({requestSize: 5, statusCode: 202})
		expect(metadata[0]).not.toHaveProperty('responseSize')
		expect(metadata[1]).toMatchObject({responseSize: 7})
		expect(metadata[1]).not.toHaveProperty('requestSize')
	})

	it('observes rejected promises returned by sync-typed size readers', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('size failed')))
		try {
			const handler = instrumentFetchHandler(async() => ({status: 200}), {
				route: '/',
				performance: {measureRequest: async(_name, fn) => await fn()},
				getRequestSize: (() => rejected) as never
			})
			await expect(handler({})).resolves.toEqual({status: 200})
			expect(speciesReads).toBeGreaterThan(0)
		} finally {
			await rejected.catch(() => undefined)
		}
	})
})
