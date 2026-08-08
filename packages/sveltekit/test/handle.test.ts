import {describe, expect, it, vi} from 'vitest'

import {instrumentHandle, instrumentHandleError} from '../src/server'

interface ThrowingHandleEvent {
	request: {
		method?: string
		url?: string
	}
	route?: {
		id?: string | null
	}
	url: {
		pathname: string
	}
}

interface ThrowingHandleInput {
	event: ThrowingHandleEvent
	resolve(event: ThrowingHandleEvent): Promise<Response>
}

describe('svelte handle helpers', () => {
	it('executes handle exactly once and ignores broken optional route/tracing integrations', async() => {
		const span = {
			setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn()
		}
		const handler = vi.fn(async() => new Response('ok', {status: 202}))
		const handle = instrumentHandle(handler, {
			getRoute: () => { throw new Error('route failed') },
			tracing: {
				inSpan: async(_name: string, operation: (activeSpan: typeof span) => Promise<Response>) => {
					await operation(span as never)
					return await operation(span as never)
				}
			} as never
		})

		await expect(handle({
			event: {request: {method: 'GET'}, route: {id: '/health'}, url: {pathname: '/health'}},
			resolve: async() => new Response()
		})).resolves.toMatchObject({status: 202})
		expect(handler).toHaveBeenCalledOnce()
	})
	it('keeps request handling independent from a hanging measurement port', async() => {
		const handler = vi.fn(async() => new Response('ok', {status: 202}))
		const handle = instrumentHandle(handler, {
			performance: {measureRequest: (() => new Promise(() => undefined)) as never}
		})

		const response = await handle({
			event: {
				request: {method: 'GET'},
				route: {id: '/health'},
				url: {pathname: '/health'}
			},
			resolve: async() => new Response()
		})
		expect(response.status).toBe(202)
		expect(handler).toHaveBeenCalledOnce()
	})

	it('isolates optional performance metadata readers from successful requests', async() => {
		const measureRequest = vi.fn(async(_name, fn, _metadata, labels) => {
			expect(labels).toMatchObject({kind: 'handle', route: '/health'})
			return await fn()
		})
		const handle = instrumentHandle(async() => new Response('ok', {status: 200}), {
			performance: {measureRequest},
			getRequestSize: () => { throw new Error('request size failed') },
			getResponseSize: () => { throw new Error('response size failed') }
		})

		await expect(handle({
			event: {
				request: {method: 'GET'},
				route: {id: '/health'},
				url: {pathname: '/health'}
			},
			resolve: async() => new Response()
		})).resolves.toMatchObject({status: 200})
		expect(measureRequest).toHaveBeenCalledOnce()
	})

	it('does not let hostile response status metadata replace a successful handle result', async() => {
		const response = Object.defineProperty({}, 'status', {
			get: () => { throw new Error('status failed') }
		})
		const span = {setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn()}
		const wrapped = instrumentHandle(async() => response as never, {
			tracing: {inSpan: async(_name: string, operation: (activeSpan: typeof span) => Promise<unknown>) =>
				await operation(span)} as never
		})

		await expect(wrapped({
			event: {request: {method: 'GET'}, route: {id: '/health'}, url: {pathname: '/health'}},
			resolve: async() => new Response()
		})).resolves.toBe(response)
	})

	it('ignores throwing route metadata accessors before invoking handle work', async() => {
		const handler = vi.fn(async() => new Response('ok'))
		const event = {
			request: {method: 'GET'},
			url: {pathname: '/fallback'}
		}
		Object.defineProperties(event, {
			route: {get: () => { throw new Error('route failed') }},
			url: {get: () => { throw new Error('url failed') }}
		})

		await expect(instrumentHandle(handler)({
			event: event as never,
			resolve: async() => new Response()
		})).resolves.toMatchObject({status: 200})
		expect(handler).toHaveBeenCalledOnce()
	})

	it('keeps handleError callbacks independent from hostile reporting input', async() => {
		const handler = vi.fn(async() => ({handled: true}))
		const input = {
			event: {url: {pathname: '/failure'}}
		} as Record<string, unknown>
		Object.defineProperty(input, 'error', {
			get: () => { throw new Error('error metadata failed') }
		})

		await expect(instrumentHandleError(handler)(input as never)).resolves.toEqual({handled: true})
		expect(handler).toHaveBeenCalledOnce()
	})

	it('instruments top-level handle with tracing and performance', async() => {
		const measureRequest = vi.fn(async(_name, fn, metadata, labels) => {
			expect(metadata).toMatchObject({
				method: 'POST',
				route: '/projects/:id',
				hostKind: 'sveltekit',
				runtime: 'server'
			})
			expect(labels).toMatchObject({
				kind: 'handle',
				route: '/projects/:id'
			})
			return await fn()
		})
		const span = {
			getContext: () => ({traceId: 'trace-123'}),
			setAttribute: vi.fn(),
			addEvent: vi.fn(),
			recordException: vi.fn(),
			setStatus: vi.fn(),
			end: vi.fn()
		}
		const inSpan = vi.fn(async(_name, fn) => await fn(span))

		const handle = instrumentHandle(
			async({event, resolve}) => await resolve(event),
			{
				performance: {measureRequest},
				tracing: {
					inSpan,
					currentTraceId: () => 'trace-123'
				} as never
			}
		)

		const response = await handle({
			event: {
				request: {method: 'POST', url: 'https://example.com/projects/123'},
				route: {id: '/projects/[id]'},
				url: {pathname: '/projects/123'}
			},
			resolve: async() => new Response('ok', {status: 201})
		})

		expect(response.status).toBe(201)
		expect(inSpan).toHaveBeenCalledTimes(1)
		expect(measureRequest).toHaveBeenCalledTimes(1)
		expect(span.setAttribute).toHaveBeenCalledWith('http.request.method', 'POST')
		expect(span.setAttribute).toHaveBeenCalledWith('http.response.status_code', 201)
		expect(span.setStatus).toHaveBeenCalledWith({code: 'ok'})
	})

	it('marks returned 5xx responses as tracing errors', async() => {
		const span = {
			getContext: () => ({traceId: 'trace-503'}),
			setAttribute: vi.fn(), addEvent: vi.fn(), recordException: vi.fn(), setStatus: vi.fn(), end: vi.fn()
		}
		const handle = instrumentHandle(async() => new Response('unavailable', {status: 503}), {
			tracing: {inSpan: async(_name: string, fn: (activeSpan: typeof span) => Promise<Response>) => await fn(span)} as never
		})

		await expect(handle({
			event: {request: {method: 'GET'}, route: {id: '/health'}, url: {pathname: '/health'}},
			resolve: async() => new Response()
		})).resolves.toMatchObject({status: 503})
		expect(span.setAttribute).toHaveBeenCalledWith('http.response.status_code', 503)
		expect(span.setStatus).toHaveBeenCalledWith({code: 'error', description: 'HTTP 503'})
	})

	it('reports handleError through errors and logger while preserving tracing correlation', async() => {
		const report = vi.fn()
		const recordException = vi.fn()
		const errorLog = vi.fn()
		const wrapped = instrumentHandleError(
			async() => ({message: 'handled'}),
			{
				errors: {report},
				tracing: {
					recordException,
					currentTraceId: () => 'trace-err'
				} as never,
				logger: {error: errorLog} as never
			}
		)

		const result = await wrapped({
			error: new Error('boom'),
			event: {
				route: {id: '/projects/[id]'},
				url: {pathname: '/projects/123'}
			},
			status: 500
		})

		expect(result).toEqual({message: 'handled'})
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'Error',
				message: 'boom'
			}),
			expect.objectContaining({
				hook: 'handleError',
				route: '/projects/:id',
				traceId: 'trace-err',
				statusCode: 500
			})
		)
		expect(recordException).not.toHaveBeenCalled()
		expect(errorLog).toHaveBeenCalledWith(
			'sveltekit.handle_error',
			expect.objectContaining({
				source: 'sveltekit.handleError'
			})
		)
	})

	it('supports tracing-only and performance-only instrumentation', async() => {
		const tracingOnly = instrumentHandle(
			async({event, resolve}) => await resolve(event),
			{
				tracing: {
					inSpan: async(
						_name: string,
						fn: (span: unknown) => Promise<Response>
					) => await fn({
						getContext: () => ({traceId: 'trace-only'}),
						setAttribute: vi.fn(),
						addEvent: vi.fn(),
						recordException: vi.fn(),
						setStatus: vi.fn(),
						end: vi.fn()
					} as never)
				} as never
			}
		)
		await expect(tracingOnly({
			event: {
				request: {method: 'GET', url: 'https://example.com/projects/1'},
				route: {id: '/projects/[id]'},
				url: {pathname: '/projects/1'}
			},
			resolve: async() => new Response('ok', {status: 200})
		})).resolves.toBeInstanceOf(Response)

		const performanceCalls: Array<string> = []
		const performanceOnly = instrumentHandle(
			async({event, resolve}) => await resolve(event),
			{
				performance: {
					measureRequest: async<T>(name: string, fn: () => Promise<T>) => {
						performanceCalls.push(name)
						return await fn()
					}
				}
			}
		)
		await performanceOnly({
			event: {
				request: {method: 'GET', url: 'https://example.com/projects/2'},
				route: {id: '/projects/[id]'},
				url: {pathname: '/projects/2'}
			},
			resolve: async() => new Response('ok', {status: 200})
		})
		expect(performanceCalls).toEqual(['http.request'])

		const throwingHandle = instrumentHandle<ThrowingHandleInput, ThrowingHandleEvent, Response>(
			async({event, resolve}) => {
				void event
				void resolve
				throw new Error('boom')
			}
		)
		await expect(throwingHandle({
			event: {
				request: {method: 'GET', url: 'https://example.com/projects/3'},
				route: {id: '/projects/[id]'},
				url: {pathname: '/projects/3'}
			},
			resolve: async() => new Response('never', {status: 200})
		})).rejects.toThrow('boom')

		const noPorts = instrumentHandle(
			async({event, resolve}) => await resolve(event)
		)
		await expect(noPorts({
			event: {
				request: {method: 'GET', url: 'https://example.com/projects/4'},
				route: {id: '/projects/[id]'},
				url: {pathname: '/projects/4'}
			},
			resolve: async() => new Response('ok', {status: 200})
		})).resolves.toBeInstanceOf(Response)
	})

	it('captures request metadata and tracing errors with custom server options', async() => {
		const span = {
			getContext: () => ({traceId: 'custom-trace'}),
			setAttribute: vi.fn(),
			addEvent: vi.fn(),
			recordException: vi.fn(),
			setStatus: vi.fn(),
			end: vi.fn()
		}
		const handle = instrumentHandle<ThrowingHandleInput, ThrowingHandleEvent, Response>(
			async() => {
				throw new Error('request failed')
			},
			{
				hostKind: 'edge',
				runtime: 'worker',
				getRoute: () => '/custom/[id]',
				getRequestSize: () => 12,
				getResponseSize: () => 34,
				tracing: {
					inSpan: async(
						_name: string,
						fn: (activeSpan: unknown) => Promise<Response>
					) => await fn(span)
				} as never
			}
		)

		await expect(handle({
			event: {request: {}, url: {pathname: '/ignored'}},
			resolve: async() => new Response()
		})).rejects.toThrow('request failed')

		expect(span.recordException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({errorMessage: 'request failed'})
		)
		expect(span.setStatus).toHaveBeenCalledWith(
			expect.objectContaining({code: 'error'})
		)
	})

	it('keeps handleError best-effort and supports custom error sources without a handler', async() => {
		const logger = vi.fn(() => {
			throw new Error('reporter failed')
		})
		const wrapped = instrumentHandleError(undefined, {
			getRoute: () => '/custom/[id]',
			getSource: () => 'custom.source',
			logger: {error: logger} as never
		})

		await expect(wrapped({
			error: 'bad input',
			event: {url: {pathname: '/ignored'}},
			source: 'input.source',
			message: 'Not found'
		})).resolves.toBeUndefined()

		expect(logger).toHaveBeenCalledWith(
			'sveltekit.handle_error',
			expect.objectContaining({route: '/custom/:id', source: 'custom.source', statusMessage: 'Not found'})
		)
	})
})
