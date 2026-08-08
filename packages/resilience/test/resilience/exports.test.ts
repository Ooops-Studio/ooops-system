import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

describe('resilience explicit exports', () => {
	it('exposes only registration, managed presets, observability, and public types', () => {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {exports: Record<string, unknown>}
		expect(Object.keys(manifest.exports).sort()).toEqual([
			'.', './custom', './development', './observability', './production', './public/types'
		])
		for (const removed of ['testing', 'minimal', 'builders', 'swr', 'idempotency', 'recovery', 'events']) {
			expect(manifest.exports).not.toHaveProperty(`./${removed}`)
		}
	})
})
