import {describe, expect, it, vi} from 'vitest'

import {bindCacheNamespace, createCacheKeyBuilder, defineCacheNamespace} from '../src/cache'

describe('sdk cache helpers', () => {
	it('defines namespaces, creates stable keys, and binds cache helpers', async() => {
		const definition = defineCacheNamespace<{name: string}>('users', {ttlMs: 100})
		expect(Object.isFrozen(definition)).toBe(true)
		expect(Object.isFrozen(definition.defaults)).toBe(true)
		const keyForUser = createCacheKeyBuilder('users')
		expect(keyForUser({id: 1, locale: 'en'})).toMatch(/^users:id:/)
		expect(keyForUser({email: 'user@example.com'})).not.toContain('user@example.com')
		expect(createCacheKeyBuilder()({'a:b': 'c'})).not.toBe(createCacheKeyBuilder()({a: 'b:c'}))
		expect(() => createCacheKeyBuilder()(Object.fromEntries(
			Array.from({length: 51}, (_, index) => [`field${index}`, index])
		))).toThrow('at most 50 fields')
		const bounded = createCacheKeyBuilder('x'.repeat(256))(Object.fromEntries(
			Array.from({length: 50}, (_, index) => [`field${index}`, index])
		))
		expect(bounded.length).toBeLessThanOrEqual(256)
		expect(createCacheKeyBuilder()({})).toMatch(/^key:/u)
		expect(createCacheKeyBuilder((parts) => `custom:${parts.id}`)({id: 2})).toBe('custom:2')
		expect(() => createCacheKeyBuilder(() => '')({})).toThrow('1-256 characters')
		expect(() => createCacheKeyBuilder(() => 'bad\nkey')({})).toThrow('safe characters')
		expect(() => createCacheKeyBuilder(() => '\ud800')({})).toThrow('valid Unicode')
		expect(() => createCacheKeyBuilder(() => '\udc00')({})).toThrow('valid Unicode')
		expect(createCacheKeyBuilder(() => 'emoji-😀')({})).toBe('emoji-😀')

		const cache = {
			namespace() {
				return {
					get: async() => ({name: 'Ada'}),
					load: async() => ({name: 'Grace'})
				}
			}
		}
		const bound = bindCacheNamespace(cache as never, definition)
		expect(bound).not.toHaveProperty('cache')
		expect(await bound.get('1')).toEqual({name: 'Ada'})
		expect(await bound.load('1', async() => ({name: 'Grace'}))).toEqual({name: 'Grace'})
	})

	it('rejects non-deterministic or unbounded key-part structures before hashing', () => {
		const build = createCacheKeyBuilder('safe')
		let getterCalls = 0
		const accessor = Object.defineProperty({}, 'secret', {
			enumerable: true,
			get() { getterCalls++; return 'value' }
		})
		expect(() => build(accessor)).toThrow('data properties')
		expect(getterCalls).toBe(0)
		expect(() => build(null as never)).toThrow('plain object')
		expect(() => build({id: 1n})).toThrow('JSON-compatible')
		expect(() => build({value: Number.NaN})).toThrow('finite numbers')
		expect(() => build({value: undefined})).toThrow('JSON-compatible')
		expect(() => build({value: new Date()})).toThrow('plain objects')
		expect(() => build({items: new Array(1)})).toThrow('sparse arrays')
		const circular: {self?: unknown} = {}
		circular.self = circular
		expect(() => build(circular)).toThrow('circular references')
		let deep: Record<string, unknown> = {}
		for (let index = 0; index < 34; index++) deep = {child: deep}
		expect(() => build(deep)).toThrow('depth limit')
		expect(() => build({value: 'x'.repeat((1024 * 1024) + 1)})).toThrow('byte limit')
		expect(() => build({value: '\0'.repeat(200_000)})).toThrow('byte limit')
		expect(() => createCacheKeyBuilder(1 as never)).toThrow('string or function')
		expect(() => createCacheKeyBuilder('x'.repeat((1024 * 1024) + 1))).toThrow('prefix exceeds the byte limit')

		const custom = vi.fn((parts: Readonly<Record<string, unknown>>) => {
			expect(Object.isFrozen(parts)).toBe(true)
			expect(Object.isFrozen(parts.nested)).toBe(true)
			return 'custom-safe'
		})
		expect(createCacheKeyBuilder(custom)({nested: {id: 1}})).toBe('custom-safe')
		expect(custom).toHaveBeenCalledOnce()
	})

	it('validates namespace definitions without evaluating defaults accessors', () => {
		let getterCalls = 0
		const accessor = Object.defineProperty({}, 'ttlMs', {
			enumerable: true,
			get() { getterCalls++; return 100 }
		})
		expect(() => defineCacheNamespace('users', accessor as never)).toThrow('data properties')
		expect(getterCalls).toBe(0)
		expect(() => defineCacheNamespace('')).toThrow('1-256 safe characters')
		expect(() => defineCacheNamespace('bad\nnamespace')).toThrow('safe characters')
		expect(() => defineCacheNamespace('\ud800')).toThrow('invalid Unicode')
		expect(() => defineCacheNamespace('users', {ttlMs: 0})).toThrow('milliseconds')
		expect(() => defineCacheNamespace('users', {slidingTtl: true} as never)).toThrow('unexpected fields')
		expect(() => defineCacheNamespace('users', {staleTtlMs: 10})).toThrow('requires ttlMs')
		expect(() => defineCacheNamespace('users', {unknown: true} as never)).toThrow('unexpected fields')
		expect(() => defineCacheNamespace('users', null as never)).toThrow('plain object')
		let definitionGetterCalls = 0
		const forged = Object.defineProperty({}, 'name', {
			enumerable: true,
			get() { definitionGetterCalls++; return 'users' }
		})
		expect(() => bindCacheNamespace({} as never, forged as never)).toThrow('invalid or unexpected fields')
		expect(definitionGetterCalls).toBe(0)
	})

	it('captures namespace helpers once and rejects accessor-backed cache methods', async() => {
		const originalGet = vi.fn(async() => 'stable')
		const replacementGet = vi.fn(async() => 'rewired')
		const originalLoad = vi.fn(async() => 'loaded')
		const replacementLoad = vi.fn(async() => 'rewired-load')
		const scoped = {get: originalGet, load: originalLoad}
		const cache = {namespace: vi.fn(() => scoped)}
		const bound = bindCacheNamespace(cache as never, defineCacheNamespace<string>('stable'))
		scoped.get = replacementGet
		scoped.load = replacementLoad

		await expect(bound.get('key')).resolves.toBe('stable')
		await expect(bound.load('key', async() => 'source')).resolves.toBe('loaded')
		expect(replacementGet).not.toHaveBeenCalled()
		expect(replacementLoad).not.toHaveBeenCalled()

		let accesses = 0
		const hostile = Object.defineProperty({}, 'namespace', {
			get() { accesses++; return vi.fn() }
		})
		expect(() => bindCacheNamespace(hostile as never, defineCacheNamespace('hostile')))
			.toThrow('must provide a namespace method')
		expect(accesses).toBe(0)
	})

	it('does not allow bound helpers to escape their cache namespace or version', async() => {
		const get = vi.fn(async() => 'safe')
		const load = vi.fn(async(_key: string, loader: () => Promise<string>) => await loader())
		const cache = {namespace: vi.fn(() => ({get, load}))}
		const bound = bindCacheNamespace(cache as never, defineCacheNamespace<string>('tenant-a', {version: 'v1'}))

		await bound.get('key', {namespace: 'tenant-b', version: 'v9'} as never)
		await bound.load('key', async() => 'safe', {
			namespace: 'tenant-b', version: 'v9', ttlMs: 100
		} as never)

		expect(get).toHaveBeenCalledWith('key')
		expect(load).toHaveBeenCalledWith('key', expect.any(Function), {ttlMs: 100})
	})

	it('does not execute Proxy traps while traversing cache adapter prototypes', () => {
		const descriptor = vi.fn(() => undefined)
		const cache = Object.create(new Proxy({}, {getOwnPropertyDescriptor: descriptor}))

		expect(() => bindCacheNamespace(cache, defineCacheNamespace('safe'))).toThrow(
			'Cache service must provide a namespace method'
		)
		expect(descriptor).not.toHaveBeenCalled()
	})

	it('covers bounded namespace and structured-key edge contracts', () => {
		expect(defineCacheNamespace('users', {
			namespace: 'tenant', version: 'v2', ttlMs: 100, staleTtlMs: 10,
			negativeTtlMs: 20, staleIfError: true
		}).defaults).toMatchObject({version: 'v2'})
		expect(defineCacheNamespace('users', {namespace: 'tenant'}).defaults).not.toHaveProperty('namespace')
		expect(() => defineCacheNamespace('users', {version: 1 as never})).toThrow('must be a string')
		expect(() => defineCacheNamespace('users', {staleIfError: 'yes' as never})).toThrow('boolean')
		expect(() => defineCacheNamespace('\udc00')).toThrow('invalid Unicode')

		const build = createCacheKeyBuilder('structured')
		expect(build({items: [null, true, 1, 'value']})).toMatch(/^structured:items:/u)
		expect(() => build({item: new (class Item {})()})).toThrow('plain objects')
		expect(() => build(Object.defineProperty({}, 'hidden', {value: 1}))).toThrow('enumerable')
		expect(() => build({items: Object.assign([1], {extra: true})})).toThrow('custom properties')
		expect(() => build({[Symbol('secret')]: 1} as never)).toThrow('symbol keys')
		expect(() => createCacheKeyBuilder(() => 'x'.repeat(257))({})).toThrow('1-256')
		expect(() => createCacheKeyBuilder(() => 1 as never)({})).toThrow('1-256')
		expect(() => bindCacheNamespace({} as never, null as never)).toThrow('must be an object')
		expect(() => bindCacheNamespace({} as never, [] as never)).toThrow('must be an object')
	})
})
