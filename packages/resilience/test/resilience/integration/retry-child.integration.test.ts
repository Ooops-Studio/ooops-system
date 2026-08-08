import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {build} from 'tsup'
import {describe, expect, it} from 'vitest'

describe('resilience child-process timers', () => {
	it('keeps awaited retry timers referenced and exits cleanly after shutdown', async() => {
		const output = await mkdtemp(join(tmpdir(), 'ooops-resilience-child-'))
		try {
			await build({
				entry: {child: fileURLToPath(new URL('./fixtures/retry-child.ts', import.meta.url))},
				format: ['esm'], platform: 'node', target: 'node22', bundle: true,
				noExternal: [/^@ooopsstudio\/core/], minify: true, dts: false,
				sourcemap: false, clean: true, outDir: output, config: false, silent: true
			})
			const child = spawn(process.execPath, [join(output, 'child.js')], {stdio: ['ignore', 'pipe', 'pipe']})
			let stdout = ''; let stderr = ''
			child.stdout.on('data', (chunk) => { stdout += String(chunk) })
			child.stderr.on('data', (chunk) => { stderr += String(chunk) })
			const [exitCode] = await once(child, 'exit')
			expect(exitCode, stderr || stdout).toBe(0)
			expect(stdout).toContain('OOOPS_RESILIENCE_CHILD={"result":"ok","attempts":2,"state":"closed"}')
		} finally { await rm(output, {recursive: true, force: true}) }
	}, 20_000)
})
