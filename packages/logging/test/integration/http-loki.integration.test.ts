import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, rm} from 'node:fs/promises'
import {createServer, type IncomingHttpHeaders, type Server} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {build} from 'tsup'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

interface ReceivedRequest {
	readonly path: string
	readonly headers: IncomingHttpHeaders
	readonly body: string
}

interface ChildResult {
	readonly before?: {
		readonly state: string
		readonly queueSize: number
		readonly retriedTotal: number
		readonly sinkState: string
	}
	readonly after: {
		readonly state: string
		readonly queueSize: number
		readonly sinkState: string
	}
}

const RESULT_PREFIX = 'OOOPS_LOGGING_INTEGRATION_RESULT='
let outputDirectory = ''

async function listen(server: Server): Promise<number> {
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Integration server did not expose a port')
	return address.port
}

async function close(server: Server): Promise<void> {
	if (!server.listening) return
	await new Promise<void>((resolve, reject) => {
		server.close((error) => { if (error) reject(error); else resolve() })
	})
}

async function runChild(
	entry: 'custom' | 'production',
	script: string,
	env: Readonly<Record<string, string | undefined>>
): Promise<ChildResult> {
	const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
		env: {
			...process.env,
			...env,
			LOGGING_BUNDLE: pathToFileURL(join(outputDirectory, `${entry}.js`)).href
		},
		stdio: ['ignore', 'pipe', 'pipe']
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (chunk) => { stdout += String(chunk) })
	child.stderr.on('data', (chunk) => { stderr += String(chunk) })
	const [exitCode] = await once(child, 'exit')
	expect(exitCode, stderr || stdout).toBe(0)
	const resultLine = stdout.split(/\r?\n/u).find((line) => line.startsWith(RESULT_PREFIX))
	if (!resultLine) throw new Error(`Logging integration child returned no result.\nstdout:\n${stdout}\nstderr:\n${stderr}`)
	return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as ChildResult
}

beforeAll(async() => {
	outputDirectory = await mkdtemp(join(tmpdir(), 'ooops-logging-integration-'))
	await build({
		entry: {
			custom: fileURLToPath(new URL('../../src/public/custom.ts', import.meta.url)),
			production: fileURLToPath(new URL('../../src/public/production.ts', import.meta.url))
		},
		format: ['esm'], platform: 'node', target: 'node22', bundle: true, splitting: true,
		noExternal: [/^@ooopsstudio\/core/], minify: true, dts: false, sourcemap: false,
		clean: true, outDir: outputDirectory, config: false, silent: true
	})
}, 20_000)

afterAll(async() => {
	await rm(outputDirectory, {recursive: true, force: true})
})

