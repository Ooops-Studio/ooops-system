import {spawnSync} from 'node:child_process'

import {describe, expect, it} from 'vitest'

describe('audit referenced finalization timers', () => {
	it('keeps Node alive until an awaited shutdown timeout settles', () => {
		const source = `
			import {createCustomAudit} from './dist/custom.js'
			const runtime = await createCustomAudit({
				clock: {now: () => 0},
				store: {
					kind: 'child-test',
					appendMany: async () => [],
					getById: async () => undefined,
					query: async () => ({items: []}),
					flush: async () => await new Promise(() => {})
				},
				finalization: {shutdownTimeoutMs: 40}
			})
			try { await runtime.audit.shutdown() }
			catch { console.log(runtime.audit.getStatus().lastFailureCode) }
		`
		const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
			cwd: new URL('../../..', import.meta.url), encoding: 'utf8', timeout: 2_000
		})
		expect(child.status).toBe(0)
		expect(child.stdout.trim()).toBe('AUDIT_SHUTDOWN_TIMEOUT')
	})
})
