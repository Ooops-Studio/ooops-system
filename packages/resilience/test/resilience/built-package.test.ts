import {access} from 'node:fs/promises'

import {createContainer} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it} from 'vitest'

describe('built resilience package', () => {
	it('imports root and each preset independently', async() => {
		const paths = [
			'../../dist/index.js',
			'../../dist/development.js',
			'../../dist/production.js',
			'../../dist/custom.js',
			'../../dist/observability.js',
			'../../dist/public/types.js'
		]
		for (const path of paths) await access(new URL(path, import.meta.url))
		const [root, development, production, custom, observability] = await Promise.all([
			import('../../dist/index.js'),
			import('../../dist/development.js'),
			import('../../dist/production.js'),
			import('../../dist/custom.js'),
			import('../../dist/observability.js')
		])
		expect(root.registerResilience).toBeTypeOf('function')
		expect(development.createDevelopmentResilience).toBeTypeOf('function')
		expect(production.createProductionResilience).toBeTypeOf('function')
		expect(custom.createCustomResilience).toBeTypeOf('function')
		expect(observability.attachResilienceObservability).toBeTypeOf('function')
	})

	it('preserves fallback aliases across the built registration boundary', async() => {
		const {registerResilience} = await import('../../dist/index.js')
		const container = createContainer()
		container.bind(TOK.Clock, {now: () => 0})
		const strategy = {condition: () => true, handler: () => 'fallback', degradeLevel: 'PARTIAL' as const}

		await expect(registerResilience(container, {
			preset: 'custom',
			options: {
				policies: [{
					name: 'duplicate-fallback', operationKind: 'external.http',
					timeout: {defaultMs: 100}, retry: false, circuitBreaker: false,
					fallback: 'duplicate'
				}],
				fallbacks: {duplicate: [strategy, strategy]}
			}
		})).rejects.toThrow(/Duplicate fallback strategy/u)
		expect(container.has(TOK.Resilience)).toBe(false)
	})
})
