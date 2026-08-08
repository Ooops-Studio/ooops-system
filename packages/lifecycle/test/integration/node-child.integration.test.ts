import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {build} from 'tsup'
import {describe, expect, it} from 'vitest'

const prefix = 'OOOPS_LIFECYCLE_CHILD='

async function buildFixture(): Promise<string> {
	const output = await mkdtemp(join(tmpdir(), 'ooops-lifecycle-child-'))
	await build({
		entry: {child: fileURLToPath(new URL('./fixtures/node-child.ts', import.meta.url))},
		format: ['esm'], platform: 'node', target: 'node22', bundle: true,
		noExternal: [/^@ooopsstudio\/core/], minify: true, dts: false,
		sourcemap: false, clean: true, outDir: output, config: false, silent: true
	})
	return output
}

function parse(stdout: string): Array<Record<string, unknown>> {
	return stdout.split(/\r?\n/u)
		.filter((line) => line.startsWith(prefix))
		.map((line) => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>)
}

describe('Node lifecycle child-process integration', () => {
	it('drains and shuts down exactly once on SIGTERM', async() => {
		const output = await buildFixture()
		try {
			const child = spawn(process.execPath, [join(output, 'child.js')], {
				env: {...process.env, LIFECYCLE_CHILD_MODE: 'signal'},
				stdio: ['ignore', 'pipe', 'pipe']
			})
			let stdout = ''
			let stderr = ''
			let signaled = false
			child.stdout.on('data', (chunk) => {
				stdout += String(chunk)
				if (!signaled && stdout.includes('"event":"ready"')) {
					signaled = true
					child.kill('SIGTERM')
				}
			})
			child.stderr.on('data', (chunk) => { stderr += String(chunk) })
			const [exitCode] = await once(child, 'exit')
			expect(exitCode, stderr || stdout).toBe(0)
			expect(parse(stdout)).toContainEqual({event: 'closed', state: 'closed', shutdownHookCalls: 1})
		} finally {
			await rm(output, {recursive: true, force: true})
		}
	}, 20_000)

	it('sanitizes fatal diagnostics, shuts down, then delegates termination', async() => {
		const output = await buildFixture()
		try {
			const child = spawn(process.execPath, [join(output, 'child.js')], {
				env: {...process.env, LIFECYCLE_CHILD_MODE: 'fatal'},
				stdio: ['ignore', 'pipe', 'pipe']
			})
			let stdout = ''
			let stderr = ''
			child.stdout.on('data', (chunk) => { stdout += String(chunk) })
			child.stderr.on('data', (chunk) => { stderr += String(chunk) })
			const [exitCode] = await once(child, 'exit')
			expect(exitCode, stderr || stdout).toBe(1)
			const events = parse(stdout)
			expect(events).toContainEqual({
				event: 'fatal', message: 'token=[REDACTED]', type: 'unhandledRejection'
			})
			expect(events).toContainEqual({event: 'terminated', exitCode: 1, state: 'closed'})
			expect(stdout).not.toContain('child-secret')
		} finally {
			await rm(output, {recursive: true, force: true})
		}
	}, 20_000)
})
