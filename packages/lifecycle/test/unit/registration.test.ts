import {createContainer, type Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerLifecycle} from '../../src'

const clock = {now: () => 1_000}
const registration = {preset: 'custom', options: {shutdown: {drainGracePeriodMs: 0}}} as const

function boundContainer(): Container {
	const container = createContainer()
	container.bind(TOK.Clock, clock)
	return container
}

describe('lifecycle registration ownership', () => {
	it('rejects accessor-backed and unexpected registration fields without invoking them', async() => {
		const container = boundContainer()
		const getter = vi.fn(() => 'development')
		const hostile = Object.defineProperty({}, 'preset', {enumerable: true, get: getter})
		await expect(registerLifecycle(container, hostile as never)).rejects.toThrow('stable data fields')
		expect(getter).not.toHaveBeenCalled()
		await expect(registerLifecycle(container, {preset: 'development', extra: true} as never))
			.rejects.toThrow('unsupported fields')
	})

	it('requires reversible bindings and preserves method receivers', async() => {
		const base = boundContainer()
		await expect(registerLifecycle({...base, unbind: undefined} as unknown as Container, {preset: 'development'}))
			.rejects.toThrow('reversible container')

		const values = new Map<symbol, unknown>([[TOK.Clock, clock]])
		const container = {
			values,
			bind<T>(this: {values: Map<symbol, unknown>}, token: symbol, value: T) {
				this.values.set(token, value)
			},
			unbind(this: {values: Map<symbol, unknown>}, token: symbol) {
				return this.values.delete(token)
			},
			get<T>(this: {values: Map<symbol, unknown>}, token: symbol): T {
				const value = this.values.get(token)
				if (value === undefined) throw new Error('missing')
				return value as T
			},
			tryGet<T>(this: {values: Map<symbol, unknown>}, token: symbol) {
				return this.values.get(token) as T | undefined
			},
			has(this: {values: Map<symbol, unknown>}, token: symbol) { return this.values.has(token) }
		}
		await registerLifecycle(container, registration)
		await container.get<{shutdown(): Promise<void>}>(TOK.Lifecycle).shutdown()
	})

	it('owns registration before proxy traps can re-enter', async() => {
		const target = boundContainer()
		let reentrant: Promise<void> | undefined
		let proxy: Container
		proxy = new Proxy(target, {
			getOwnPropertyDescriptor(object, key) {
				if (key === 'has' && !reentrant) reentrant = registerLifecycle(proxy, registration)
				return Reflect.getOwnPropertyDescriptor(object, key)
			}
		})
		await registerLifecycle(proxy, registration)
		await expect(reentrant).rejects.toThrow('already registered')
		await proxy.get<{shutdown(): Promise<void>}>(TOK.Lifecycle).shutdown()
	})

	it('rolls back partial binds and rejects silent or replaced bindings', async() => {
		const partial = boundContainer()
		const originalBind = partial.bind.bind(partial)
		partial.bind = vi.fn((token, value) => {
			originalBind(token, value)
			if (token === TOK.Lifecycle) throw new Error('Bearer private-secret')
		}) as typeof partial.bind
		const failure = await registerLifecycle(partial, registration).catch((error: unknown) => error)
		expect(String(failure)).not.toContain('private-secret')
		expect(partial.has(TOK.Lifecycle)).toBe(false)

		const authorized = boundContainer()
		authorized.has = vi.fn(() => {
			throw new Error('Lifecycle lookup failed Authorization: Bearer private-credential')
		}) as typeof authorized.has
		const authorizedFailure = await registerLifecycle(authorized, registration)
			.catch((error: unknown) => error)
		expect(String(authorizedFailure)).not.toContain('private-credential')

		const silent = boundContainer()
		silent.bind = vi.fn(() => undefined) as typeof silent.bind
		await expect(registerLifecycle(silent, registration)).rejects.toThrow('did not retain')
		expect(silent.has(TOK.Lifecycle)).toBe(false)
	})

	it('keeps the awaited registration cleanup deadline referenced', async() => {
		const originalSetTimeout = globalThis.setTimeout
		const unref = vi.fn()
		vi.stubGlobal('setTimeout', ((...args: Parameters<typeof setTimeout>) => {
			const timer = originalSetTimeout(...args)
			Object.defineProperty(timer, 'unref', {configurable: true, value: unref})
			return timer
		}) as typeof setTimeout)
		try {
			const partial = boundContainer()
			const originalBind = partial.bind.bind(partial)
			partial.bind = vi.fn((token, value) => {
				originalBind(token, value)
				if (token === TOK.Lifecycle) throw new Error('bind failed')
			}) as typeof partial.bind
			await expect(registerLifecycle(partial, registration)).rejects.toThrow('Lifecycle registration failed')
			expect(unref).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('injects available optional ports without requiring concrete packages', async() => {
		const container = boundContainer()
		const logger = {info: vi.fn(), error: vi.fn(), warn: vi.fn()}
		container.bind(TOK.Logging, logger)
		await registerLifecycle(container, registration)
		const runtime = container.get<{
			start(): Promise<void>
			shutdown(): Promise<void>
		}>(TOK.Lifecycle)
		await runtime.start()
		expect(logger.info).toHaveBeenCalled()
		await runtime.shutdown()
	})
})
