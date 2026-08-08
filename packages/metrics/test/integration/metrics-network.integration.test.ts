import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {createServer as createHttpsServer} from 'node:https'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {gunzipSync} from 'node:zlib'

import {build} from 'tsup'
import {describe, expect, it} from 'vitest'

import {createPrometheusMetrics} from '../../src/public/production-prometheus'
import {createPrometheusHttpServer} from '../../src/sinks/prometheus-http'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const RESULT_PREFIX = 'OOOPS_METRICS_INTEGRATION_RESULT='

describe('metrics real network integrations', () => {
	it('serves a production scrape through the explicit standalone worker adapter', async() => {
		const metrics = await createPrometheusMetrics()
		const server = createPrometheusHttpServer(metrics, {port: 0, exposure: 'network'})
		try {
			metrics.counter('worker_jobs_total', 2, {worker: 'mail'})
			await metrics.flush()
			await server.start()
			const address = server.currentServer?.address()
			if (!address || typeof address === 'string') throw new Error('Worker adapter did not expose a port')
			const response = await fetch(`http://127.0.0.1:${address.port}/metrics?format=openmetrics`)
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toContain('application/openmetrics-text')
			expect(await response.text()).toContain('worker_jobs_total')
		} finally {
			await server.stop()
			await metrics.shutdown()
		}
	})

	it('delivers OTLP over verified HTTPS, retries a 429, and exits cleanly', async() => {
		const outputDirectory = await mkdtemp(join(tmpdir(), 'ooops-metrics-integration-'))
		const key = await readFile(join(fixtures, 'server-key.pem'))
		const cert = await readFile(join(fixtures, 'server.pem'))
		const ca = join(fixtures, 'ca.pem')
		const requests: Array<{
			path: string
			body: string
			authorization: string
			contentEncoding: string
		}> = []
		const receiver = createHttpsServer({key, cert}, async(request, response) => {
			const chunks: Buffer[] = []
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
			const contentEncoding = String(request.headers['content-encoding'] ?? '')
			const payload = Buffer.concat(chunks)
			const body = contentEncoding === 'gzip' ? gunzipSync(payload).toString('utf8') : payload.toString('utf8')
			requests.push({
				path: request.url ?? '', body,
				authorization: String(request.headers.authorization ?? ''),
				contentEncoding
			})
			const attempt = requests.length
			if (attempt === 1) {
				response.writeHead(429, {'retry-after': '0'})
				response.end('retry')
				return
			}
			if (attempt === 2) await delay(150)
			response.writeHead(200, {'content-type': 'application/json'})
			response.end('{}')
		})

		try {
			await build({
				entry: {custom: fileURLToPath(new URL('../../src/public/custom.ts', import.meta.url))},
				format: ['esm'], platform: 'node', target: 'node22', bundle: true, splitting: true,
				noExternal: [/^@ooopsstudio\/core/], minify: true, dts: false, sourcemap: false,
				clean: true, outDir: outputDirectory, config: false, silent: true
			})
			receiver.listen(0, '127.0.0.1')
			await once(receiver, 'listening')
			const address = receiver.address()
			if (!address || typeof address === 'string') throw new Error('OTLP receiver did not expose a port')
			const script = `
				const {createCustomMetrics} = await import(process.env.METRICS_BUNDLE)
				const metrics = await createCustomMetrics({
					clock: {now: () => Date.now()}, selfMetrics: false,
					destinations: [{provider: 'otlp', endpoint: process.env.OTLP_ENDPOINT,
						headers: {authorization: 'Bearer metrics-integration'}, timeout: 50,
						enableGzip: true, gzipThresholdBytes: 1}],
					delivery: {operationTimeoutMs: 3000, retry: {
						maxRetries: 3, baseDelayMs: 10, maxDelayMs: 20, multiplier: 2, jitter: false
					}}
				})
				metrics.counter('integration_requests_total', 3, {service: 'suite'})
				await metrics.flush()
				const before = metrics.getStatus()
				await metrics.shutdown()
				console.log('${RESULT_PREFIX}' + JSON.stringify({before, after: metrics.getStatus()}))
			`
			const child = spawn(process.execPath, [
				'--dns-result-order=ipv4first', '--input-type=module', '--eval', script
			], {
				env: {
					...process.env,
					NODE_EXTRA_CA_CERTS: ca,
					METRICS_BUNDLE: pathToFileURL(join(outputDirectory, 'custom.js')).href,
					OTLP_ENDPOINT: `https://localhost:${address.port}/v1/metrics`
				},
				stdio: ['ignore', 'pipe', 'pipe']
			})
			let stdout = ''
			let stderr = ''
			child.stdout.on('data', (chunk) => { stdout += String(chunk) })
			child.stderr.on('data', (chunk) => { stderr += String(chunk) })
			const [exitCode] = await once(child, 'exit')
			expect(exitCode, stderr || stdout).toBe(0)
			// 429 + transport timeout + two or three bounded retries, followed by the
			// required final cumulative snapshot. Whether the timed-out physical request
			// settles before the next retry is deliberately scheduler-dependent.
			expect(requests.length).toBeGreaterThanOrEqual(4)
			expect(requests.length).toBeLessThanOrEqual(5)
			expect(requests.every(({path}) => path === '/v1/metrics')).toBe(true)
			expect(requests.every(({authorization}) => authorization === 'Bearer metrics-integration')).toBe(true)
			expect(requests.every(({contentEncoding}) => contentEncoding === 'gzip')).toBe(true)
			expect(requests[2]?.body).toContain('integration_requests_total')
			const resultLine = stdout.split(/\r?\n/u).find((line) => line.startsWith(RESULT_PREFIX))
			if (!resultLine) throw new Error(`Metrics child returned no status: ${stdout}\n${stderr}`)
			const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length))
			expect(result.before).toMatchObject({state: 'running', sinkState: 'healthy'})
			// The timed-out request may settle while the final cumulative export starts. Both
			// schedules are valid, but retries must include the two forced failures and stay bounded.
			expect(result.before.retriedTotal).toBeGreaterThanOrEqual(2)
			expect(result.before.retriedTotal).toBeLessThanOrEqual(3)
			expect(result.after).toMatchObject({state: 'closed', sinkState: 'closed'})
		} finally {
			receiver.close()
			await rm(outputDirectory, {recursive: true, force: true})
		}
	}, 20_000)
})
