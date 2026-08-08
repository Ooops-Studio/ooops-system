import {createContainer} from '@ooopsstudio/core/runtime/container'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerCache} from '../../../src/cache'
import {createMemoryCacheBackend} from '../../../src/cache/features/backends/memory'
import {createCustomCache} from '../../../src/cache/public/custom'
import {createDevelopmentCache} from '../../../src/cache/public/development'
import {createProductionCache} from '../../../src/cache/public/production'

describe('cache presets', () => {
	it('provides bounded memory development and explicit custom composition', async() => {
		const clock = createFixedClock(0)
		const development = createDevelopmentCache({clock})
		await development.set('key', 'development')
		expect(await development.get('key')).toBe('development')
		expect(() => createCustomCache(undefined as never)).toThrow('external backend')
		expect(() => createCustomCache({} as never)).toThrow('external backend')
		expect(() => createCustomCache({backend: {} as never, clock})).toThrow('complete backend')
		const custom = createCustomCache({backend: createMemoryCacheBackend({clock}), clock})
		await custom.set('key', 'custom')
		expect(await custom.get('key')).toBe('custom')
	})

	it('rejects removed preset controls and direct observability dependencies', () => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		for (const field of ['namespaceDefaults', 'ttlJitterRatio', 'logger', 'errors', 'metrics', 'tracer']) {
			expect(() => createCustomCache({backend, clock, [field]: {}} as never)).toThrow('unexpected fields')
		}
	})

	it('requires an eval-only Redis transport and namespace in production', () => {
		expect(() => createProductionCache(undefined as never)).toThrow('Redis')
		expect(() => createProductionCache({redis: {} as never, namespace: ''})).toThrow()
		expect(() => createProductionCache({redis: {} as never, namespace: 'app'})).toThrow('eval() primitive')
		const runtime = createProductionCache({redis: {eval: vi.fn(async() => 0)}, namespace: 'app'})
		expect(runtime.getStatus().state).toBe('running')
	})

	it('registers the selected preset and rejects duplicate or hostile registration', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(0))
		await registerCache(container, {preset: 'development'})
		expect(container.has(TOK.Cache)).toBe(true)
		await expect(registerCache(container, {preset: 'development'})).rejects.toThrow('already_registered')

		const other = createContainer(); other.bind(TOK.Clock, createFixedClock(0))
		await expect(registerCache(other, {preset: 'unknown'} as never)).rejects.toThrow('Unknown cache preset')
		let getterCalls = 0
		const hostile = Object.defineProperty({}, 'preset', {enumerable: true, get() { getterCalls++; return 'development' }})
		await expect(registerCache(other, hostile as never)).rejects.toThrow('invalid or unexpected fields')
		expect(getterCalls).toBe(0)
	})

	it('atomically rolls back a failed bind and awaits cache shutdown', async() => {
		const clock = createFixedClock(0)
		const backend = createMemoryCacheBackend({clock})
		const shutdown = vi.spyOn(backend, 'shutdown')
		const bindings = new Map<symbol, unknown>()
		const container = {
			has: (token: symbol) => bindings.has(token),
			get: () => clock,
			tryGet: <T>(token: symbol) => bindings.get(token) as T | undefined,
			unbind: (token: symbol) => bindings.delete(token),
			bind: (token: symbol, value: unknown) => { bindings.set(token, value); throw new Error('bind failed') }
		}
		await expect(registerCache(container as never, {preset: 'custom', options: {backend}})).rejects.toThrow('bind failed')
		expect(shutdown).toHaveBeenCalledOnce()
		expect(container.has(TOK.Cache)).toBe(false)
	})
})
