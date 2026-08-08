import {describe, expect, it, vi} from 'vitest'

import {
	instrumentHandleFetch,
	instrumentRequestHandler
} from '../src/server'

describe('svelte kit server helpers', () => {
	it('executes HTTP application handlers exactly once with broken tracing ports', async() => {
		const span = {setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn()}
		const requestWork = vi.fn(async() => new Response('ok'))
		const fetchWork = vi.fn(async() => new Response('ok'))
		const tracing = {
			inSpan: async(_name: string, operation: (activeSpan: typeof span) => Promise<Response>) => {
				await operation(span)
				return await operation(span)
			}
		} as never

		await instrumentRequestHandler(requestWork, {tracing})({
			request: new Request('https://example.com/projects/1'),
			route: {id: '/projects/[id]'}, url: new URL('https://example.com/projects/1')
		})
		await instrumentHandleFetch(fetchWork, {tracing})({
			request: new Request('https://api.example.com/projects/1'),
			fetch: vi.fn(async() => new Response())
		})

		expect(requestWork).toHaveBeenCalledOnce()
		expect(fetchWork).toHaveBeenCalledOnce()
	})

	it('preserves successful responses and original failures when span methods throw', async() => {
		const span = {
			setAttribute: () => { throw new Error('attribute failed') },
			recordException: () => { throw new Error('record failed') },
			setStatus: () => { throw new Error('status failed') }
		}
		const tracing = {
			inSpan: async(_name: string, operation: (activeSpan: typeof span) => Promise<Response>) =>
				await operation(span)
		} as never
		const success = instrumentRequestHandler(async() => new Response('ok', {status: 200}), {tracing})
		const applicationFailure = new Error('application failed')
		const failure = instrumentHandleFetch(async() => { throw applicationFailure }, {tracing})

		await expect(success({
			request: new Request('https://example.com/health'), route: {id: '/health'},
			url: new URL('https://example.com/health')
		})).resolves.toMatchObject({status: 200})
		await expect(failure({
			request: new Request('https://api.example.com/fail'), fetch: vi.fn(async() => new Response())
		})).rejects.toBe(applicationFailure)
	})

	it('does not let oversized request URLs suppress outbound application work', async() => {
		const work = vi.fn(async() => new Response('ok'))
		const wrapped = instrumentHandleFetch(work)
		const request = {method: 'GET', url: `https://example.com/${'x'.repeat(3_000)}`}

		await expect(wrapped({
			request: request as never,
			fetch: vi.fn(async() => new Response())
		})).resolves.toMatchObject({status: 200})
		expect(work).toHaveBeenCalledOnce()
	})

	it('does not enumerate handleFetch input before invoking application work', async() => {
		const input = {
			request: new Request('https://api.example.com/health'),
			fetch: vi.fn(async() => new Response())
		}
		Object.defineProperty(input, 'unused', {
			enumerable: true,
			get: () => { throw new Error('must not enumerate framework input') }
		})
		const work = vi.fn(async(received: typeof input) => {
			expect(received).toBe(input)
			return new Response('ok')
		})

		await expect(instrumentHandleFetch(work)(input)).resolves.toMatchObject({status: 200})
		expect(work).toHaveBeenCalledOnce()
	})

	it('protects canonical request and fetch labels from custom overrides', async() => {
		const labels: Record<string, string>[] = []
		const performance = {
			measureRequest: async(_name: string, fn: () => Promise<Response>, _metadata: unknown, current: Record<string, string>) => {
				labels.push(current)
				return await fn()
			}
		}
		const custom = {route: '/raw/123?token=secret', runtime: 'browser', kind: 'hijacked'}
		const request = instrumentRequestHandler(async() => new Response('ok'), {performance, labels: custom})
		const fetch = instrumentHandleFetch(async() => new Response('ok'), {performance, labels: custom})

		await request({
			request: new Request('https://example.com/projects/1'),
			route: {id: '/projects/[id]'}, url: new URL('https://example.com/projects/1')
		})
		await fetch({
			request: new Request('https://api.example.com/users/1'),
			fetch: vi.fn(async() => new Response())
		})

		expect(labels).toEqual([
			expect.objectContaining({route: '/projects/:id', runtime: 'server', kind: 'request'}),
			expect.objectContaining({route: '/users/:id', runtime: 'server', kind: 'fetch'})
		])
		expect(JSON.stringify(labels)).not.toContain('token=secret')
	})

	it('instruments request handlers with normalized SvelteKit routes', async() => {
		const calls: Array<[string, unknown]> = []
		const span = {
			setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn()
		}
		const inSpan = vi.fn(async(_name, operation, spanOptions) => await operation(span, spanOptions))
		const wrapped = instrumentRequestHandler(
			async() => new Response('ok', {status: 201}),
			{
				performance: {
					measureRequest: async(name, fn, metadata) => {
						calls.push([name, metadata])
						return await fn()
					}
				},
				tracing: {inSpan} as never
			}
		)

		const response = await wrapped({
			request: new Request('https://example.com/projects/123', {method: 'POST'}),
			route: {id: '/projects/[id]'},
			url: new URL('https://example.com/projects/123')
		})

		expect(response.status).toBe(201)
		expect(calls[0]).toEqual([
			'http.request',
			expect.objectContaining({
				method: 'POST',
				route: '/projects/:id',
				hostKind: 'sveltekit',
				runtime: 'server',
				statusCode: 201
			})
		])
		expect(inSpan).toHaveBeenCalledWith(
			'http.request', expect.any(Function),
			expect.objectContaining({kind: 'server', attributes: expect.objectContaining({
				'http.request.method': 'POST', 'http.route': '/projects/:id'
			})})
		)
		expect(span.setAttribute).toHaveBeenCalledWith('http.response.status_code', 201)
		expect(span.setStatus).toHaveBeenCalledWith({code: 'ok'})
	})

	it('instruments handleFetch with normalized outbound routes', async() => {
		const calls: Array<[string, unknown]> = []
		const span = {
			setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn()
		}
		const inSpan = vi.fn(async(_name, operation, spanOptions) => await operation(span, spanOptions))
		const wrapped = instrumentHandleFetch(
			async({request, fetch}) => await fetch(request),
			{
				performance: {
					measureRequest: async(name, fn, metadata) => {
						calls.push([name, metadata])
						return await fn()
					}
				},
				tracing: {inSpan} as never
			}
		)

		const response = await wrapped({
			request: new Request('https://api.example.com/users/123', {method: 'GET'}),
			fetch: vi.fn(async() => new Response('unavailable', {status: 503}))
		})

		expect(response.status).toBe(503)
		expect(calls[0]).toEqual([
			'http.client',
			expect.objectContaining({
				method: 'GET',
				route: '/users/:id',
				hostKind: 'sveltekit',
				runtime: 'server',
				statusCode: 503
			})
		])
		expect(inSpan).toHaveBeenCalledWith(
			'http.client', expect.any(Function),
			expect.objectContaining({kind: 'client', attributes: expect.objectContaining({
				'http.request.method': 'GET', 'http.route': '/users/:id'
			})})
		)
		expect(span.setAttribute).toHaveBeenCalledWith('http.response.status_code', 503)
		expect(span.setStatus).toHaveBeenCalledWith({code: 'error', description: 'HTTP 503'})
	})

	it('records exceptions and preserves thrown HTTP handler errors', async() => {
		const spans = [
			{setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn()},
			{setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn()}
		]
		let index = 0
		const tracing = {
			inSpan: async(_name: string, operation: (span: typeof spans[number]) => Promise<Response>) =>
				await operation(spans[index++]!)
		} as never
		const requestHandler = instrumentRequestHandler(async() => { throw new Error('route failed') }, {tracing})
		const handleFetch = instrumentHandleFetch(async() => { throw new Error('fetch failed') }, {tracing})

		await expect(requestHandler({
			request: new Request('https://example.com/fail'), route: {id: '/fail'},
			url: new URL('https://example.com/fail')
		})).rejects.toThrow('route failed')
		await expect(handleFetch({
			request: new Request('https://api.example.com/fail'),
			fetch: vi.fn(async() => new Response())
		})).rejects.toThrow('fetch failed')

		for (const span of spans) {
			expect(span.recordException).toHaveBeenCalledOnce()
			expect(span.setStatus).toHaveBeenCalledWith(expect.objectContaining({code: 'error'}))
		}
	})
})
