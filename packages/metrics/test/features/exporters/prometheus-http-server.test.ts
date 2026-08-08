import {createConnection} from 'node:net'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {PrometheusHttpServer} from '../../../src/http/prometheus-http-server'
import {createPrometheusSink} from '../../../src/sinks/prometheus'
import {createPrometheusHttpServer} from '../../../src/sinks/prometheus-http'

const logger = {level: 'warn' as const, trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), context: vi.fn()}

describe('PrometheusHttpServer', () => {
	const servers: PrometheusHttpServer[] = []
	afterEach(async() => { await Promise.all(servers.map((server) => server.stop())) })

	it('adapts an app-mounted Prometheus sink only when explicitly requested', async() => {
		const sink = createPrometheusSink({provider: 'prometheus'})
		await sink.export([{name: 'adapter_metric', type: 'counter', value: 1, labels: {}, timestamp: 1}])
		const server = createPrometheusHttpServer(sink, {host: '127.0.0.1', port: 0, logger})
		servers.push(server)
		await server.start()
		const address = server.currentServer?.address() as {port: number}
		expect(await (await fetch(`http://127.0.0.1:${address.port}/metrics`)).text()).toContain('adapter_metric')
	})

	it('validates explicit listener configuration', () => {
		const sink = createPrometheusSink({provider: 'prometheus'})
		expect(() => createPrometheusHttpServer(null as never)).toThrow('requires a scrape source')
		expect(() => createPrometheusHttpServer(sink, null as never)).toThrow('options must be an object')
		expect(() => createPrometheusHttpServer(sink, {onError: true as never})).toThrow('onError must be a function')
		const hostGetter = vi.fn(() => '127.0.0.1')
		const accessorOptions = Object.defineProperty({}, 'host', {enumerable: true, get: hostGetter})
		expect(() => createPrometheusHttpServer(sink, accessorOptions as never)).toThrow('stable known data fields')
		expect(hostGetter).not.toHaveBeenCalled()
		expect(() => createPrometheusHttpServer(sink, {host: '0.0.0.0'})).toThrow()
		expect(() => createPrometheusHttpServer(sink, {host: '127.attacker.example'}))
			.toThrow('requires a loopback host')
		expect(() => createPrometheusHttpServer(sink, {host: '127.42.0.1'})).not.toThrow()
		expect(() => createPrometheusHttpServer(sink, {port: 65_536})).toThrow('port')
		const defaultAdapter = createPrometheusHttpServer(sink)
		const internal = defaultAdapter as unknown as {
			options: {onError: (error: unknown, context: Record<string, string>) => void}
		}
		expect(() => internal.options.onError(new Error('ignored'), {})).not.toThrow()
	})

	it('snapshots the scrape capability without invoking accessors', async() => {
		const accessor = vi.fn(() => () => ({body: 'leaked 1\n', contentType: 'text/plain'}))
		const accessorSource = Object.defineProperty({}, 'getPrometheusScrape', {get: accessor})
		expect(() => createPrometheusHttpServer(accessorSource as never)).toThrow('requires a scrape source')
		expect(accessor).not.toHaveBeenCalled()

		const source = {
			getPrometheusScrape: () => ({body: 'original_metric 1\n', contentType: 'text/plain'})
		}
		const server = createPrometheusHttpServer(source, {host: '127.0.0.1', port: 0, logger})
		servers.push(server)
		source.getPrometheusScrape = () => ({body: 'mutated_metric 1\n', contentType: 'text/plain'})
		await server.start()
		const address = server.currentServer?.address() as {port: number}
		const body = await (await fetch(`http://127.0.0.1:${address.port}/metrics`)).text()
		expect(body).toContain('original_metric')
		expect(body).not.toContain('mutated_metric')
	})

	it('bounds hostile scrape-source prototype traversal', () => {
		let prototypeReads = 0
		let hostile: object
		hostile = new Proxy({}, {
			getPrototypeOf: () => {
				prototypeReads += 1
				if (prototypeReads > 40) throw new Error('unbounded prototype traversal')
				return hostile
			}
		})

		expect(() => createPrometheusHttpServer(hostile as never)).toThrow('requires a scrape source')
		expect(prototypeReads).toBeLessThanOrEqual(1)
	})

	it('serves formats and returns request/render failures safely', async() => {
		const getScrape = vi.fn((format?: string) => format === 'openmetrics'
			? {body: '# EOF\n', contentType: 'application/openmetrics-text'}
			: {body: 'metric 1\n', contentType: 'text/plain'})
		const server = new PrometheusHttpServer({host: '127.0.0.1', port: 0, logger, onError: vi.fn(), getScrape})
		servers.push(server)
		await server.start()
		const address = server.currentServer?.address() as {port: number}
		const base = `http://127.0.0.1:${address.port}`
		expect((await fetch(`${base}/metrics?format=openmetrics`)).headers.get('content-type')).toContain('application/openmetrics-text')
		expect(await (await fetch(`${base}/metrics`, {headers: {accept: 'text/plain'}})).text()).toContain('metric 1')
		expect((await fetch(`${base}/other`)).status).toBe(404)
		expect((await fetch(`${base}/metrics`, {method: 'POST'})).status).toBe(404)
		getScrape.mockImplementationOnce(() => { throw new Error('render failed') })
		expect((await fetch(`${base}/metrics`)).status).toBe(500)
		getScrape.mockImplementationOnce(() => ({body: 'metric 1\n', contentType: 'text/plain\r\nX-Injected: true'}))
		expect((await fetch(`${base}/metrics`)).status).toBe(500)
		await server.stop()
		expect(server.isHealthy).toBe(false)
	})

	it('stops a non-listening injected server without calling close', async() => {
		const fake = {listening: false, removeAllListeners: vi.fn()} as unknown
		const server = new PrometheusHttpServer({host: '127.0.0.1', port: 0, logger, onError: vi.fn(), getScrape: () => ({body: '', contentType: 'text/plain'})})
		server.currentServer = fake
		await server.stop()
		expect(fake.removeAllListeners).toHaveBeenCalled()
		expect(server.currentServer).toBeUndefined()
	})

	it('coalesces concurrent start and stop calls', async() => {
		const server = new PrometheusHttpServer({host: '127.0.0.1', port: 0, logger, onError: vi.fn(), getScrape: () => ({body: '', contentType: 'text/plain'})})
		servers.push(server)
		const firstStart = server.start()
		const secondStart = server.start()
		await Promise.all([firstStart, secondStart])
		const listeningServer = server.currentServer

		await Promise.all([server.stop(), server.stop()])
		expect(listeningServer?.listening).toBe(false)
		expect(server.currentServer).toBeUndefined()
	})

	it('does not let an unfinished request block shutdown', async() => {
		const server = new PrometheusHttpServer({host: '127.0.0.1', port: 0, logger, onError: vi.fn(), getScrape: () => ({body: '', contentType: 'text/plain'})})
		servers.push(server)
		await server.start()
		const address = server.currentServer?.address() as {port: number}
		const socket = createConnection({host: '127.0.0.1', port: address.port})
		socket.on('error', () => undefined)
		await new Promise<void>((resolve) => socket.once('connect', resolve))
		socket.write('GET /metrics HTTP/1.1\r\nHost: localhost')

		const stopping = server.stop()
		const outcome = await Promise.race([
			stopping.then(() => 'stopped' as const),
			new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 250))
		])
		socket.destroy()
		await stopping

		expect(outcome).toBe('stopped')
	})

	it('restarts after a concurrent stop instead of losing the start request', async() => {
		const server = new PrometheusHttpServer({host: '127.0.0.1', port: 0, logger, onError: vi.fn(), getScrape: () => ({body: '', contentType: 'text/plain'})})
		servers.push(server)
		await server.start()

		const stopping = server.stop()
		const restarting = server.start()
		await Promise.all([stopping, restarting])

		expect(server.isRunning()).toBe(true)
	})
})
