import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

describe('errors package exports', () => {
	it('publishes only the supported root, preset, type, sink, and Sentry subpaths', () => {
		const manifest = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8')
		) as {exports: Record<string, unknown>}
		expect(manifest.exports).toEqual({
			'.': {types: './dist/index.d.ts', import: './dist/index.js'},
			'./sinks': {types: './dist/sinks/index.d.ts', import: './dist/sinks/index.js'},
			'./development': {types: './dist/development.d.ts', import: './dist/development.js'},
			'./production': {types: './dist/production.d.ts', import: './dist/production.js'},
			'./custom': {types: './dist/custom.d.ts', import: './dist/custom.js'},
			'./sentry': {types: './dist/sentry.d.ts', import: './dist/sentry.js'},
			'./public/types': {types: './dist/public/types.d.ts', import: './dist/public/types.js'}
		})
		expect(manifest.exports).not.toHaveProperty('./minimal')
		expect(manifest.exports).not.toHaveProperty('./testing')
		expect(manifest.exports).not.toHaveProperty('./core')
		expect(manifest.exports).not.toHaveProperty('./utils')
	})
})
