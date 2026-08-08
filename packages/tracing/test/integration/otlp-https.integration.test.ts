import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {createServer} from 'node:https'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {gunzipSync} from 'node:zlib'

import {build} from 'tsup'
import {describe, expect, it} from 'vitest'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

describe('Tracing OTLP HTTPS integration', () => {
	it('delivers gzip OTLP with verified TLS, headers, retry, flush and shutdown', async() => {
		const output = await mkdtemp(join(tmpdir(), 'ooops-tracing-integration-'))
		const key = await readFile(join(fixtures, 'server-key.pem'))
		const cert = await readFile(join(fixtures, 'server.pem'))
		const ca = join(fixtures, 'ca.pem')
		const requests: Array<{authorization: string; body: string}> = []
		const server = createServer({key, cert}, async(request, response) => {
			const chunks: Buffer[] = []
			for await (const chunk of request) chunks.push(Buffer.from(chunk))
			const compressed = Buffer.concat(chunks)
			const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(compressed) : compressed
			requests.push({authorization: String(request.headers.authorization ?? ''), body: body.toString('utf8')})
			if (requests.length === 1) {
				response.writeHead(429, {'retry-after': '0', 'content-type': 'application/json'})
				response.end('{}')
				return
			}
			response.writeHead(200, {'content-type': 'application/json'})
			response.end('{}')
		})
		try {
			await build({
				entry: {custom: fileURLToPath(new URL('../../src/public/custom.ts', import.meta.url))},
				format: ['esm'], platform: 'node', target: 'node22', bundle: true,
				noExternal: [/^@ooopsstudio\/core/], minify: true, dts: false, sourcemap: false,
				// The directory is newly created. Avoid tsup's process-global clean pass,
				// which can race the built-export contract running in another worker.
				clean: false, outDir: output, config: false, silent: true
			})
			server.listen(0, '127.0.0.1')
			await once(server, 'listening')
			const address = server.address()
			if (!address || typeof address === 'string') throw new Error('TLS receiver did not expose a port')
			const script = `
				const {createCustomTracing} = await import(process.env.TRACING_BUNDLE)
				const tracer = await createCustomTracing({
					clock: {now: () => Date.now()}, sampling: {strategy: 'fixed-rate', rate: 1},
					destination: {provider: 'otlp', endpoint: process.env.OTLP_ENDPOINT,
						headers: {authorization: 'Bearer integration-token'}},
					delivery: {mode: 'batched', batching: {maxBatch: 1, maxIntervalMs: 1000, maxBytes: 64000},
						retry: {maxAttempts: 3, baseDelayMs: 1, multiplier: 1, maxDelayMs: 1, jitter: 0, attemptTimeoutMs: 2000}}
				})
				await tracer.inSpan('integration.trace', async span => span.setAttribute('password', 'secret-value'))
				await tracer.forceFlush()
				await tracer.shutdown()
			`
			const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
				env: {...process.env, NODE_EXTRA_CA_CERTS: ca,
					TRACING_BUNDLE: pathToFileURL(join(output, 'custom.js')).href,
					OTLP_ENDPOINT: `https://localhost:${address.port}/v1/traces`},
				stdio: ['ignore', 'pipe', 'pipe']
			})
			let stderr = ''
			child.stderr.on('data', (chunk) => { stderr += String(chunk) })
			const [exitCode] = await once(child, 'exit')
			expect(exitCode, stderr).toBe(0)
			expect(requests.length).toBe(2)
			expect(requests.every(({authorization}) => authorization === 'Bearer integration-token')).toBe(true)
			const payload = JSON.parse(requests.at(-1)!.body) as {resourceSpans?: unknown[]}
			expect(payload.resourceSpans).toHaveLength(1)
			expect(requests.at(-1)!.body).toContain('integration.trace')
			expect(requests.at(-1)!.body).not.toContain('secret-value')
		} finally {
			server.close()
			await rm(output, {recursive: true, force: true})
		}
	}, 20_000)
})