describe('logging real HTTP integrations', () => {
	it('delivers production NDJSON through a real server and recovers after a rate-limit retry', async() => {
		const requests: ReceivedRequest[] = []
		const server = createServer(async(request, response) => {
			let body = ''
			for await (const chunk of request) body += String(chunk)
			requests.push({path: request.url ?? '', headers: request.headers, body})
			if (requests.length === 1) {
				response.writeHead(429, {'retry-after': '0'})
				response.end('rate limited')
				return
			}
			response.writeHead(204)
			response.end()
		})

		try {
			const port = await listen(server)
			const result = await runChild('production', `
				const {createProductionLogging} = await import(process.env.LOGGING_BUNDLE)
				const logger = await createProductionLogging({
					selfMetrics: false,
					context: {namespace: 'integration'},
					remote: {
						provider: 'http', url: process.env.LOGGING_URL,
						headers: {authorization: 'Bearer integration-secret', 'x-test-run': 'http'},
						requestTimeoutMs: 2000
					}
				})
				logger.info('first-event', {requestId: 'req-1', password: 'secret-one'})
				logger.warn('second-event', {requestId: 'req-2', token: 'secret-two'})
				await logger.flush()
				const before = logger.getStatus()
				await logger.shutdown()
				console.log('${RESULT_PREFIX}' + JSON.stringify({before, after: logger.getStatus()}))
			`, {LOGGING_URL: `http://127.0.0.1:${port}/v1/logs`})

			// The first record is replayed after 429; the second admitted record is
			// allowed to occupy the next bounded batch while that retry is active.
			expect(requests).toHaveLength(3)
			expect(requests.every(({path}) => path === '/v1/logs')).toBe(true)
			expect(requests[1]?.body).toBe(requests[0]?.body)
			expect(requests[1]?.headers['content-type']).toContain('application/x-ndjson')
			expect(requests[1]?.headers.authorization).toBe('Bearer integration-secret')
			expect(requests[1]?.headers['x-test-run']).toBe('http')
			const records = requests.slice(1).flatMap(({body}) =>
				body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
			expect(records).toHaveLength(2)
			expect(records.map((record) => record.message)).toEqual(['first-event', 'second-event'])
			expect(records[0]).toMatchObject({namespace: 'integration', attributes: {requestId: 'req-1'}})
			expect(records[1]).toMatchObject({namespace: 'integration', attributes: {token: '***'}})
			expect(JSON.stringify(records)).not.toContain('secret-one')
			expect(JSON.stringify(records)).not.toContain('secret-two')
			expect(result.before).toMatchObject({
				state: 'running', queueSize: 0, retriedTotal: 1, sinkState: 'healthy'
			})
			expect(result.after).toMatchObject({state: 'closed', queueSize: 0, sinkState: 'closed'})
		} finally {
			await close(server)
		}
	}, 15_000)

	it('flushes a real batched Loki payload with normalized path, labels, headers, and redaction', async() => {
		const requests: ReceivedRequest[] = []
		const server = createServer(async(request, response) => {
			let body = ''
			for await (const chunk of request) body += String(chunk)
			requests.push({path: request.url ?? '', headers: request.headers, body})
			response.writeHead(204)
			response.end()
		})

		try {
			const port = await listen(server)
			const result = await runChild('custom', `
				const {createCustomLogging} = await import(process.env.LOGGING_BUNDLE)
				const logger = await createCustomLogging({
					clock: {now: () => 1710000000000}, selfMetrics: false,
					context: {namespace: 'notes', attributes: {app: 'ooops-suite', runtime: 'server'}},
					destinations: {stdout: false, remote: {
						provider: 'loki', url: process.env.LOGGING_URL,
						headers: {'X-Scope-OrgID': 'studio'},
						defaultLabels: {deployment: 'integration', tenant: 'acme-private-workspace-123'},
						requestTimeoutMs: 2000
					}},
					delivery: {
						mode: 'batched', circuitBreaker: false,
						batching: {maxBatch: 50, maxIntervalMs: 60000, maxBytes: 128000},
						backpressure: {maxQueuedItems: 100, maxQueuedBytes: 100000, onOverflow: 'drop-oldest'},
						retry: {maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 2000}
					}
				})
				logger.info('note-created', {requestId: 'req-1', password: 'secret-one'})
				logger.info('note-updated', {requestId: 'req-2', authorization: 'secret-two'})
				await logger.shutdown()
				console.log('${RESULT_PREFIX}' + JSON.stringify({after: logger.getStatus()}))
			`, {LOGGING_URL: `http://127.0.0.1:${port}/tenant/`})

			expect(requests).toHaveLength(1)
			expect(requests[0]?.path).toBe('/tenant/loki/api/v1/push')
			expect(requests[0]?.headers['content-type']).toContain('application/json')
			expect(requests[0]?.headers['x-scope-orgid']).toBe('studio')
			const payload = JSON.parse(requests[0]?.body ?? '{}') as {
				streams: Array<{stream: Record<string, string>; values: Array<[string, string]>}>
			}
			expect(payload.streams).toHaveLength(1)
			expect(payload.streams[0]?.stream).toMatchObject({
				app: 'ooops-suite', deployment: 'integration', level: 'info',
				namespace: 'notes', runtime: 'server', tenant: 'id'
			})
			expect(payload.streams[0]?.values).toHaveLength(2)
			expect(payload.streams[0]?.values.map(([timestamp]) => timestamp)).toEqual([
				'1710000000000000000', '1710000000000000000'
			])
			const lines = payload.streams[0]?.values.map(([, line]) => JSON.parse(line)) ?? []
			expect(lines.map((line) => line.message)).toEqual(['note-created', 'note-updated'])
			expect(lines[0]).toMatchObject({attributes: {password: '***', requestId: 'req-1'}})
			expect(lines[1]).toMatchObject({attributes: {authorization: '***', requestId: 'req-2'}})
			expect(requests[0]?.body).not.toContain('secret-one')
			expect(requests[0]?.body).not.toContain('secret-two')
			expect(result.after).toMatchObject({state: 'closed', queueSize: 0, sinkState: 'closed'})
		} finally {
			await close(server)
		}
	}, 15_000)
})
