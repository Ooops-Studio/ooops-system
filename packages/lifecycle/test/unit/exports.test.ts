import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

describe('lifecycle public contract', () => {
	it('keeps browser-safe entrypoints free from process listener side effects', async() => {
		const signals = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const
		const before = signals.map((signal) => process.listenerCount(signal))

		await Promise.all([
			import('../../src'),
			import('../../src/public/development'),
			import('../../src/public/production'),
			import('../../src/public/custom'),
			import('../../src/public/observability')
		])

		expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before)
	})

	it('exports only the managed presets from documented paths', async() => {
		const root = await import('../../src')
		const development = await import('../../src/public/development')
		const production = await import('../../src/public/production')
		const custom = await import('../../src/public/custom')
		const node = await import('../../src/public/node')
		const observability = await import('../../src/public/observability')
		expect(root).toHaveProperty('registerLifecycle')
		expect(development).toHaveProperty('createDevelopmentLifecycle')
		expect(production).toHaveProperty('createProductionLifecycle')
		expect(custom).toHaveProperty('createCustomLifecycle')
		expect(node).toHaveProperty('attachNodeLifecycle')
		expect(observability).toHaveProperty('attachLifecycleObservability')
		for (const removed of ['destroy', 'requestShutdown', 'createTestingLifecycle', 'wireLifecycleBridges']) {
			expect(root).not.toHaveProperty(removed)
		}
	})

	it('publishes only the documented lifecycle subpaths', () => {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
			exports: Record<string, unknown>
		}
		expect(Object.keys(manifest.exports).sort()).toEqual([
			'.', './custom', './development', './node', './observability', './production', './public/types'
		].sort())
	})

	it('loads every documented lifecycle subpath from the built package', async() => {
		const paths = [
			'../../dist/index.js',
			'../../dist/development.js',
			'../../dist/production.js',
			'../../dist/custom.js',
			'../../dist/node.js',
			'../../dist/observability.js',
			'../../dist/public/types.js'
		] as const
		const [root, development, production, custom, node, observability] = await Promise.all([
			import(paths[0]), import(paths[1]), import(paths[2]), import(paths[3]), import(paths[4]),
			import(paths[5]), import(paths[6])
		])
		expect(root.registerLifecycle).toBeTypeOf('function')
		expect(development.createDevelopmentLifecycle).toBeTypeOf('function')
		expect(production.createProductionLifecycle).toBeTypeOf('function')
		expect(custom.createCustomLifecycle).toBeTypeOf('function')
		expect(node.attachNodeLifecycle).toBeTypeOf('function')
		expect(observability.attachLifecycleObservability).toBeTypeOf('function')
	})
})
