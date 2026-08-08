import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

describe('profiling explicit exports', () => {
	it('exposes only the root, presets, and opt-in capabilities', () => {
		const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {exports: Record<string, unknown>}
		const profilingExports = Object.keys(manifest.exports).sort()

		expect(profilingExports).toEqual([
			'.',
			'./custom',
			'./development',
			'./exporters/console',
			'./exporters/memory',
			'./observability',
			'./production',
			'./profilers/inspector',
			'./providers/pyroscope'
		])
		expect(manifest.exports).not.toHaveProperty('./minimal')
		expect(manifest.exports).not.toHaveProperty('./testing')
		expect(manifest.exports).not.toHaveProperty('./exporters/pyroscope-http')
		expect(manifest.exports).not.toHaveProperty('./observers')
		expect(manifest.exports).not.toHaveProperty('./public/types')
	})
})
