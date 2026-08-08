import * as http from 'node:http'

import type {Logging} from '@ooopsstudio/core/ports/logging'

import {PROMETHEUS_HARD_MAX_BUFFER_SIZE} from '../constants'
import type {PrometheusScrape} from '../sinks/prometheus'
import {getLogger, isSafeLogger} from '../utils/logger'

interface NodeHttpServer {
	readonly listening: boolean
	address(): string | {readonly port: number} | null
	listen(port: number, host: string, callback: () => void): unknown
	close(callback: (error?: Error) => void): unknown
	closeAllConnections(): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
	removeAllListeners(): unknown
}

interface HttpRequest {
	readonly method?: string
	readonly url?: string
	readonly headers: {
		readonly host?: string
		readonly accept?: string
	}
}

interface HttpResponse {
	writeHead(statusCode: number, headers: Record<string, string | number>): unknown
	end(body?: string): unknown
}

export interface PrometheusHttpServerOptions {
	readonly host: string
	readonly port: number
	readonly logger: Logging
	readonly onError: (error: unknown, context: Record<string, string>) => void
	readonly getScrape: (format?: 'openmetrics' | 'prometheus') => PrometheusScrape
}

export class PrometheusHttpServer {
	private readonly options: PrometheusHttpServerOptions
	private server: NodeHttpServer | undefined
	private healthy = true
	private startPromise: Promise<void> | undefined
	private stopPromise: Promise<void> | undefined

	constructor(options: PrometheusHttpServerOptions) {
		if (!options || typeof options !== 'object') throw new Error('Prometheus HTTP server options must be an object')
		const descriptors = Object.getOwnPropertyDescriptors(options)
		const value = (key: keyof PrometheusHttpServerOptions): unknown => {
			const descriptor = descriptors[key]
			return descriptor && 'value' in descriptor ? descriptor.value : undefined
		}
		const host = value('host')
		const port = value('port')
		const logger = value('logger') as Logging | undefined
		const stableLogger = isSafeLogger(logger) ? getLogger(logger) : undefined
		const onError = value('onError')
		const getScrape = value('getScrape')
		if (typeof host !== 'string' || host.length > 255 || host.trim().length === 0
			|| !Number.isInteger(port) || (port as number) < 0 || (port as number) > 65_535
			|| typeof getScrape !== 'function' || typeof onError !== 'function' || !stableLogger) {
			throw new Error('Prometheus HTTP server options are invalid')
		}
		this.options = Object.freeze({
			host,
			port: port as number,
			logger: stableLogger,
			onError: onError as PrometheusHttpServerOptions['onError'],
			getScrape: getScrape as PrometheusHttpServerOptions['getScrape']
		})
	}

	private observeError(_error: Error): void {
		try {
			this.options.onError(
				new Error('metrics_prometheus_http_server_failed'),
				{operation: 'http-server', exporter: 'prometheus'}
			)
		} catch {
			// Diagnostics must not replace the server failure.
		}
		try { this.options.logger.error('metrics.prometheus_server_error', {error: 'metrics_prometheus_http_server_failed', operation: 'http-server'}) } catch {
			// Logging is best-effort.
		}
	}

	get currentServer(): NodeHttpServer | undefined { return this.server }
	set currentServer(server: NodeHttpServer | undefined) { this.server = server }
	get isHealthy(): boolean { return this.healthy }
	isRunning(): boolean { return this.server?.listening === true }

