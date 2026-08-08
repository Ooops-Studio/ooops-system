import type {IncomingMessage, ServerResponse} from 'node:http'

import {beforeEach, describe, expect, it, vi} from 'vitest'

const runtime = vi.hoisted(() => ({
	errorHandler: undefined as ((error: Error) => void) | undefined,
	server: {
		listening: false,
		on: vi.fn(),
		listen: vi.fn(),
		close: vi.fn(),
		closeAllConnections: vi.fn(),
		removeAllListeners: vi.fn()
	}
}))

vi.mock('node:http', () => ({
	createServer: vi.fn(() => runtime.server)
}))

import {PROMETHEUS_HARD_MAX_BUFFER_SIZE} from '../../../src/constants'
import {PrometheusHttpServer} from '../../../src/http/prometheus-http-server'

const logger = {
	level: 'warn' as const,
	trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), context: vi.fn()
}

function createServer(onError = vi.fn()): PrometheusHttpServer {
	return new PrometheusHttpServer({
		host: '127.0.0.1', port: 0, logger, onError,
		getScrape: () => ({body: '', contentType: 'text/plain'})
	})
}

describe('PrometheusHttpServer failures', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		runtime.server.listening = false
		runtime.errorHandler = undefined
		runtime.server.on.mockImplementation((event: string, handler: (error: Error) => void) => {
			if (event === 'error') runtime.errorHandler = handler
			return runtime.server
		})
	})

	it('cleans up a synchronous listen failure', async() => {
		const onError = vi.fn()
		runtime.server.listen.mockImplementationOnce(() => { throw 'invalid listen options' })
		const server = createServer(onError)
		await expect(server.start()).rejects.toThrow('Prometheus HTTP server failed')
		expect(server.currentServer).toBeUndefined()
		expect(runtime.server.removeAllListeners).toHaveBeenCalled()
		expect(onError).toHaveBeenCalled()
	})

	it('rejects malformed direct options and isolates throwing startup observers', async() => {
		expect(() => new PrometheusHttpServer(null as never)).toThrow('options must be an object')
		expect(() => new PrometheusHttpServer({host: '127.0.0.1'} as never)).toThrow('options are invalid')
		expect(() => new PrometheusHttpServer({
			host: ' ', port: 0, logger, onError: vi.fn(), getScrape: () => ({body: '', contentType: 'text/plain'})
		})).toThrow('options are invalid')
		expect(() => new PrometheusHttpServer({
			host: '127.0.0.1', port: 65_536, logger, onError: vi.fn(), getScrape: () => ({body: '', contentType: 'text/plain'})
		})).toThrow('options are invalid')
		const hostGetter = vi.fn(() => '127.0.0.1')
		const accessorOptions = {
			get host() { return hostGetter() }, port: 0, logger, onError: vi.fn(),
			getScrape: () => ({body: '', contentType: 'text/plain'})
		}
		expect(() => new PrometheusHttpServer(accessorOptions)).toThrow('options are invalid')
		expect(hostGetter).not.toHaveBeenCalled()
		const infoGetter = vi.fn(() => vi.fn())
		const accessorLogger = Object.defineProperty({...logger}, 'info', {get: infoGetter})
		expect(() => new PrometheusHttpServer({
			host: '127.0.0.1', port: 0, logger: accessorLogger,
			onError: vi.fn(), getScrape: () => ({body: '', contentType: 'text/plain'})
		})).toThrow('options are invalid')
		expect(infoGetter).not.toHaveBeenCalled()
		runtime.server.listen.mockImplementationOnce(() => runtime.server)
		const server = createServer(() => { throw new Error('observer failed') })
		const start = server.start()
		runtime.errorHandler?.(new Error('listen failed'))
		await expect(start).rejects.toThrow('listen failed')
	})

	it('projects raw listen failures before notifying diagnostics', async() => {
		const onError = vi.fn()
		runtime.server.listen.mockImplementationOnce(() => runtime.server)
		const server = createServer(onError)
		const start = server.start()
		runtime.errorHandler?.(new Error('listen failed with secret-token'))
		await expect(start).rejects.toThrow('listen failed with secret-token')
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({message: 'metrics_prometheus_http_server_failed'}),
			{operation: 'http-server', exporter: 'prometheus'}
		)
		expect(JSON.stringify(onError.mock.calls)).not.toContain('secret-token')
	})

	it('reports asynchronous startup errors and lets stop await the failed start', async() => {
		runtime.server.listen.mockImplementationOnce(() => runtime.server)
		const server = createServer()
		const start = server.start()
		const stop = server.stop()
		runtime.errorHandler?.(new Error('listen failed'))
		await expect(start).rejects.toThrow('listen failed')
		await expect(stop).resolves.toBeUndefined()
		expect(server.isHealthy).toBe(false)
	})

	it('coalesces stop calls that both begin while startup is pending', async() => {
		let listeningCallback: (() => void) | undefined
		runtime.server.listen.mockImplementationOnce((_port, _host, callback) => {
			listeningCallback = callback
			return runtime.server
		})
		runtime.server.close.mockImplementationOnce((callback: (error?: Error) => void) => {
			runtime.server.listening = false
			callback()
			return runtime.server
		})
		const server = createServer()
		const start = server.start()
		const firstStop = server.stop()
		const secondStop = server.stop()
		runtime.server.listening = true
		listeningCallback?.()

		await Promise.all([start, firstStop, secondStop])
		expect(runtime.server.close).toHaveBeenCalledOnce()
		expect(server.currentServer).toBeUndefined()
	})

	it('retains a still-listening server so stop can be retried after close failure', async() => {
		const server = createServer()
		const injected = {
			listening: true,
			close: vi.fn()
				.mockImplementationOnce((callback: (error?: Error) => void) => callback(new Error('close failed')))
				.mockImplementationOnce((callback: (error?: Error) => void) => {
					injected.listening = false
					callback()
				}),
			closeAllConnections: vi.fn(),
			removeAllListeners: vi.fn()
		}
		server.currentServer = injected as never
		await expect(server.stop()).rejects.toThrow('close failed')
		expect(server.currentServer).toBe(injected)
		await expect(server.stop()).resolves.toBeUndefined()
		expect(server.currentServer).toBeUndefined()
		expect(injected.removeAllListeners).toHaveBeenCalled()
	})

	it('returns 400 when request URL construction fails', () => {
		const server = createServer()
		const response = {writeHead: vi.fn(), end: vi.fn()}
		const request = {
			method: 'GET', url: '/metrics',
			headers: {get host() { throw new Error('bad host') }}
		}
		const internal = server as unknown as {
			handleRequest(req: IncomingMessage, res: ServerResponse): void
		}
		internal.handleRequest(request as unknown as IncomingMessage, response as unknown as ServerResponse)
		expect(response.writeHead).toHaveBeenCalledWith(400, {'Content-Type': 'text/plain'})
	})

	it('rejects oversized scrape bodies before scanning their UTF-8 bytes', () => {
		const oversized = 'x'.repeat(PROMETHEUS_HARD_MAX_BUFFER_SIZE + 1)
		const server = new PrometheusHttpServer({
			host: '127.0.0.1', port: 0, logger, onError: vi.fn(),
			getScrape: () => ({body: oversized, contentType: 'text/plain'})
		})
		const response = {writeHead: vi.fn(), end: vi.fn()}
		const byteLength = vi.spyOn(Buffer, 'byteLength')
		try {
			const internal = server as unknown as {
				handleRequest(req: IncomingMessage, res: ServerResponse): void
			}
			internal.handleRequest({
				method: 'GET', url: '/metrics', headers: {host: 'localhost'}
			} as IncomingMessage, response as unknown as ServerResponse)
			expect(byteLength).not.toHaveBeenCalled()
			expect(response.writeHead).toHaveBeenCalledWith(500, {'Content-Type': 'text/plain'})
		} finally {
			byteLength.mockRestore()
		}
	})
})
