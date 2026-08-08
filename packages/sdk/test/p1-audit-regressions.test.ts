import {afterEach, describe, expect, it, vi} from 'vitest'

vi.mock('web-vitals', () => ({
	onLCP: vi.fn(), onINP: vi.fn(), onCLS: vi.fn(), onFCP: vi.fn(), onTTFB: vi.fn()
}))

const faroInit = vi.hoisted(() => vi.fn(() => ({api: {}})))
vi.mock('@grafana/faro-web-sdk', () => ({
	initializeFaro: faroInit,
	getWebInstrumentations: vi.fn(() => []),
	LogLevel: {TRACE: 'trace', DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error'}
}))

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('sdk P1 audit regressions', () => {
	it('bounds branching callback re-entry per root invocation', async() => {
		const {captureSingleFlightCallback} = await import('../src/callback-flight')
		let calls = 0
		let callback: () => unknown
		callback = captureSingleFlightCallback((() => {
			calls += 1
			callback()
			callback()
			return {}
		}) as (...args: never[]) => unknown) as () => unknown

		callback()

		expect(calls).toBe(100)
	})

	it('rejects cache input Proxies without executing reflection traps', async() => {
		const {bindCacheNamespace, createCacheKeyBuilder, defineCacheNamespace} = await import('../src/cache')
		const trap = vi.fn(() => { throw new Error('trap executed') })
		const handler: ProxyHandler<object> = {
			getPrototypeOf: trap,
			getOwnPropertyDescriptor: trap,
			ownKeys: trap
		}

		expect(() => createCacheKeyBuilder('safe')(new Proxy({}, handler))).toThrow('plain object')
		expect(() => createCacheKeyBuilder('safe')({nested: new Proxy({}, handler)})).toThrow('JSON-compatible')
		expect(() => defineCacheNamespace('safe', new Proxy({}, handler))).toThrow('plain object')
		expect(() => bindCacheNamespace({} as never, new Proxy({}, handler) as never)).toThrow('must be an object')
		expect(trap).not.toHaveBeenCalled()
	})

	it('rejects oversized reflected key sets before materializing property descriptors', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const [
			{defineCacheNamespace}, {defineEvent}, {initFaroBrowser, startFaroBrowserObservers},
			{recordPerformanceMetric}, {measurePageLoad}, {measurePgQuery}
		] = await Promise.all([
			import('../src/cache'), import('../src/events'), import('../src/faro-browser'),
			import('../src/performance'), import('../src/performance-browser'), import('../src/performance-db')
		])
		const keys = Array.from({length: 2_000}, (_value, index) => `field${index}`)
		let descriptorReads = 0
		const oversized = new Proxy({}, {
			ownKeys: () => keys,
			getOwnPropertyDescriptor() {
				descriptorReads += 1
				return undefined
			}
		})

		expect(() => defineEvent(oversized as never)).toThrow('SDK_EVENT_DEFINITION_INVALID')
		expect(() => defineCacheNamespace('safe', oversized as never)).toThrow('unexpected fields')
		expect(() => initFaroBrowser(oversized as never)).toThrow('SDK_FARO_INIT_OPTIONS_INVALID')
		expect(() => startFaroBrowserObservers(oversized as never)).toThrow('SDK_FARO_INIT_OPTIONS_INVALID')
		recordPerformanceMetric({record: vi.fn()}, 'metric', 1, oversized as never)
		measurePageLoad({route: '/', now: () => 1, labels: oversized as never, performance: {record: vi.fn()}})
		await measurePgQuery(async() => [], {
			text: 'select 1', labels: oversized as never,
			performance: {measureDBQuery: async(_name, operation) => await operation()}
		})
		expect(descriptorReads).toBe(0)

		let arrayDescriptorReads = 0
		const oversizedArray = new Proxy([], {
			ownKeys: () => ['length', ...keys],
			getOwnPropertyDescriptor(target, key) {
				arrayDescriptorReads += 1
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		expect(() => defineEvent({
			type: 'document.created', source: 'suite', schema: {parse: (value: unknown) => value}, tags: oversizedArray
		})).toThrow('SDK_EVENT_TAGS_INVALID')
		expect(arrayDescriptorReads).toBe(1)
	})

	it('bounds nested cache Proxy re-entry before prototype classification in fallback runtimes', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {createCacheKeyBuilder} = await import('../src/cache')
		let traps = 0
		let proxy: object
		proxy = new Proxy({}, {
			getPrototypeOf() {
				traps += 1
				if (traps < 500) {
					try { createCacheKeyBuilder('nested')({value: proxy}) } catch { /* bounded fallback reflection */ }
				}
				return Object.prototype
			}
		})

		expect(createCacheKeyBuilder('root')({value: proxy})).toMatch(/^root:value:/u)
		expect(traps).toBeGreaterThan(0)
		expect(traps).toBeLessThanOrEqual(100)
	})

	it('does not reflect on Proxy values thrown by cache definition traps', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {bindCacheNamespace} = await import('../src/cache')
		let errorPrototypeReads = 0
		const thrown = new Proxy({}, {
			getPrototypeOf() {
				errorPrototypeReads += 1
				return null
			}
		})
		const definition = new Proxy({}, {
			ownKeys() { throw thrown }
		})

		expect(() => bindCacheNamespace({} as never, definition as never)).toThrow(
			'Cache namespace definition contains invalid or unexpected fields'
		)
		expect(errorPrototypeReads).toBe(0)
	})

	it('bounds definition Proxy re-entry when native Proxy detection is unavailable', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {defineEvent} = await import('../src/events')
		const target = {type: 'document.created', source: 'suite', schema: {parse: (value: unknown) => value}}
		let traps = 0
		let options: object
		options = new Proxy(target, {
			getPrototypeOf(current) {
				traps += 1
				if (traps < 500) {
					try { defineEvent(options as never) } catch { /* the shared reflection cap terminates excess siblings */ }
					try { defineEvent(options as never) } catch { /* the shared reflection cap terminates excess siblings */ }
				}
				return Reflect.getPrototypeOf(current)
			}
		})

		const definition = defineEvent(options as never)

		expect(definition.type).toBe('document.created')
		expect(traps).toBe(100)
	})

	it('does not invoke dense-array length getters in fallback runtimes', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {defineConsumer} = await import('../src/events')
		const read = vi.fn()
		const eventTypes = new Proxy(['document.created'], {
			get(target, key, receiver) {
				read(key)
				return Reflect.get(target, key, receiver)
			}
		})

		const consumer = defineConsumer({name: 'indexer', eventTypes})

		expect(consumer.eventTypes).toEqual(['document.created'])
		expect(read).not.toHaveBeenCalled()
	})

	it('bounds custom cache-key callback re-entry', async() => {
		const {createCacheKeyBuilder} = await import('../src/cache')
		let calls = 0
		let build: ReturnType<typeof createCacheKeyBuilder>
		build = createCacheKeyBuilder(() => {
			calls += 1
			if (calls < 500) {
				try { build({id: 1}) } catch { /* the root budget rejects excess siblings */ }
				try { build({id: 1}) } catch { /* the root budget rejects excess siblings */ }
			}
			return 'safe-key'
		})

		expect(build({id: 1})).toBe('safe-key')
		expect(calls).toBeGreaterThan(0)
		expect(calls).toBeLessThanOrEqual(100)
	})

	it('preserves independent concurrent cache method calls beyond the re-entry budget', async() => {
		const {bindCacheNamespace, defineCacheNamespace} = await import('../src/cache')
		const resolvers: Array<(value: string) => void> = []
		const get = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve) }))
		const scoped = {get, load: vi.fn()}
		const cache = {namespace: vi.fn(() => scoped)}
		const bound = bindCacheNamespace(cache as never, defineCacheNamespace<string>('documents'))

		const pending = Array.from({length: 1_000}, (_value, index) => bound.get(`key-${index}`))
		expect(get).toHaveBeenCalledTimes(1_000)
		for (const [index, resolve] of resolvers.entries()) resolve(`value-${index}`)
		await expect(Promise.all(pending)).resolves.toEqual(
			Array.from({length: 1_000}, (_value, index) => `value-${index}`)
		)
	})

	it('executes a cache loader at most once when an adapter invokes it repeatedly', async() => {
		const {bindCacheNamespace, defineCacheNamespace} = await import('../src/cache')
		const loader = vi.fn(async() => 'loaded')
		const load = vi.fn(async(_key: string, invoke: () => Promise<string>) => {
			const [first, second] = await Promise.all([invoke(), invoke()])
			return `${first}:${second}`
		})
		const bound = bindCacheNamespace(
			{namespace: () => ({get: vi.fn(), load})} as never,
			defineCacheNamespace<string>('documents')
		)

		await expect(bound.load('key', loader)).resolves.toBe('loaded:loaded')
		expect(loader).toHaveBeenCalledOnce()
	})

	it('bounds branching cache-adapter re-entry per root call', async() => {
		const {bindCacheNamespace, defineCacheNamespace} = await import('../src/cache')
		let calls = 0
		let bound: ReturnType<typeof bindCacheNamespace<string, never>>
		const get = vi.fn(() => {
			calls += 1
			if (calls < 500) {
				void bound.get('nested')
				void bound.get('nested')
			}
			return Promise.resolve('ok')
		})
		bound = bindCacheNamespace(
			{namespace: () => ({get, load: vi.fn()})} as never,
			defineCacheNamespace<string>('documents')
		)

		await expect(bound.get('root')).resolves.toBe('ok')
		expect(calls).toBe(100)
	})

	it('bounds cache namespace re-entry that recreates wrappers', async() => {
		const {bindCacheNamespace, defineCacheNamespace} = await import('../src/cache')
		const definition = defineCacheNamespace<string>('documents')
		let calls = 0
		const cache = {
			namespace() {
				calls += 1
				return bindCacheNamespace(cache as never, definition)
			}
		}

		expect(() => bindCacheNamespace(cache as never, definition)).toThrow(TypeError)
		expect(calls).toBeGreaterThan(0)
		expect(calls).toBeLessThanOrEqual(100)
	})

	it('does not treat sequential asynchronous adapter calls as synchronous re-entry', async() => {
		const {bindCacheNamespace, defineCacheNamespace} = await import('../src/cache')
		let calls = 0
		let bound: ReturnType<typeof bindCacheNamespace<string, never>>
		const get = vi.fn(async() => {
			calls += 1
			await Promise.resolve()
			return calls < 500 ? bound.get('nested') : 'unbounded'
		})
		bound = bindCacheNamespace(
			{namespace: () => ({get, load: vi.fn()})} as never,
			defineCacheNamespace<string>('documents')
		)

		await expect(bound.get('root')).resolves.toBe('unbounded')
		expect(calls).toBe(500)
	})

	it('bounds Promise-returning cache-key callbacks across failures', async() => {
		const {createCacheKeyBuilder} = await import('../src/cache')
		let calls = 0
		let build: ReturnType<typeof createCacheKeyBuilder>
		build = createCacheKeyBuilder((() => {
			calls += 1
			return Promise.resolve().then(() => {
				if (calls < 500) {
					try { build({id: 1}) } catch { /* invalid async result remains isolated */ }
				}
				return 'safe-key'
			}).catch(() => 'safe-key')
		}) as never)

		expect(() => build({id: 1})).toThrow('Cache key builders must return')
		for (let index = 0; index < 150; index++) await Promise.resolve()
		expect(calls).toBe(1)
	})

	it('bounds event-schema callback re-entry', async() => {
		const {defineEvent} = await import('../src/events')
		let calls = 0
		let definition: ReturnType<typeof defineEvent>
		definition = defineEvent({
			type: 'document.created', source: 'suite',
			schema: {parse(value: unknown) {
				calls += 1
				definition.schema.parse(value)
				return value
			}}
		})

		expect(definition.schema.parse('ok')).toBe('ok')
		expect(calls).toBe(100)
	})

	it('bounds event-schema re-entry that recreates definitions', async() => {
		const {defineEvent} = await import('../src/events')
		let calls = 0
		const schema = {
			parse(value: unknown): unknown {
				calls += 1
				return defineEvent({type: 'document.created', source: 'suite', schema}).schema.parse(value)
			}
		}
		const definition = defineEvent({type: 'document.created', source: 'suite', schema})

		expect(() => definition.schema.parse('ok')).toThrow(TypeError)
		expect(calls).toBeGreaterThan(0)
		expect(calls).toBeLessThanOrEqual(100)
	})

	it('bounds Zod schema Proxy re-entry in fallback runtimes', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const [{createZodEventSchema}, {z}] = await Promise.all([
			import('../src/events-zod'), import('zod')
		])
		let traps = 0
		let adapted: ReturnType<typeof createZodEventSchema>
		const schema = new Proxy(z.string(), {
			get(target, key, receiver) {
				if (key === '_zod') {
					traps += 1
					try { adapted.parse('ok') } catch { /* the shared Zod flight terminates the innermost call */ }
				}
				return Reflect.get(target, key, receiver)
			}
		})
		adapted = createZodEventSchema(schema)

		expect(adapted.parse('ok')).toBe('ok')
		expect(traps).toBe(100)
	})

	it('bounds fetch-option Proxy re-entry in fallback runtimes', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {instrumentFetchHandler} = await import('../src/performance')
		const handler = vi.fn(async() => ({status: 200}))
		let traps = 0
		let options: object
		options = new Proxy({route: '/'}, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'route') {
					traps += 1
					if (traps < 500) {
						instrumentFetchHandler(handler, options as never)
						instrumentFetchHandler(handler, options as never)
					}
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		const wrapped = instrumentFetchHandler(handler, options as never)
		await expect(wrapped({})).resolves.toEqual({status: 200})

		expect(traps).toBe(100)
		expect(handler).toHaveBeenCalledOnce()
	})

	it('rejects unterminated deep performance prototype chains', async() => {
		const {instrumentFetchHandler} = await import('../src/performance')
		const measureRequest = vi.fn(async(_name: string, fn: () => Promise<unknown>) => await fn())
		let prototype: object | null = null
		for (let depth = 0; depth < 33; depth += 1) prototype = Object.create(prototype)
		const performance = Object.assign(Object.create(prototype), {measureRequest})
		const operation = vi.fn(async() => ({status: 200}))

		await expect(instrumentFetchHandler(operation, {route: '/', performance})({})).resolves.toEqual({status: 200})

		expect(operation).toHaveBeenCalledOnce()
		expect(measureRequest).not.toHaveBeenCalled()
	})

	it('bounds database-option Proxy re-entry in fallback runtimes', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {measurePgQuery} = await import('../src/performance-db')
		const operation = vi.fn(async() => 'ok')
		const pending: Array<Promise<unknown>> = []
		let traps = 0
		let options: object
		options = new Proxy({text: 'select * from documents'}, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'text') {
					traps += 1
					pending.push(measurePgQuery(operation, options as never))
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		await measurePgQuery(operation, options as never)
		await Promise.all(pending)

		expect(traps).toBe(100)
		expect(operation).toHaveBeenCalledTimes(101)
	})

	it('reserves instrumentation capacity before invoking a re-entrant adapter', async() => {
		const {capturePerformanceMethod} = await import('../src/performance-port-method')
		let captured: ((...args: never[]) => unknown) | undefined
		let calls = 0
		const port = {
			measureAsync() {
				calls += 1
				if (calls < 500) {
					captured?.('metric' as never)
					captured?.('metric' as never)
				}
			}
		}
		captured = capturePerformanceMethod(port as never, 'measureAsync')

		captured?.('metric' as never)
		expect(calls).toBe(100)

		// Primitive-returning calls release their reservation after unwinding.
		calls = 0
		captured?.('metric' as never)
		expect(calls).toBe(100)
	})

	it('snapshots Faro init configuration without invoking accessors', async() => {
		vi.resetModules()
		faroInit.mockClear()
		const readUrl = vi.fn(() => 'https://attacker.example/collect')
		const config = Object.defineProperty({app: {name: 'studio'}}, 'url', {
			enumerable: true,
			get: readUrl
		})
		const {initFaroBrowser} = await import('../src/faro-browser')

		expect(() => initFaroBrowser({config} as never)).toThrow('SDK_FARO_INIT_OPTIONS_INVALID')
		expect(readUrl).not.toHaveBeenCalled()
		expect(faroInit).not.toHaveBeenCalled()
	})

	it('bounds Faro init Proxy re-entry in browser fallback mode', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		faroInit.mockClear()
		const {initFaroBrowser} = await import('../src/faro-browser')
		const target = {config: {url: 'https://faro.example/collect', app: {name: 'studio'}}}
		let traps = 0
		let options: object
		options = new Proxy(target, {
			getOwnPropertyDescriptor(current, key) {
				if (key === 'config') {
					traps += 1
					try { initFaroBrowser(options as never) } catch { /* the depth cap rejects only the innermost call */ }
				}
				return Reflect.getOwnPropertyDescriptor(current, key)
			}
		})

		initFaroBrowser(options as never)

		expect(traps).toBe(100)
		expect(faroInit).toHaveBeenCalledOnce()
	})

	it('rejects object-valued Faro scalars without invoking toJSON', async() => {
		vi.resetModules()
		faroInit.mockClear()
		const toJSON = vi.fn(() => 'https://attacker.example/collect')
		const {initFaroBrowser} = await import('../src/faro-browser')

		expect(() => initFaroBrowser({
			config: {url: {toJSON}, app: {name: 'studio'}}
		} as never)).toThrow('SDK_FARO_INIT_OPTIONS_INVALID')
		expect(toJSON).not.toHaveBeenCalled()
		expect(faroInit).not.toHaveBeenCalled()
	})

	it('does not execute Faro attribute accessors, Proxy traps, or nested toJSON hooks', async() => {
		const {captureFaroBrowserError, captureFaroBrowserEvent, createFaroBrowserPerformancePort} = await import('../src/faro-browser')
		const pushEvent = vi.fn()
		const pushError = vi.fn()
		const client = {api: {pushError, pushEvent}}
		const trap = vi.fn(() => { throw new Error('trap executed') })
		const hostileLabels = new Proxy({}, {ownKeys: trap})
		const toJSON = vi.fn(() => ({token: 'private'}))

		createFaroBrowserPerformancePort(client as never).record?.('metric', 1, hostileLabels as never)
		captureFaroBrowserEvent(client as never, {name: 'event', attributes: {nested: {toJSON}}})
		captureFaroBrowserError(client as never, new Proxy({}, {getPrototypeOf: trap}))

		expect(trap).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
		expect(JSON.stringify(pushEvent.mock.calls)).not.toContain('private')
	})

	it('bounds Faro performance-label Proxy re-entry in browser fallback mode', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {createFaroBrowserPerformancePort} = await import('../src/faro-browser')
		const port = createFaroBrowserPerformancePort({api: {pushEvent: vi.fn()}} as never)
		let traps = 0
		let labels: object
		labels = new Proxy({}, {
			ownKeys() {
				traps += 1
				port.record?.('nested', 1, labels as never)
				return []
			}
		})

		port.record?.('initial', 1, labels as never)

		expect(traps).toBe(100)

		const pending: Array<Promise<unknown>> = []
		traps = 0
		labels = new Proxy({}, {
			ownKeys() {
				traps += 1
				pending.push(port.measureAsync?.('nested', async() => 'ok', labels as never) as Promise<unknown>)
				return []
			}
		})
		await port.measureAsync?.('initial', async() => 'ok', labels as never)
		await Promise.all(pending)

		expect(traps).toBe(100)
	})

	it('does not execute direct Faro event Proxy get traps', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {captureFaroBrowserEvent} = await import('../src/faro-browser')
		const client = {api: {pushEvent: vi.fn()}}
		let traps = 0
		let event: object
		event = new Proxy({}, {
			get(_target, key) {
				if (key === 'name') {
					traps += 1
					captureFaroBrowserEvent(client as never, event as never)
				}
				return undefined
			}
		})

		captureFaroBrowserEvent(client as never, event as never)

		expect(traps).toBe(0)
		expect(client.api.pushEvent).not.toHaveBeenCalled()
	})

	it('bounds Faro observer-wrapper Proxy reflection before option snapshotting', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {startFaroBrowserObservers} = await import('../src/faro-browser')
		const stops: Array<() => void> = []
		let traps = 0
		let options: object
		const target = {
			client: {api: {pushEvent: vi.fn()}},
			preset: 'custom', webVitals: false, longTasks: false, resourceFailures: false
		}
		options = new Proxy(target, {
			ownKeys() {
				traps += 1
				stops.push(startFaroBrowserObservers(options as never))
				return Reflect.ownKeys(target)
			}
		})

		stops.push(startFaroBrowserObservers(options as never))

		expect(traps).toBe(100)
		for (const stop of stops) stop()
	})

	it('bounds synchronous Faro delivery re-entry', async() => {
		const {createFaroBrowserPerformanceBridge} = await import('../src/faro-browser')
		let bridge: ReturnType<typeof createFaroBrowserPerformanceBridge>
		let calls = 0
		const client = {api: {
			pushEvent() {
				calls += 1
				if (calls < 500) bridge.captureCustomEvent('nested')
			}
		}}
		bridge = createFaroBrowserPerformanceBridge(client as never)

		bridge.captureCustomEvent('initial')

		expect(calls).toBe(100)
	})

	it('reserves lifecycle dedupe before Faro delivery and rolls back failed attempts', async() => {
		const {createFaroBrowserPerformanceBridge} = await import('../src/faro-browser')
		let bridge: ReturnType<typeof createFaroBrowserPerformanceBridge>
		let calls = 0
		let fail = false
		const client = {api: {pushEvent(name: 'browser.page_load' | 'browser.navigation') {
			calls += 1
			if (fail) throw new Error('unavailable')
			bridge.captureLifecycleEvent(name)
		}}}
		bridge = createFaroBrowserPerformanceBridge(client as never)

		bridge.captureLifecycleEvent('browser.page_load')
		expect(calls).toBe(1)

		const failing = createFaroBrowserPerformanceBridge(client as never, {dedupeLifecycleEvents: true})
		bridge = failing
		fail = true
		expect(() => failing.captureLifecycleEvent('browser.navigation')).toThrow('unavailable')
		fail = false
		failing.captureLifecycleEvent('browser.navigation')
		expect(calls).toBe(3)
	})

	it('does not execute Faro bridge-option Proxy get traps and snapshots dedupe configuration', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {createFaroBrowserPerformanceBridge} = await import('../src/faro-browser')
		const client = {api: {pushEvent: vi.fn()}}
		let traps = 0
		let options: object
		options = new Proxy({dedupeLifecycleEvents: true}, {
			get(target, key, receiver) {
				if (key === 'dedupeLifecycleEvents') {
					traps += 1
					try { createFaroBrowserPerformanceBridge(client as never, options as never) } catch { /* capped */ }
				}
				return Reflect.get(target, key, receiver)
			}
		})

		const bridge = createFaroBrowserPerformanceBridge(client as never, options as never)
		bridge.captureLifecycleEvent('browser.page_load')
		bridge.captureLifecycleEvent('browser.page_load')

		expect(traps).toBe(0)
		expect(client.api.pushEvent).toHaveBeenCalledOnce()
	})

	it('never emits credentials, queries, or dynamic ids from server routes', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const names: string[] = []
		const {instrumentFetchHandler} = await import('../src/performance')
		const handler = instrumentFetchHandler(async() => ({status: 200}), {
			route: 'https://user:password@example.com/projects/123?token=private#details',
			name: 'http.request?token=private',
			hostKind: 'tenant-123',
			runtime: 'node?token=private',
			performance: {measureRequest: async(name, operation, current) => {
				names.push(name)
				metadata.push(current)
				return await operation()
			}}
		})

		await handler({})

		expect(metadata[0]?.route).toBe('/redacted')
		expect(metadata[0]).not.toHaveProperty('hostKind')
		expect(metadata[0]).not.toHaveProperty('runtime')
		expect(names).toEqual(['http.request'])
		expect(JSON.stringify(metadata)).not.toMatch(/password|token|private|123/u)
	})

	it('does not emit dynamic database identifiers derived from queries', async() => {
		const {measurePgQuery} = await import('../src/performance-db')
		const metadata: Array<Record<string, unknown>> = []
		await measurePgQuery(async() => [], {
			text: 'select * from tenant_12345 where secret = $1',
			performance: {measureDBQuery: async(_name, operation, current) => {
				metadata.push(current)
				return await operation()
			}}
		})

		expect(metadata[0]).not.toHaveProperty('table')
		expect(metadata[0]).not.toHaveProperty('collection')
		expect(metadata[0]).toHaveProperty('queryHash')
		expect(JSON.stringify(metadata)).not.toContain('12345')
	})

	it('does not emit caller-controlled request methods as telemetry dimensions', async() => {
		const metadata: Array<Record<string, unknown>> = []
		const {instrumentFetchHandler} = await import('../src/performance')
		const handler = instrumentFetchHandler(async() => ({status: 200}), {
			route: '/health',
			performance: {measureRequest: async(_name, operation, current) => {
				metadata.push(current)
				return await operation()
			}}
		})

		await handler({method: 'Bearer private-token'})

		expect(metadata[0]?.method).toBe('UNKNOWN')
		expect(JSON.stringify(metadata)).not.toContain('private-token')
	})

	it('snapshots fetch labels without executing accessors and bounds their values', async() => {
		const delivered: unknown[] = []
		const getter = vi.fn(() => 'private')
		const hostile = Object.defineProperty({safe_key: 'x'.repeat(1_000)}, 'token', {
			enumerable: true,
			get: getter
		})
		const {instrumentFetchHandler} = await import('../src/performance')
		const handler = instrumentFetchHandler(async() => ({status: 200}), {
			route: '/health',
			labels: hostile as never,
			performance: {measureRequest: async(_name, operation, _metadata, labels) => {
				delivered.push(labels)
				return await operation()
			}}
		})

		await handler({})

		expect(getter).not.toHaveBeenCalled()
		expect(delivered).toEqual([{safe_key: 'x'.repeat(256)}])
	})

	it('rejects executable or query-like DB dimensions before telemetry delivery', async() => {
		const readOperation = vi.fn(() => 'select')
		const operation = Object.defineProperty({length: 6}, 'toLowerCase', {get: readOperation})
		const calls: Array<[string, Record<string, unknown>]> = []
		const {measurePrismaQuery} = await import('../src/performance-db')

		await expect(measurePrismaQuery(async() => 'ok', {
			action: operation,
			model: 'users?token=private',
			name: 'db.query?token=private',
			rows: -1,
			performance: {measureDBQuery: async(name, work, metadata) => {
				calls.push([name, metadata ?? {}])
				return await work()
			}}
		} as never)).resolves.toBe('ok')

		expect(readOperation).not.toHaveBeenCalled()
		expect(calls).toEqual([['db.query', {success: true}]])
	})

	it('bounds DB telemetry labels before adapter delivery', async() => {
		const delivered: Array<Record<string, string> | undefined> = []
		const {measurePrismaQuery} = await import('../src/performance-db')

		await measurePrismaQuery(async() => 'ok', {
			action: 'findMany',
			labels: {tenant: 'x'.repeat(1_000), token: 'private', request_id: 'customer-123'},
			performance: {measureDBQuery: async(_name, work, _metadata, labels) => {
				delivered.push(labels)
				return await work()
			}}
		})

		expect(delivered).toEqual([{tenant: 'x'.repeat(256), driver: 'prisma'}])
	})

	it('reserves direct browser observer capacity before fallback Proxy inspection', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const constructs = vi.fn()
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor() { constructs() }
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		const {observeLongTasks} = await import('../src/performance-browser')
		const stops: Array<() => void> = []
		let reentered = false
		const hostile = new Proxy({}, {
			getOwnPropertyDescriptor() {
				if (!reentered) {
					reentered = true
					for (let index = 0; index < 100; index++) {
						stops.push(observeLongTasks({route: '/'}))
					}
				}
				return undefined
			}
		})

		stops.push(observeLongTasks(hostile))

		expect(constructs).toHaveBeenCalledTimes(100)
		for (const stop of stops) stop()
	})

	it('bounds recursively re-entrant observer option reflection', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		const {observeLongTasks} = await import('../src/performance-browser')
		const stops: Array<() => void> = []
		let calls = 0
		let hostile: object
		hostile = new Proxy({}, {
			getOwnPropertyDescriptor() {
				calls += 1
				if (calls < 500) stops.push(observeLongTasks(hostile))
				return undefined
			}
		})

		stops.push(observeLongTasks(hostile))

		expect(calls).toBeLessThanOrEqual(500)
		for (const stop of stops) stop()
	})

	it('reserves aggregate observer starts before option reflection', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {startBrowserObservers} = await import('../src/performance-browser')
		const stops: Array<() => void> = []
		let reads = 0
		let hostile: object
		hostile = new Proxy({}, {
			getOwnPropertyDescriptor(_target, key) {
				reads += 1
				if (reads < 5_000) {
					try { stops.push(startBrowserObservers(hostile as never)) } catch { /* invalid nested setup is bounded */ }
				}
				const values: Record<PropertyKey, unknown> = {
					preset: 'custom', webVitals: false, longTasks: false, resourceFailures: false
				}
				return {configurable: true, enumerable: true, value: values[key], writable: true}
			}
		})

		stops.push(startBrowserObservers(hostile as never))

		expect(reads).toBeLessThan(5_000)
		for (const stop of stops) stop()
	})

	it('suppresses synchronous observer-sink re-entry', async() => {
		vi.resetModules()
		let callback: ((list: {getEntries(): Array<{duration: number}>}) => void) | undefined
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor(current: typeof callback) { callback = current }
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		const {observeLongTasks} = await import('../src/performance-browser')
		let calls = 0
		const list = {getEntries: () => [{duration: 1}]}
		const stop = observeLongTasks({
			route: '/',
			recordEvent() {
				calls += 1
				if (calls < 500) callback?.(list)
			}
		})

		callback?.(list)

		expect(calls).toBe(100)
		stop()
	})

	it('bounds synchronous page-load clock re-entry', async() => {
		const {measurePageLoad} = await import('../src/performance-browser')
		let reads = 0
		const options = {
			route: '/',
			now() {
				reads += 1
				measurePageLoad(options)
				return 1
			}
		}

		measurePageLoad(options)

		expect(reads).toBe(100)
	})

	it('bounds async browser-measurement Proxy re-entry before option reflection', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {measureNavigation} = await import('../src/performance-browser')
		const pending: Array<Promise<unknown>> = []
		const operation = vi.fn(async() => 'ok')
		let traps = 0
		let options: object
		options = new Proxy({route: '/'}, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'performance') {
					traps += 1
					pending.push(measureNavigation(operation, options as never))
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		await measureNavigation(operation, options as never)
		await Promise.all(pending)

		expect(traps).toBe(100)
		expect(operation).toHaveBeenCalledTimes(101)
	})

	it('bounds browser performance-method Proxy reflection in fallback runtimes', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {measureNavigation} = await import('../src/performance-browser')
		const operation = vi.fn(async() => 'ok')
		const pending: Array<Promise<unknown>> = []
		let traps = 0
		let performance: object
		performance = new Proxy({
			measureAsync: async(_name: string, fn: () => Promise<unknown>) => await fn()
		}, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'measureAsync') {
					traps += 1
					pending.push(measureNavigation(operation, {route: '/', performance: performance as never}))
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		await measureNavigation(operation, {route: '/', performance: performance as never})
		await Promise.all(pending)

		expect(traps).toBe(100)
		expect(operation).toHaveBeenCalledTimes(101)
	})

	it('bounds browser-label Proxy reflection in fallback runtimes', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const {measureNavigation} = await import('../src/performance-browser')
		const operation = vi.fn(async() => 'ok')
		const performance = {measureAsync: async(_name: string, fn: () => Promise<unknown>) => await fn()}
		const pending: Array<Promise<unknown>> = []
		let traps = 0
		let labels: object
		labels = new Proxy({region: 'eu'}, {
			getPrototypeOf(target) {
				traps += 1
				if (traps < 500) pending.push(measureNavigation(operation, {route: '/', performance, labels: labels as never}))
				return Reflect.getPrototypeOf(target)
			}
		})

		await measureNavigation(operation, {route: '/', performance, labels: labels as never})
		await Promise.all(pending)

		expect(traps).toBe(100)
		expect(operation).toHaveBeenCalledTimes(101)
	})

	it('bounds observer re-entry before entry inspection reaches a sink', async() => {
		vi.resetModules()
		let callback: ((list: {getEntries(): Array<{duration: number}>}) => void) | undefined
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor(current: typeof callback) { callback = current }
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		const {observeLongTasks} = await import('../src/performance-browser')
		let reads = 0
		const list = {getEntries: () => {
			reads += 1
			if (reads < 500) callback?.(list)
			return []
		}}
		const stop = observeLongTasks({route: '/'})

		callback?.(list)

		expect(reads).toBe(100)
		stop()
	})

	it('reserves observer capacity before browser capability getters run', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const original = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver')
		const constructs = vi.fn()
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor() { constructs() }
			observe(): void {}
			disconnect(): void {}
		}
		const {observeLongTasks} = await import('../src/performance-browser')
		const stops: Array<() => void> = []
		let reentered = false
		Object.defineProperty(globalThis, 'PerformanceObserver', {
			configurable: true,
			get() {
				if (!reentered) {
					reentered = true
					for (let index = 0; index < 100; index++) stops.push(observeLongTasks({route: '/'}))
				}
				return MockObserver
			}
		})
		try {
			stops.push(observeLongTasks({route: '/'}))
			expect(constructs).toHaveBeenCalledTimes(100)
		} finally {
			for (const stop of stops) stop()
			if (original) Object.defineProperty(globalThis, 'PerformanceObserver', original)
			else delete (globalThis as {PerformanceObserver?: unknown}).PerformanceObserver
		}
	})

	it('preserves resource observer bounds during fallback Proxy inspection', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const add = vi.fn()
		const remove = vi.fn()
		vi.stubGlobal('addEventListener', add)
		vi.stubGlobal('removeEventListener', remove)
		const {observeResourceFailures} = await import('../src/performance-browser')
		const stops: Array<() => void> = []
		let reentered = false
		const hostile = new Proxy({}, {
			getOwnPropertyDescriptor() {
				if (!reentered) {
					reentered = true
					for (let index = 0; index < 100; index++) {
						stops.push(observeResourceFailures({route: '/'}))
					}
				}
				return undefined
			}
		})

		stops.push(observeResourceFailures(hostile))

		expect(add).toHaveBeenCalledTimes(100)
		for (const stop of stops) stop()
		expect(remove).toHaveBeenCalledTimes(100)
	})

	it('removes a partially registered resource listener when setup throws', async() => {
		vi.resetModules()
		const listeners = new Set<unknown>()
		const remove = vi.fn((_type: string, listener: unknown) => { listeners.delete(listener) })
		vi.stubGlobal('addEventListener', vi.fn((_type: string, listener: unknown) => {
			listeners.add(listener)
			throw new Error('partial registration')
		}))
		vi.stubGlobal('removeEventListener', remove)
		const {observeResourceFailures} = await import('../src/performance-browser')

		const stop = observeResourceFailures({route: '/'})

		expect(listeners.size).toBe(0)
		expect(remove).toHaveBeenCalledOnce()
		expect(() => stop()).not.toThrow()
	})

	it('reserves aggregate observer capacity before fallback Proxy inspection', async() => {
		vi.resetModules()
		vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
		const intervals = vi.spyOn(globalThis, 'setInterval')
		const {startBrowserObservers} = await import('../src/performance-browser')
		const stops: Array<() => void> = []
		let reentered = false
		const hostile = new Proxy({preset: 'production'}, {
			getOwnPropertyDescriptor(target, key) {
				if (!reentered) {
					reentered = true
					for (let index = 0; index < 100; index++) {
						try {
							stops.push(startBrowserObservers({
								preset: 'production', webVitals: false, longTasks: false,
								resourceFailures: false, aggregationIntervalMs: 1_000
							}))
						} catch { /* the per-root callback budget may reject excess hostile siblings */ }
					}
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		stops.push(startBrowserObservers(hostile as never))

		expect(intervals.mock.calls.length).toBeGreaterThan(0)
		expect(intervals.mock.calls.length).toBeLessThanOrEqual(100)
		for (const stop of stops) stop()
	})
})
