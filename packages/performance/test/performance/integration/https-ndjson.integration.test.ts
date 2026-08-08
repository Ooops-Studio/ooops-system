import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {createServer} from 'node:https'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {build} from 'tsup'
import {describe, expect, it} from 'vitest'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

describe('performance HTTPS NDJSON integration', () => {
	it('uses verified TLS, authorization, redaction, retry, flush and shutdown', async() => {
		const directory = await mkdtemp(join(tmpdir(), 'ooops-performance-integration-'))
		const key = await readFile(join(fixtures, 'server-key.pem'))
		const cert = await readFile(join(fixtures, 'server.pem'))
		const bodies: string[] = []; const authorization: string[] = []
		const server = createServer({key, cert}, async(request, response) => {
			authorization.push(String(request.headers.authorization ?? ''))
			let body = ''; for await (const chunk of request) body += String(chunk); bodies.push(body)
			if (bodies.length === 1) { response.writeHead(429, {'retry-after': '0'}); response.end('retry') }
			else { response.writeHead(202); response.end('ok') }
		})
		try {
			await build({entry: {child: fileURLToPath(new URL('./https-child.ts', import.meta.url))},
				format: ['esm'], platform: 'node', target: 'node22', bundle: true,
				noExternal: [/^@ooopsstudio\/core/], minify: true, dts: false, sourcemap: false,
				clean: true, outDir: directory, config: false, silent: true})
			server.listen(0, '127.0.0.1'); await once(server, 'listening')
			const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
			const child = spawn(process.execPath, [join(directory, 'child.js')], {env: {
				...process.env,
				NODE_EXTRA_CA_CERTS: join(fixtures, 'ca.pem'),
				PERFORMANCE_ENDPOINT: `https://localhost:${address.port}/performance`
			}, stdio: ['ignore', 'pipe', 'pipe']})
			let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk) })
			const [code] = await once(child, 'exit')
			expect(code, stderr).toBe(0)
			expect(bodies).toHaveLength(2)
			expect(authorization).toEqual(['Bearer integration-token', 'Bearer integration-token'])
			expect(bodies[1]).toContain('[redacted]')
			expect(bodies[1]).not.toContain('secret-value')
		} finally { server.close(); await rm(directory, {recursive: true, force: true}) }
	}, 15_000)
})
