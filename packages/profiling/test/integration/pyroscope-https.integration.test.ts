import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {createServer} from 'node:https'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {build} from 'tsup'
import {describe, expect, it} from 'vitest'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

describe('real Pyroscope HTTPS integration', () => {
	it('loads the real SDK and uploads a non-empty authenticated CPU profile over verified TLS', async() => {
		const directory = await mkdtemp(fileURLToPath(new URL('../../.pyroscope-integration-', import.meta.url)))
		const key = await readFile(join(fixtures, 'server-key.pem')); const cert = await readFile(join(fixtures, 'server.pem'))
		let path = ''; let authorization = ''; let bodyBytes = 0
		const server = createServer({key, cert}, async(request, response) => {
			path = request.url ?? ''; authorization = String(request.headers.authorization ?? '')
			for await (const chunk of request) bodyBytes += Buffer.byteLength(chunk)
			response.writeHead(200); response.end('ok')
		})
		try {
			await build({entry: {child: fileURLToPath(new URL('./pyroscope-child.ts', import.meta.url))}, format: ['esm'], platform: 'node', target: 'node22', bundle: true,
				noExternal: [/^@ooopsstudio\/core/], external: ['@pyroscope/nodejs'], minify: true, dts: false, sourcemap: false, clean: true, outDir: directory, config: false, silent: true})
			server.listen(0, '127.0.0.1'); await once(server, 'listening')
			const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing TLS address')
			const child = spawn(process.execPath, [join(directory, 'child.js')], {env: {...process.env, NODE_EXTRA_CA_CERTS: join(fixtures, 'ca.pem'), PYROSCOPE_TEST_ENDPOINT: `https://localhost:${address.port}`}, stdio: ['ignore', 'pipe', 'pipe']})
			let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk) })
			const [code] = await once(child, 'exit'); expect(code, stderr).toBe(0)
			expect(path).toMatch(/^\/ingest\?/u); expect(path).toContain('name=ooops-suite-integration-worker')
			expect(authorization).toBe(`Basic ${Buffer.from('profiles-user:profiles-token').toString('base64')}`)
			expect(bodyBytes).toBeGreaterThan(100)
		} finally { server.close(); await rm(directory, {recursive: true, force: true}) }
	}, 20_000)
})