	async start(): Promise<void> {
		if (this.stopPromise) {
			await this.stopPromise
			return this.start()
		}
		if (this.isRunning()) return
		if (this.startPromise) return this.startPromise
		const pending = new Promise<void>((resolve, reject) => {
			const server = http.createServer((req, res) => this.handleRequest(req, res))
			this.server = server
			let startupPending = true
			server.on('error', (error) => {
				this.healthy = false
				this.observeError(error)
				if (startupPending && this.server === server) {
					startupPending = false
					this.server = undefined
					server.removeAllListeners()
					reject(error)
				}
			})
			try {
				server.listen(this.options.port, this.options.host, () => {
					startupPending = false; this.healthy = true
					try { this.options.logger.info('metrics.prometheus_server_started', {host: this.options.host, port: this.options.port, endpoint: '/metrics'}) } catch {
						// Logging is best-effort.
					}
					resolve()
				})
			} catch(error) {
				startupPending = false; this.healthy = false
				if (this.server === server) this.server = undefined
				server.removeAllListeners()
				const startupError = error instanceof Error ? error : new Error('Prometheus HTTP server failed')
				this.observeError(startupError)
				reject(startupError)
			}
		})
		this.startPromise = pending
		try { await pending } finally {
			if (this.startPromise === pending) this.startPromise = undefined
		}
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise
		if (this.startPromise) {
			try { await this.startPromise } catch { return }
			// Another stop call may have acquired shutdown ownership while this
			// caller was waiting for startup to settle.
			if (this.stopPromise) return this.stopPromise
		}
		const server = this.server
		if (!server) return
		if (!server.listening) { server.removeAllListeners(); this.server = undefined; this.healthy = false; return }
		const pending = new Promise<void>((resolve, reject) => {
			server.close((error) => {
				this.healthy = false
				if (error) {
					if (!server.listening && this.server === server) {
						this.server = undefined
						server.removeAllListeners()
					}
					reject(error)
				} else {
					if (this.server === server) this.server = undefined
					server.removeAllListeners()
					resolve()
				}
			})
			// server.close() deliberately waits for active requests. A client that
			// never finishes its headers could otherwise block package shutdown.
			server.closeAllConnections()
		})
		this.stopPromise = pending
		try { await pending } finally {
			if (this.stopPromise === pending) this.stopPromise = undefined
		}
	}

	private handleRequest(req: HttpRequest, res: HttpResponse): void {
		if (req.method !== 'GET' || !req.url) { res.writeHead(404, {'Content-Type': 'text/plain'}); res.end('Not Found'); return }
		let url: URL
		try { url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`) }
		catch { res.writeHead(400, {'Content-Type': 'text/plain'}); res.end('Invalid metrics request'); return }
		if (url.pathname !== '/metrics') { res.writeHead(404, {'Content-Type': 'text/plain'}); res.end('Not Found'); return }
		try {
			const requested = url.searchParams.get('format')
			const format = requested === 'openmetrics' || requested === 'prometheus'
				? requested
				: req.headers.accept?.includes('application/openmetrics-text') ? 'openmetrics'
					: req.headers.accept?.includes('text/plain') ? 'prometheus' : undefined
			const scrape = this.options.getScrape(format)
			if (!scrape || typeof scrape !== 'object') {
				throw new Error('Prometheus scrape source returned an invalid response')
			}
			const descriptors = Object.getOwnPropertyDescriptors(scrape)
			const body = descriptors.body && 'value' in descriptors.body ? descriptors.body.value : undefined
			const contentType = descriptors.contentType && 'value' in descriptors.contentType
				? descriptors.contentType.value : undefined
			if (typeof body !== 'string' || body.length > PROMETHEUS_HARD_MAX_BUFFER_SIZE
				|| typeof contentType !== 'string' || contentType.length === 0 || contentType.length > 256
				|| /[\r\n]/u.test(contentType)) {
				throw new Error('Prometheus scrape source returned an invalid response')
			}
			const contentLength = Buffer.byteLength(body, 'utf8')
			if (contentLength > PROMETHEUS_HARD_MAX_BUFFER_SIZE) {
				throw new Error('Prometheus scrape source returned an oversized response')
			}
			res.writeHead(200, {'Content-Type': contentType, 'Content-Length': contentLength})
			res.end(body)
		} catch { res.writeHead(500, {'Content-Type': 'text/plain'}); res.end('Metrics endpoint failed') }
	}
}
