import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

describe('cache explicit exports', () => {
	it('exposes registration, presets, observability and public types', () => {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
			exports: Record<string, unknown>
		}
		expect(Object.keys(manifest.exports).sort()).toEqual([
			'.', './custom', './development', './observability', './production', './public/types'
		])
		expect(manifest.exports).not.toHaveProperty('./minimal')
		expect(manifest.exports).not.toHaveProperty('./testing')
		expect(manifest.exports).not.toHaveProperty('./backends/memory')
		expect(manifest.exports).not.toHaveProperty('./backends/redis')
	})

	it('does not declare removed cache controls or detailed status APIs', () => {
		const coreContracts = readFileSync(new URL('../../../core/src/contracts/cache.ts', import.meta.url), 'utf8')
		const corePorts = readFileSync(new URL('../../../core/src/ports/cache.ts', import.meta.url), 'utf8')
		const publicTypes = readFileSync(new URL('../../src/cache/public/types.ts', import.meta.url), 'utf8')
		const declarations = `${coreContracts}\n${corePorts}\n${publicTypes}`
		for (const removed of [
			'slidingTtl', 'renewTtl', 'renewTtlMany', 'getStats', 'CacheHealthSnapshot',
			'CacheBackendStats', 'namespaceDefaults', 'ttlJitterRatio'
		]) expect(declarations).not.toContain(removed)
		expect(corePorts).toContain('interface ManagedCache extends CacheServicePort')
	})

	it('loads every documented cache subpath from the built package', async() => {
		const [root, development, production, custom, observability, publicTypes] = await Promise.all([
			import('../../dist/index.js'),
			import('../../dist/development.js'),
			import('../../dist/production.js'),
			import('../../dist/custom.js'),
			import('../../dist/observability.js'),
			import('../../dist/public/types.js')
		])
		expect(root).toHaveProperty('registerCache')
		expect(root).not.toHaveProperty('createDevelopmentCache')
		expect(development).toHaveProperty('createDevelopmentCache')
		expect(production).toHaveProperty('createProductionCache')
		expect(custom).toHaveProperty('createCustomCache')
		expect(observability).toHaveProperty('attachCacheObservability')
		expect(Object.keys(publicTypes)).toHaveLength(0)
	})
})
