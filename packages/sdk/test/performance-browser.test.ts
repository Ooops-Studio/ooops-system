import {beforeEach, describe, expect, it, vi} from 'vitest'

const webVitalsCallbacks = new Map<string, (metric: {
	name: string
	value: number
	rating?: 'good' | 'needs-improvement' | 'poor'
	navigationType?: string
}) => void>()
const failingWebVitalsSubscriptions = new Set<string>()
const webVitalsSubscriptionCounts = new Map<string, number>()

const registerWebVital = (
	name: string,
	callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never
): void => {
	webVitalsSubscriptionCounts.set(name, (webVitalsSubscriptionCounts.get(name) ?? 0) + 1)
	webVitalsCallbacks.set(name, callback)
}

vi.mock('web-vitals', () => ({
	onLCP: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		registerWebVital('LCP', callback)
	},
	onINP: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		registerWebVital('INP', callback)
	},
	onCLS: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		registerWebVital('CLS', callback)
	},
	onFCP: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		registerWebVital('FCP', callback)
	},
	onTTFB: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		if (failingWebVitalsSubscriptions.has('TTFB')) throw new Error('subscription failed')
		registerWebVital('TTFB', callback)
	}
}))

import {
	measureInteraction,
	measureNavigation,
	measurePageLoad,
	normalizeClientRoute,
	observeLongTasks as observeLongTasksDirect,
	startBrowserObservers,
	type BrowserObserverStartOptions
} from '../src/performance-browser'
import {
	classifyResourceType,
	getPerformanceObserver,
	readBrowserLocation,
	resolveResourceUrl,
	supportsEntryType
} from '../src/performance-browser-runtime'

type BrowserEventListener = (event: Event) => void
type ObserverOptions = Omit<BrowserObserverStartOptions, 'preset'>
const observeWebVitals = (options: ObserverOptions) => startBrowserObservers({
	...options, preset: 'development', longTasks: false, resourceFailures: false
})
const observeLongTasks = (options: ObserverOptions) => startBrowserObservers({
	...options, preset: 'development', webVitals: false, resourceFailures: false
})
const observeResourceFailures = (options: ObserverOptions) => startBrowserObservers({
	...options, preset: 'development', webVitals: false, longTasks: false
})

