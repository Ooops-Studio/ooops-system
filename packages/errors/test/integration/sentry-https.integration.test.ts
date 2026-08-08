import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {createServer} from 'node:https'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {build} from 'tsup'
import {describe, expect, it} from 'vitest'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

describe('Sentry HTTPS integration', () => {
	it('delivers a redacted envelope through a CA-verified local TLS connection', async() => {
		const outputDirectory = await mkdtemp(join(tmpdir(), 'ooops-errors-integration-'))
		const key = await readFile(join(fixtures, 'server-key.pem'))
		const cert = await readFile(join(fixtures, 'server.pem'))
		const ca = join(fixtures, 'ca.pem')
		let receivedPath = ''
		let receivedType = ''
		let receivedBody = ''
		const server = createServer({key, cert}, async(request, response) => {
			receivedPath = request.url ?? ''
			receivedType = String(request.headers['content-type'] ?? '')
			for await (const chunk of request) receivedBody += String(chunk)
			response.writeHead(200)
			response.end('ok')
		})

		try {
			await build({
				entry: {sentry: fileURLToPath(new URL('../../src/sentry.ts', import.meta.url))},
				format: ['esm'], platform: 'node', target: 'node22', bundle: true,
				noExternal: [/^@ooopsstudio\/core/],
				minify: true, dts: false, sourcemap: false, clean: true,
				outDir: outputDirectory, config: false, silent: true
			})
			server.listen(0, '127.0.0.1')
			await once(server, 'listening')
			const address = server.address()
			if (!address || typeof address === 'string') throw new Error('TLS server did not expose a port')
			const script = `
				const {createSentryErrorSink} = await import(process.env.SENTRY_BUNDLE)
				const sink = createSentryErrorSink({dsn: process.env.SENTRY_DSN, requestTimeoutMs: 2000})
				await sink.capture({kind: 'Error', message: 'token=secret-value', severity: 'error',
					category: 'UNKNOWN', timestamp: 1, context: {password: 'secret-value'}})
				await sink.flush()
				await sink.close()
			`
			const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
				env: {
					...process.env,
					NODE_EXTRA_CA_CERTS: ca,
					SENTRY_BUNDLE: pathToFileURL(join(outputDirectory, 'sentry.js')).href,
					SENTRY_DSN: `https://public@127.0.0.1:${address.port}/42`
				},
				stdio: ['ignore', 'pipe', 'pipe']
			})
			let stderr = ''
			child.stderr.on('data', (chunk) => { stderr += String(chunk) })
			const [exitCode] = await once(child, 'exit')
			expect(exitCode, stderr).toBe(0)
			expect(receivedPath).toBe('/api/42/envelope/')
			expect(receivedType).toContain('application/x-sentry-envelope')
			expect(receivedBody).toContain('[REDACTED]')
			expect(receivedBody).not.toContain('secret-value')
		} finally {
			server.close()
			await rm(outputDirectory, {recursive: true, force: true})
		}
	}, 15_000)
})
