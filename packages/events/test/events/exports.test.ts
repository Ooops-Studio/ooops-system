import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

describe('events public exports', () => {
	it('exposes managed, privileged, storage, migration, and transport boundaries explicitly', () => {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {exports: Record<string, unknown>}
		expect(Object.keys(manifest.exports).sort()).toEqual([
			'.', './admin', './backends/custom', './custom', './development', './migrations/postgres',
			'./observability', './production', './stores/memory', './stores/postgres',
			'./transports/custom', './transports/http', './transports/kafka', './transports/nats'
		].sort())
		for (const excluded of ['./workflows', './testing', './local-bus', './runtime', './public/types']) {
			expect(manifest.exports).not.toHaveProperty(excluded)
		}
	})
})