describe('browser performance helpers', () => {
	beforeEach(() => {
		failingWebVitalsSubscriptions.clear()
		vi.unstubAllGlobals()
	})

	it('normalizes browser routes', () => {
		expect(normalizeClientRoute('/projects/123?tab=overview')).toBe('/projects/:id')
		expect(normalizeClientRoute('https://studio.example.com/projects/123?tab=overview')).toBe('/projects/:id')
		expect(normalizeClientRoute('//studio.example.com/projects/123')).toBe('/projects/:id')
		expect(normalizeClientRoute('/projects/:projectId/[tab]')).toBe('/projects/:projectId/[tab]')
		expect(normalizeClientRoute('/users/alice@example.com')).toBe('/users/:id')
		expect(normalizeClientRoute('/users/alice%40example.com')).toBe('/users/:id')
		expect(normalizeClientRoute('/projects/%3Ftoken%3Dprivate')).toBe('/projects/:id')
		expect(normalizeClientRoute('/projects/secret%2Fprivate')).toBe('/projects/:id')
		expect(normalizeClientRoute('/projects/secret=private')).toBe('/projects/:id')
		expect(normalizeClientRoute('/sessions/abcdefghijklmnopqrstuvwxyz012345')).toBe('/:id/:id')
		expect(normalizeClientRoute('/projects/tenant-123')).toBe('/projects/:id')
		expect(normalizeClientRoute('/users/alice')).toBe('/users/:id')
		expect(normalizeClientRoute('/accounts/acme/settings')).toBe('/accounts/:id/:id')
		for (const route of [
			'/private-token', '/secret', '/password', '/bearer-private', '/api-key-private',
			'/private-key', '/access-key', '/key-private', '/private'
		]) {
			expect(normalizeClientRoute(route)).toBe('/:id')
		}
		expect(normalizeClientRoute(`/${Array.from({length: 150}, () => 'path').join('/')}`).length).toBeLessThanOrEqual(256)
		expect(() => normalizeClientRoute('x'.repeat(2_049))).toThrow('2048')
	})

	it('does not allow caller labels to override canonical browser dimensions', () => {
		const record = vi.fn()
		measurePageLoad({
			route: '/projects/123',
			startTime: 0,
			now: () => 10,
			labels: {runtime: 'spoofed', route: '/raw/123', kind: 'spoofed'},
			performance: {record}
		})
		expect(record).toHaveBeenCalledWith('browser.page_load', 10, expect.objectContaining({
			runtime: 'browser', route: '/projects/:id', kind: 'page_load'
		}))
		measurePageLoad({
			route: '/', startTime: 0, now: () => 1,
			labels: {
				large: 'x'.repeat(300), token: 'private', request_id: 'customer-123',
				key: 'private', bearer: 'private'
			}, performance: {record}
		})
		expect(record).toHaveBeenLastCalledWith('browser.page_load', 1, expect.objectContaining({
			large: 'x'.repeat(256)
		}))
		expect(record.mock.lastCall?.[2]).not.toHaveProperty('token')
		expect(record.mock.lastCall?.[2]).not.toHaveProperty('request_id')
		expect(JSON.stringify(record.mock.calls)).not.toContain('private')
	})

	it('snapshots observer labels before caller mutation', () => {
		const labels = {region: 'eu'}
		const record = vi.fn()
		const stop = observeWebVitals({route: '/', labels, performance: {record}})

		labels.region = 'us'
		Object.assign(labels, {tenant: 'attacker'})
		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 1})

		expect(record).toHaveBeenCalledWith(
			'browser.web_vital.lcp', 1, expect.objectContaining({region: 'eu'})
		)
		expect(record.mock.calls[0]?.[2]).not.toHaveProperty('tenant')
		stop()
	})

	it('omits dynamic browser host-kind dimensions', () => {
		const record = vi.fn()
		const stop = observeWebVitals({route: '/', hostKind: 'tenant-123', performance: {record}})

		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 1})

		expect(record.mock.calls[0]?.[2]).not.toHaveProperty('host_kind')
		stop()
	})

	it('records page-load durations with browser labels', () => {
		const calls: Array<unknown[]> = []

		measurePageLoad({
			route: '/projects/123?tab=overview',
			startTime: 25,
			now: () => 125,
			performance: {
				record: (name, value, labels) => {
					calls.push([name, value, labels])
				}
			}
		})

		expect(calls[0]).toEqual([
			'browser.page_load',
			100,
			expect.objectContaining({
				runtime: 'browser',
				route: '/projects/:id',
				kind: 'page_load'
			})
		])
	})

	it('wraps navigation and interaction timings', async() => {
		const calls: Array<unknown[]> = []
		const performance = {
			measureAsync: async(name: string, fn: () => Promise<unknown>, labels?: Record<string, string>) => {
				calls.push([name, labels])
				return await fn()
			}
		}

		const navigation = await measureNavigation(async() => 'nav', {
			route: '/projects/999',
			performance
		})
		const interaction = await measureInteraction('ui.save', async() => 'done', {
			route: '/projects/999',
			performance
		})

		expect(navigation).toBe('nav')
		expect(interaction).toBe('done')
		expect(calls[0]).toEqual([
			'browser.navigation',
			expect.objectContaining({runtime: 'browser', route: '/projects/:id', kind: 'navigation'})
		])
		expect(calls[1]).toEqual([
			'ui.save',
			expect.objectContaining({runtime: 'browser', route: '/projects/:id', kind: 'interaction'})
		])
	})

	it('isolates async measurement failures and executes browser operations exactly once', async() => {
		const operation = vi.fn(async() => 'ok')
		await expect(measureNavigation(operation, {
			route: '/', performance: {measureAsync: async() => { throw new Error('start failed') }}
		})).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledOnce()

		await expect(measureInteraction('click', operation, {
			performance: {measureAsync: async(_name, fn) => {
				await fn()
				throw new Error('finish failed')
			}}
		})).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(2)

		const labels = new Proxy({}, {ownKeys: () => { throw new Error('labels failed') }}) as Record<string, string>
		await expect(measureNavigation(operation, {route: '/', labels, performance: {measureAsync: vi.fn()}})).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(3)
		await expect(measureInteraction('click', operation, {labels, performance: {measureAsync: vi.fn()}})).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(4)

		const businessFailure = new Error('navigation failed')
		const failingOperation = vi.fn(async() => { throw businessFailure })
		await expect(measureNavigation(failingOperation, {
			route: '/', performance: {measureAsync: async(_name, fn) => await fn()}
		})).rejects.toBe(businessFailure)
		expect(failingOperation).toHaveBeenCalledOnce()

		const duplicatedOperation = vi.fn(async() => 'single-result')
		await expect(measureNavigation(duplicatedOperation, {
			route: '/',
			performance: {
				measureAsync: async(_name, fn) => {
					await fn()
					return await fn()
				}
			}
		})).resolves.toBe('single-result')
		expect(duplicatedOperation).toHaveBeenCalledOnce()

		await expect(measureNavigation(async() => 'authoritative', {
			route: '/',
			performance: {measureAsync: async(_name, fn) => { await fn(); return 'replacement' }}
		})).resolves.toBe('authoritative')
		const swallowedFailure = new Error('must propagate')
		await expect(measureNavigation(async() => { throw swallowedFailure }, {
			route: '/',
			performance: {measureAsync: async(_name, fn) => { try { await fn() } catch { return 'swallowed' } }}
		})).rejects.toBe(swallowedFailure)

		let release!: (value: string) => void
		const detachedOperation = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
		const detached = measureNavigation(detachedOperation, {
			route: '/', performance: {measureAsync: async(_name, fn) => { void fn() }}
		})
		await Promise.resolve()
		let settled = false
		void detached.then(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		release('completed')
		await expect(detached).resolves.toBe('completed')
		expect(detachedOperation).toHaveBeenCalledOnce()

		const hangingPortOperation = vi.fn(async() => 'not-blocked')
		await expect(measureNavigation(hangingPortOperation, {
			route: '/',
			performance: {measureAsync: async(_name, fn) => {
				await fn()
				return await new Promise<never>(() => {})
			}}
		})).resolves.toBe('not-blocked')
		expect(hangingPortOperation).toHaveBeenCalledOnce()

		const readThen = vi.fn(() => { throw new Error('must not assimilate') })
		const thenableOperation = vi.fn(async() => 'thenable-safe')
		await expect(measureNavigation(thenableOperation, {
			route: '/', performance: {measureAsync: ((_name, fn) => {
				void fn()
				return Object.defineProperty({}, 'then', {get: readThen})
			}) as never}
		})).resolves.toBe('thenable-safe')
		expect(thenableOperation).toHaveBeenCalledOnce()
		expect(readThen).not.toHaveBeenCalled()
	})

	it('converts synchronous operation throws into Promise rejections on fallback paths', async() => {
		const navigationFailure = new Error('navigation sync failure')
		const interactionFailure = new Error('interaction sync failure')
		let navigation: Promise<never> | undefined
		let interaction: Promise<never> | undefined

		expect(() => {
			navigation = measureNavigation((() => { throw navigationFailure }) as never, {route: '/'})
			interaction = measureInteraction('click', (() => { throw interactionFailure }) as never)
		}).not.toThrow()
		await expect(navigation).rejects.toBe(navigationFailure)
		await expect(interaction).rejects.toBe(interactionFailure)
	})

	it('does not deliver unbounded or sensitive browser metric names', async() => {
		const record = vi.fn()
		const measureAsync = vi.fn(async(_name: string, operation: () => Promise<string>) => await operation())
		const operation = vi.fn(async() => 'ok')
		for (const unsafeName of ['metric?token=private', `metric${'x'.repeat(1_000)}`]) {
			measurePageLoad({route: '/', name: unsafeName, now: () => 1, performance: {record}})
			await expect(measureNavigation(operation, {
				route: '/', name: unsafeName, performance: {measureAsync}
			})).resolves.toBe('ok')
			await expect(measureInteraction(unsafeName, operation, {performance: {measureAsync}})).resolves.toBe('ok')
		}

		expect(record).not.toHaveBeenCalled()
		expect(measureAsync).not.toHaveBeenCalled()
		expect(operation).toHaveBeenCalledTimes(4)
		expect(JSON.stringify([record.mock.calls, measureAsync.mock.calls])).not.toContain('private')
	})

	it('falls back exactly once when browser instrumentation options have hostile getters', async() => {
		const operation = vi.fn(async() => 'ok')
		const performanceOptions = {
			route: '/',
			get performance(): never { throw new Error('performance failed') }
		}
		await expect(measureNavigation(operation, performanceOptions)).resolves.toBe('ok')
		const methodAccessor = Object.defineProperty({}, 'measureAsync', {
			get: () => { throw new Error('measureAsync failed') }
		})
		await expect(measureNavigation(operation, {route: '/', performance: methodAccessor})).resolves.toBe('ok')

		const nameOptions = {
			route: '/',
			performance: {measureAsync: vi.fn()},
			get name(): string { throw new Error('name failed') }
		}
		await expect(measureNavigation(operation, nameOptions)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(3)
	})

	it('does not invoke browser option, label, or record accessors', async() => {
		const operation = vi.fn(async() => 'ok')
		const readPerformance = vi.fn(() => ({measureAsync: vi.fn()}))
		const readLabels = vi.fn(() => ({tenant: 'secret'}))
		const navigationOptions = Object.defineProperties({route: '/'}, {
			performance: {enumerable: true, get: readPerformance},
			labels: {enumerable: true, get: readLabels}
		})
		await expect(measureNavigation(operation, navigationOptions as never)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledOnce()
		expect(readPerformance).not.toHaveBeenCalled()
		expect(readLabels).not.toHaveBeenCalled()

		const readWebVitals = vi.fn(() => false)
		const readRecord = vi.fn(() => vi.fn())
		const performance = Object.defineProperty({}, 'record', {get: readRecord})
		const observerOptions = Object.defineProperty({
			preset: 'development', longTasks: false, resourceFailures: false, performance
		}, 'webVitals', {enumerable: true, get: readWebVitals})
		const stop = startBrowserObservers(observerOptions as never)
		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 10})
		stop()
		expect(readWebVitals).not.toHaveBeenCalled()
		expect(readRecord).not.toHaveBeenCalled()
	})

	it('shares one underlying Web Vitals subscription across observer lifecycles', () => {
		const before = new Map(webVitalsSubscriptionCounts)
		const record = vi.fn()
		const stops = Array.from({length: 1_000}, () => observeWebVitals({route: '/', performance: {record}}))
		for (const name of ['LCP', 'INP', 'CLS', 'FCP', 'TTFB']) {
			expect(webVitalsSubscriptionCounts.get(name)).toBe(before.get(name))
		}
		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 1})
		expect(record).toHaveBeenCalledTimes(100)
		for (const stop of stops) stop()
	})

	it('caps active long-task and resource-failure observer instances', () => {
		const construct = vi.fn()
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor() { construct() }
			observe(): void {}
			disconnect(): void {}
		}
		const add = vi.fn()
		const remove = vi.fn()
		vi.stubGlobal('PerformanceObserver', MockObserver)
		vi.stubGlobal('addEventListener', add)
		vi.stubGlobal('removeEventListener', remove)

		const longTaskStops = Array.from({length: 1_000}, () => observeLongTasksDirect({route: '/'}))
		const resourceStops = Array.from({length: 1_000}, () => observeResourceFailures({route: '/'}))
		expect(construct).toHaveBeenCalledTimes(100)
		expect(add).toHaveBeenCalledTimes(100)
		for (const stop of longTaskStops) stop()
		for (const stop of resourceStops) stop()
		expect(remove).toHaveBeenCalledTimes(100)
	})

	it('records web vitals through PerformancePort.record', () => {
		const calls: Array<unknown[]> = []
		const stop = observeWebVitals({
			route: '/projects/123?tab=overview',
			hostKind: 'studio',
			performance: {record: (name, value, labels) => calls.push([name, value, labels])}
		})

		webVitalsCallbacks.get('LCP')?.({
			name: 'LCP',
			value: 2400,
			rating: 'good',
			navigationType: 'navigate'
		})
		stop()
		webVitalsCallbacks.get('INP')?.({
			name: 'INP',
			value: 180,
			rating: 'good',
			navigationType: 'reload'
		})

		expect(calls).toEqual([
			[
				'browser.web_vital.lcp',
				2400,
				expect.objectContaining({
					runtime: 'browser',
					route: '/projects/:id',
					kind: 'web-vital',
					host_kind: 'studio',
					rating: 'good',
					navigation_type: 'navigate'
				})
			]
		])
		measurePageLoad({route: '/', performance: {record: vi.fn()}})
	})

	it('observes long tasks through PerformanceObserver', () => {
		const records: Array<unknown[]> = []
		let callback: ((list: {getEntries(): Array<{duration: number}>}) => void) | undefined

		class MockObserver {
			static supportedEntryTypes = ['longtask']

			constructor(nextCallback: typeof callback) {
				callback = nextCallback
			}

			observe(): void {}

			disconnect(): void {}
		}

		vi.stubGlobal('PerformanceObserver', MockObserver)

		const stop = observeLongTasks({
			route: '/projects/123',
			performance: {record: (name, value, labels) => records.push([name, value, labels])}
		})

		callback?.({
			getEntries: () => [{duration: 73}]
		})
		expect(() => callback?.({getEntries: () => { throw new Error('entries failed') }})).not.toThrow()

		expect(records).toEqual([
			[
				'browser.long_task',
				73,
				expect.objectContaining({
					runtime: 'browser',
					route: '/projects/:id',
					kind: 'long_task'
				})
			]
		])
		stop()
		callback?.({getEntries: () => [{duration: 100}]})
		expect(records).toHaveLength(1)
	})

	it('bounds long-task work for one observer callback', () => {
		const record = vi.fn()
		let callback: ((list: {getEntries(): Array<{duration: number}>}) => void) | undefined
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor(nextCallback: typeof callback) { callback = nextCallback }
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		const stop = observeLongTasks({route: '/', performance: {record}})

		callback?.({getEntries: () => Array.from({length: 10_000}, () => ({duration: 1}))})

		expect(record).toHaveBeenCalledTimes(256)
		stop()
	})

	it('does not execute long-task array iterators or entry accessors', () => {
		let callback: ((list: {getEntries(): Array<{duration: number}>}) => void) | undefined
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor(nextCallback: typeof callback) { callback = nextCallback }
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		const record = vi.fn()
		const stop = observeLongTasks({route: '/', performance: {record}})
		const readIterator = vi.fn()
		const readDuration = vi.fn()
		const entries = Object.defineProperties([], {
			0: {configurable: true, enumerable: true, get: readDuration},
			length: {value: 1},
			[Symbol.iterator]: {configurable: true, get: readIterator}
		}) as Array<{duration: number}>

		callback?.({getEntries: () => entries})

		expect(readIterator).not.toHaveBeenCalled()
		expect(readDuration).not.toHaveBeenCalled()
		expect(record).not.toHaveBeenCalled()
		const durationAccessor = vi.fn(() => 1)
		callback?.({getEntries: () => [Object.defineProperty({}, 'duration', {get: durationAccessor}) as {duration: number}]})
		expect(durationAccessor).not.toHaveBeenCalled()
		expect(record).not.toHaveBeenCalled()
		stop()
	})

	it('reads branded PerformanceEntry duration getters without invoking entry accessors', () => {
		let callback: ((list: {getEntries(): Array<{duration: number}>}) => void) | undefined
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor(nextCallback: typeof callback) { callback = nextCallback }
			observe(): void {}
			disconnect(): void {}
		}
		const branded = new WeakSet<object>()
		class MockPerformanceEntry {
			get duration(): number {
				if (!branded.has(this)) throw new TypeError('illegal invocation')
				return 42
			}
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		vi.stubGlobal('PerformanceEntry', MockPerformanceEntry)
		const record = vi.fn()
		const stop = observeLongTasks({route: '/', performance: {record}})
		const entry = new MockPerformanceEntry()
		branded.add(entry)

		callback?.({getEntries: () => [entry]})

		expect(record).toHaveBeenCalledWith('browser.long_task', 42, expect.any(Object))
		stop()
	})

	it('single-flights unresolved dynamic routes and custom observer sinks', () => {
		let callback: ((list: {getEntries(): Array<{duration: number}>}) => void) | undefined
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor(nextCallback: typeof callback) { callback = nextCallback }
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		const route = vi.fn(() => new Promise<string>(() => undefined))
		const recordEvent = vi.fn(() => new Promise<void>(() => undefined))
		const stop = observeLongTasksDirect({route: route as never, recordEvent: recordEvent as never})

		for (let index = 0; index < 10; index += 1) {
			callback?.({getEntries: () => Array.from({length: 16}, () => ({duration: 1}))})
		}

		expect(route).toHaveBeenCalledOnce()
		expect(recordEvent).toHaveBeenCalledOnce()
		stop()
	})

	it('rejects observer option proxies before descriptor traps run', () => {
		const descriptor = vi.fn(() => undefined)
		const options = new Proxy({}, {getOwnPropertyDescriptor: descriptor})
		expect(() => startBrowserObservers(options as never)).toThrow('Unknown browser performance preset')
		expect(descriptor).not.toHaveBeenCalled()
	})

	it('observes rejected promises returned by sync-typed browser sinks', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('sink failed')))
		try {
			measurePageLoad({
				route: '/', now: () => 1,
				performance: {record: (() => rejected) as never}
			})
			expect(speciesReads).toBeGreaterThan(0)
		} finally {
			await rejected.catch(() => undefined)
		}
	})

	it('observes rejected promises returned by browser setup and teardown capabilities', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('runtime failed')))
		class MockObserver {
			static supportedEntryTypes = ['longtask']
			constructor(_callback: unknown) {}
			observe = (() => rejected) as never
			disconnect = (() => rejected) as never
		}
		vi.stubGlobal('PerformanceObserver', MockObserver)
		vi.stubGlobal('addEventListener', (() => rejected) as never)
		vi.stubGlobal('removeEventListener', (() => rejected) as never)
		try {
			const stopLongTasks = observeLongTasks({route: '/'})
			const stopResources = observeResourceFailures({route: '/'})
			stopLongTasks()
			stopResources()
			expect(speciesReads).toBeGreaterThanOrEqual(4)
		} finally {
			await rejected.catch(() => undefined)
		}
	})

	it('observes rejected promises exposed as browser capability methods', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('capability failed')))
		let callback: ((list: unknown) => void) | undefined
		class GetterObserver {
			static supportedEntryTypes = ['longtask']
			constructor(next: (list: unknown) => void) { callback = next }
			get observe(): never { return rejected as never }
			get disconnect(): never { return rejected as never }
		}
		const originalAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener')
		const originalRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener')
		vi.stubGlobal('PerformanceObserver', GetterObserver)
		vi.stubGlobal('performance', Object.defineProperty({}, 'now', {get: () => rejected}))
		Object.defineProperty(globalThis, 'addEventListener', {
			configurable: true,
			get: () => rejected
		})
		Object.defineProperty(globalThis, 'removeEventListener', {
			configurable: true,
			get: () => rejected
		})
		try {
			measurePageLoad({route: '/'})
			observeLongTasks({route: '/'})()
			observeResourceFailures({route: '/'})()
			callback?.(Object.defineProperty({}, 'getEntries', {
				get: () => rejected
			}))
			expect(speciesReads).toBeGreaterThanOrEqual(6)
		} finally {
			if (originalAdd) Object.defineProperty(globalThis, 'addEventListener', originalAdd)
			else delete (globalThis as {addEventListener?: unknown}).addEventListener
			if (originalRemove) Object.defineProperty(globalThis, 'removeEventListener', originalRemove)
			else delete (globalThis as {removeEventListener?: unknown}).removeEventListener
			await rejected.catch(() => undefined)
		}
	})

	it('treats hostile PerformanceObserver capability getters as unsupported', () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver')
		Object.defineProperty(globalThis, 'PerformanceObserver', {
			configurable: true,
			get: () => { throw new Error('observer unavailable') }
		})
		try {
			const stop = observeLongTasks({route: '/'})
			expect(getPerformanceObserver()).toBeNull()
			expect(supportsEntryType('longtask')).toBe(false)
			stop()
		} finally {
			if (original) Object.defineProperty(globalThis, 'PerformanceObserver', original)
			else delete (globalThis as {PerformanceObserver?: unknown}).PerformanceObserver
		}
	})

	it('observes resource failures with sanitized labels', () => {
		const events: Array<unknown[]> = []
		const listeners = new Map<string, BrowserEventListener>()

		vi.stubGlobal('location', {
			href: 'https://studio.example.com/projects/123?tab=overview',
			origin: 'https://studio.example.com',
			pathname: '/projects/123'
		})
		vi.stubGlobal('addEventListener', (type: string, listener: BrowserEventListener) => {
			listeners.set(type, listener)
		})
		vi.stubGlobal('removeEventListener', (type: string) => {
			listeners.delete(type)
		})

		const stop = observeResourceFailures({
			route: () => '/projects/123?tab=overview',
			hostKind: 'cms',
			performance: {record: (name, value, labels) => events.push([name, value, labels])}
		})

		const target = {
			tagName: 'SCRIPT',
			getAttribute: (name: string) => name === 'src' ? '/assets/app.js?cache=1' : null
		}
		listeners.get('error')?.({target} as unknown as Event)
		stop()

		expect(events).toEqual([
			[
				'browser.resource_failure',
				1,
				expect.objectContaining({
					runtime: 'browser',
					route: '/projects/:id',
					kind: 'resource_failure',
					host_kind: 'cms',
					resource_type: 'script',
					resource: 'same-origin'
				})
			]
		])
		expect(listeners.has('error')).toBe(false)
	})

	it('starts and stops browser observers as a group', () => {
		const listeners = new Map<string, BrowserEventListener>()

		class MockObserver {
			static supportedEntryTypes = ['longtask']
			observe(): void {}
			disconnect(): void {}
		}

		vi.stubGlobal('PerformanceObserver', MockObserver)
		vi.stubGlobal('location', {
			href: 'https://studio.example.com/dashboard',
			origin: 'https://studio.example.com',
			pathname: '/dashboard'
		})
		vi.stubGlobal('addEventListener', (type: string, listener: BrowserEventListener) => {
			listeners.set(type, listener)
		})
		vi.stubGlobal('removeEventListener', (type: string) => {
			listeners.delete(type)
		})

		const stop = startBrowserObservers({
			preset: 'development',
			route: '/dashboard',
			performance: {
				record: vi.fn()
			}
		})

		expect(webVitalsCallbacks.size).toBe(5)
		expect(listeners.has('error')).toBe(true)

		stop()

		expect(listeners.has('error')).toBe(false)
	})

	it('aggregates production RUM and flushes bounded buckets on stop', () => {
		const records: Array<[string, number, Record<string, string> | undefined]> = []
		const stop = startBrowserObservers({
			preset: 'production',
			route: '/dashboard',
			longTasks: false,
			resourceFailures: false,
			aggregationIntervalMs: 0,
			performance: {record: (name, value, labels) => records.push([name, value, labels])}
		})
		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 100})
		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 300})
		expect(records).toEqual([])
		stop()
		expect(records.map(([name, value]) => [name, value])).toEqual([
			['browser.web_vital.lcp.count', 2],
			['browser.web_vital.lcp.min', 100],
			['browser.web_vital.lcp.max', 300],
			['browser.web_vital.lcp.avg', 200]
		])
		expect(records[0]?.[2]).toMatchObject({rum_mode: 'aggregated'})

		records.length = 0
		const stopLargeValues = startBrowserObservers({
			preset: 'production', route: '/', longTasks: false, resourceFailures: false,
			aggregationIntervalMs: 0,
			performance: {record: (name, value, labels) => records.push([name, value, labels])}
		})
		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: Number.MAX_VALUE})
		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: Number.MAX_VALUE})
		stopLargeValues()
		expect(records).toContainEqual([
			'browser.web_vital.lcp.avg', Number.MAX_VALUE, expect.objectContaining({rum_mode: 'aggregated'})
		])
	})

	it('retains samples recorded re-entrantly while an aggregate flush emits', () => {
		vi.useFakeTimers()
		try {
			const records: string[] = []
			let reentered = false
			const stop = startBrowserObservers({
				preset: 'production', route: '/', longTasks: false, resourceFailures: false,
				aggregationIntervalMs: 10,
				performance: {record: (name) => {
					records.push(name)
					if (!reentered) {
						reentered = true
						webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 200})
					}
				}}
			})
			webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 100})
			vi.advanceTimersByTime(10)
			stop()
			expect(records.filter((name) => name === 'browser.web_vital.lcp.count')).toHaveLength(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not overwrite re-entrant samples when cardinality pressure drains buckets', () => {
		const records: Array<[string, number]> = []
		let reentered = false
		const stop = startBrowserObservers({
			preset: 'production', route: '/', longTasks: false, resourceFailures: false,
			aggregationIntervalMs: 0, maxAggregationKeys: 1,
			performance: {record: (name, value) => {
				records.push([name, value])
				if (!reentered) {
					reentered = true
					webVitalsCallbacks.get('CLS')?.({name: 'CLS', value: 2})
				}
			}}
		})
		webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 100})
		webVitalsCallbacks.get('CLS')?.({name: 'CLS', value: 1})
		stop()

		expect(records).toContainEqual(['browser.web_vital.cls.count', 2])
	})

	it('validates aggregation controls and isolates PerformancePort failures', () => {
		expect(() => startBrowserObservers({preset: 'production', maxAggregationKeys: 0})).toThrow('maxAggregationKeys')
		expect(() => startBrowserObservers({preset: 'production', maxAggregationKeys: 10_001})).toThrow('maxAggregationKeys')
		expect(() => startBrowserObservers({preset: 'production', aggregationIntervalMs: -1})).toThrow('aggregationIntervalMs')
		expect(() => startBrowserObservers({preset: 'production', aggregationIntervalMs: 1.5})).toThrow('aggregationIntervalMs')
		expect(() => startBrowserObservers({preset: 'production', aggregationIntervalMs: 2_147_483_648})).toThrow('aggregationIntervalMs')
		expect(() => startBrowserObservers({preset: 'invalid' as never})).toThrow('Unknown browser performance preset')
		expect(() => startBrowserObservers({
			preset: {toString: expect.unreachable} as never
		})).toThrow('Unknown browser performance preset')
		const stop = observeWebVitals({
			route: '/',
			performance: {record: () => { throw new Error('consumer failed') }}
		})
		expect(() => webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 100})).not.toThrow()
		expect(() => webVitalsCallbacks.get('INP')?.({name: 'INP', value: Number.NaN})).not.toThrow()
		const malformedMetric = {get name() { throw new Error('metric failed') }, value: 1}
		expect(() => webVitalsCallbacks.get('CLS')?.(malformedMetric as never)).not.toThrow()
		stop()
	})

	it('fails open and cleans up partial observer setup when interval creation fails', () => {
		const records: unknown[] = []
		const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => {
			throw new Error('timer unavailable')
		})
		try {
			let stop: (() => void) | undefined
			expect(() => {
				stop = startBrowserObservers({
					preset: 'production', longTasks: false, resourceFailures: false,
					performance: {record: (...args) => records.push(args)}
				})
			}).not.toThrow()
			expect(() => stop?.()).not.toThrow()
			webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 100})
			expect(records).toEqual([])
		} finally {
			interval.mockRestore()
		}
	})

	it('does not fail observer lifecycle when optional timer methods are unavailable', () => {
		const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => ({
			unref: () => { throw new Error('unref unavailable') }
		}) as never)
		const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => { throw new Error('clear unavailable') })
		try {
			const stop = startBrowserObservers({
				preset: 'production', webVitals: false, longTasks: false, resourceFailures: false
			})
			expect(() => stop()).not.toThrow()
		} finally {
			interval.mockRestore()
			clear.mockRestore()
		}
	})

	it('caps active aggregate observer sessions and their timers', () => {
		const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => ({unref: vi.fn()}) as never)
		const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
		const stops: Array<() => void> = []
		try {
			stops.push(...Array.from({length: 1_000}, () => startBrowserObservers({
				preset: 'production', webVitals: false, longTasks: false, resourceFailures: false
			})))
			expect(interval).toHaveBeenCalledTimes(100)

			for (const stop of stops) stop()
			expect(clear).toHaveBeenCalledTimes(100)

			const stopAfterRelease = startBrowserObservers({
				preset: 'production', webVitals: false, longTasks: false, resourceFailures: false
			})
			expect(interval).toHaveBeenCalledTimes(101)
			stopAfterRelease()
		} finally {
			for (const stop of stops) stop()
			interval.mockRestore()
			clear.mockRestore()
		}
	})

	it('isolates dynamic-route, custom sink, and malformed DOM target failures', () => {
		const routeStop = observeWebVitals({
			route: () => { throw new Error('route failed') },
			recordEvent: () => { throw new Error('sink failed') }
		})
		expect(() => webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 100})).not.toThrow()
		routeStop()

		const listeners = new Map<string, BrowserEventListener>()
		vi.stubGlobal('addEventListener', (type: string, listener: BrowserEventListener) => listeners.set(type, listener))
		vi.stubGlobal('removeEventListener', () => undefined)
		const resourceStop = observeResourceFailures({route: '/'})
		const target = {
			get tagName() { throw new Error('broken element') }
		}
		expect(() => listeners.get('error')?.({target} as unknown as Event)).not.toThrow()
		resourceStop()
	})

	it('covers browser runtime resource classification and observer guards', () => {
		vi.stubGlobal('PerformanceObserver', undefined)
		expect(getPerformanceObserver()).toBeNull()
		expect(supportsEntryType('longtask')).toBe(false)
		expect(classifyResourceType(null)).toBeNull()
		expect(classifyResourceType({tagName: 'IMG'} as unknown as EventTarget)).toBe('image')
		expect(classifyResourceType({tagName: 'LINK', getAttribute: (key: string) => key === 'as' ? 'font' : null} as unknown as EventTarget)).toBe('font')
		expect(classifyResourceType({tagName: 'LINK', getAttribute: (key: string) => key === 'href' ? '/assets/font.woff2' : null} as unknown as EventTarget)).toBe('font')
		expect(classifyResourceType({tagName: 'LINK', getAttribute: (key: string) => key === 'as' ? 'script' : null} as unknown as EventTarget)).toBe('script')
		expect(classifyResourceType({tagName: 'LINK', getAttribute: (key: string) => key === 'href' ? '/assets/site.css' : null} as unknown as EventTarget)).toBe('style')
		expect(classifyResourceType({tagName: 'DIV'} as unknown as EventTarget)).toBe('other')

		vi.stubGlobal('location', {href: 'https://app.test/a', origin: 'https://app.test'})
		expect(resolveResourceUrl({currentSrc: 'https://external.test/a.js'} as unknown as EventTarget)).toBe('external')
		expect(resolveResourceUrl({getAttribute: (key: string) => key === 'href' ? '/assets/a.css?x=1' : null} as unknown as EventTarget)).toBe('same-origin')
		expect(resolveResourceUrl({currentSrc: 'https://app.test/users/123e4567-e89b-12d3-a456-426614174000/avatar.js'} as unknown as EventTarget))
			.toBe('same-origin')
		expect(resolveResourceUrl({currentSrc: 'https://app.test/users/alice%40example.com/avatar.png'} as unknown as EventTarget))
			.toBe('same-origin')
		expect(resolveResourceUrl({currentSrc: 'https://app.test/avatars/123e4567-e89b-12d3-a456-426614174000.png'} as unknown as EventTarget))
			.toBe('same-origin')
		expect(resolveResourceUrl({currentSrc: 'https://app.test/download/private-token.js'} as unknown as EventTarget))
			.toBe('same-origin')
		expect(resolveResourceUrl({getAttribute: (key: string) => key === 'src' ? 'http://[' : null} as unknown as EventTarget)).toBe('external')
		expect(resolveResourceUrl({} as EventTarget)).toBe('external')
		vi.stubGlobal('location', undefined)
		expect(resolveResourceUrl({currentSrc: 'https://cdn.example.test/secret/path.js?token=x'} as unknown as EventTarget)).toBe('external')
	})

	it('observes rejected promises returned by resource target capabilities', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('target failed')))
		const target = {
			tagName: 'LINK',
			getAttribute: (() => rejected) as never
		} as unknown as EventTarget
		try {
			expect(classifyResourceType(target)).toBe('other')
			expect(resolveResourceUrl(target)).toBe('external')
			vi.stubGlobal('location', {href: rejected, origin: rejected, pathname: rejected})
			expect(readBrowserLocation('pathname')).toBeUndefined()
			expect(resolveResourceUrl({currentSrc: '/asset.js'} as unknown as EventTarget)).toBe('same-origin')
			vi.stubGlobal('location', rejected)
			expect(readBrowserLocation('pathname')).toBeUndefined()
			vi.stubGlobal('PerformanceObserver', rejected)
			expect(getPerformanceObserver()).toBeNull()
			class PartialObserver {}
			Object.defineProperty(PartialObserver, 'supportedEntryTypes', {value: rejected})
			vi.stubGlobal('PerformanceObserver', PartialObserver)
			expect(supportsEntryType('longtask')).toBe(false)
			expect(speciesReads).toBeGreaterThanOrEqual(6)
		} finally {
			await rejected.catch(() => undefined)
		}
	})

	it('falls back safely when browser observer APIs are unavailable', async() => {
		vi.stubGlobal('PerformanceObserver', undefined)
		vi.stubGlobal('addEventListener', undefined)
		const navigation = await measureNavigation(async() => 'plain', {route: 'plain'})
		const interaction = await measureInteraction('plain', async() => 'plain')
		expect(navigation).toBe('plain')
		expect(interaction).toBe('plain')
		const stopLongTasks = observeLongTasks({route: '/'})
		const stopResources = observeResourceFailures({route: '/'})
		expect(stopLongTasks).toBeTypeOf('function')
		expect(stopResources).toBeTypeOf('function')
		stopLongTasks()
		stopResources()
	})

	it('treats hostile global event-listener accessors as unavailable', () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener')
		Object.defineProperty(globalThis, 'addEventListener', {
			configurable: true,
			get: () => { throw new Error('event target unavailable') }
		})
		try {
			const stop = observeResourceFailures({route: '/'})
			stop()
		} finally {
			if (original) Object.defineProperty(globalThis, 'addEventListener', original)
			else delete (globalThis as {addEventListener?: unknown}).addEventListener
		}
	})

	it('flushes aggregate buckets on the configured interval', () => {
		vi.useFakeTimers()
		try {
			const record = vi.fn()
			const stop = startBrowserObservers({
				preset: 'custom', route: '/', longTasks: false, resourceFailures: false,
				aggregationIntervalMs: 10, performance: {record}
			})
			webVitalsCallbacks.get('LCP')?.({name: 'LCP', value: 25})
			vi.advanceTimersByTime(10)
			expect(record).toHaveBeenCalledTimes(4)
			stop()
		} finally {
			vi.useRealTimers()
		}
	})

	it('isolates observer initialization and listener cleanup failures', () => {
		const disconnect = vi.fn(() => { throw new Error('disconnect failed') })
		class BrokenObserver {
			static supportedEntryTypes = ['longtask']
			observe(): void { throw new Error('observe failed') }
			disconnect = disconnect
		}
		vi.stubGlobal('PerformanceObserver', BrokenObserver)
		const stopBrokenObserver = observeLongTasks({route: '/'})
		expect(disconnect).toHaveBeenCalled()
		stopBrokenObserver()
		class CleanupFailureObserver {
			static supportedEntryTypes = ['longtask']
			observe(): void {}
			disconnect(): void { throw new Error('disconnect failed') }
		}
		vi.stubGlobal('PerformanceObserver', CleanupFailureObserver)
		const stopLongTasks = observeLongTasks({route: '/'})
		expect(() => stopLongTasks()).not.toThrow()

		vi.stubGlobal('addEventListener', () => { throw new Error('listener failed') })
		const stopFailedResourceObserver = observeResourceFailures({route: '/'})
		stopFailedResourceObserver()

		vi.stubGlobal('addEventListener', () => undefined)
		vi.stubGlobal('removeEventListener', () => { throw new Error('cleanup failed') })
		const stopResources = observeResourceFailures({route: '/'})
		expect(() => stopResources()).not.toThrow()
	})

	it('covers observer fallbacks, disabled groups, and ignored resource errors', () => {
		const records: Array<unknown[]> = []
		const stopVitals = observeWebVitals({
			route: '/fallback', performance: {record: (name, value, labels) => records.push([name, value, labels])}
		})
		webVitalsCallbacks.get('FCP')?.({name: 'FCP', value: 10})
		stopVitals()
		expect(records[0]?.[0]).toBe('browser.web_vital.fcp')
		const direct = vi.fn()
		const stopDirect = observeWebVitals({route: '   ', performance: {record: direct}})
		webVitalsCallbacks.get('TTFB')?.({name: 'TTFB', value: 5})
		expect(direct).toHaveBeenCalled()
		stopDirect()

		const listeners = new Map<string, BrowserEventListener>()
		vi.stubGlobal('addEventListener', (type: string, listener: BrowserEventListener) => listeners.set(type, listener))
		vi.stubGlobal('removeEventListener', () => undefined)
		const stopResources = observeResourceFailures({route: '/', performance: {record: vi.fn()}})
		listeners.get('error')?.({target: null} as unknown as Event)
		listeners.get('error')?.({target: {}} as unknown as Event)
		stopResources()
		const stopAll = startBrowserObservers({preset: 'production', route: '/', webVitals: false, longTasks: false, resourceFailures: false})
		stopAll()
	})

	it('uses a privacy-safe root route when no explicit observer route is configured', () => {
		vi.stubGlobal('location', {pathname: '/projects/456'})
		const records: Array<unknown[]> = []
		const stop = observeWebVitals({performance: {record: (name, value, labels) => records.push([name, value, labels])}})
		webVitalsCallbacks.get('TTFB')?.({name: 'TTFB', value: 12})
		stop()
		expect(records[0]?.[2]).toMatchObject({route: '/'})
		vi.stubGlobal('location', undefined)
		const rootStop = observeWebVitals({performance: {record: vi.fn()}})
		rootStop()
	})
})
