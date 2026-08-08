import {beforeEach, describe, expect, it, vi} from 'vitest'

const webVitalsCallbacks = vi.hoisted(() => new Map<string, (metric: {
	name: string
	value: number
	rating?: 'good' | 'needs-improvement' | 'poor'
	navigationType?: string
}) => void>())

const faroMock = vi.hoisted(() => {
	const pushEvent = vi.fn()
	const pushError = vi.fn()
	const pushLog = vi.fn()
	const setUser = vi.fn()
	const getWebInstrumentations = vi.fn(() => [{name: 'web-instrumentation'}])
	const initializeFaro = vi.fn(() => ({
		api: {
			pushEvent,
			pushError,
			pushLog,
			setUser
		}
	}))
	return {
		pushEvent,
		pushError,
		pushLog,
		setUser,
		getWebInstrumentations,
		initializeFaro,
		LogLevel: {
			TRACE: 'trace',
			DEBUG: 'debug',
			INFO: 'info',
			LOG: 'log',
			WARN: 'warn',
			ERROR: 'error'
		}
	}
})

vi.mock('@grafana/faro-web-sdk', () => ({
	getWebInstrumentations: faroMock.getWebInstrumentations,
	initializeFaro: faroMock.initializeFaro,
	LogLevel: faroMock.LogLevel
}))

vi.mock('web-vitals', () => ({
	onLCP: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		webVitalsCallbacks.set('LCP', callback)
	},
	onINP: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		webVitalsCallbacks.set('INP', callback)
	},
	onCLS: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		webVitalsCallbacks.set('CLS', callback)
	},
	onFCP: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		webVitalsCallbacks.set('FCP', callback)
	},
	onTTFB: (callback: typeof webVitalsCallbacks extends Map<string, infer T> ? T : never) => {
		webVitalsCallbacks.set('TTFB', callback)
	}
}))

import {
	captureFaroBrowserError,
	captureFaroBrowserEvent,
	captureFaroBrowserLog,
	createFaroBrowserPerformancePort,
	createFaroBrowserPerformanceBridge,
	initFaroBrowser,
	startFaroBrowserObservers,
	setFaroBrowserUser
} from '../src/faro-browser'
import {resetFaroBrowserState} from '../src/faro-browser-state'

describe('faro browser helpers', () => {
	beforeEach(() => {
		webVitalsCallbacks.clear()
		faroMock.pushEvent.mockReset()
		faroMock.pushError.mockReset()
		faroMock.pushLog.mockReset()
		faroMock.setUser.mockReset()
		faroMock.getWebInstrumentations.mockClear()
		faroMock.initializeFaro.mockClear()
		resetFaroBrowserState()
	})

	it('initializes idempotently for the same config', () => {
		const first = initFaroBrowser({
			config: {
				url: 'https://faro.example.com/collect',
				apiKey: 'abc',
				app: {name: 'studio', version: '1.0.0', environment: 'test'}
			},
			enableDefaultInstrumentations: true,
			captureConsole: true
		})
		const second = initFaroBrowser({
			config: {
				url: 'https://faro.example.com/collect',
				apiKey: 'abc',
				app: {name: 'studio', version: '1.0.0', environment: 'test'}
			},
			enableDefaultInstrumentations: true,
			captureConsole: true
		})

		expect(first).toBe(second)
		expect(faroMock.getWebInstrumentations).toHaveBeenCalledTimes(1)
		expect(faroMock.getWebInstrumentations).toHaveBeenCalledWith({
			captureConsole: true,
			enablePerformanceInstrumentation: false,
			enableContentSecurityPolicyInstrumentation: false
		})
		expect(faroMock.initializeFaro).toHaveBeenCalledTimes(1)
		expect(faroMock.initializeFaro).toHaveBeenCalledWith({
			url: 'https://faro.example.com/collect',
			apiKey: 'abc',
			app: {name: 'studio', version: '1.0.0', environment: 'test'},
			instrumentations: [{name: 'web-instrumentation'}]
		})
	})

	it('initializes a new client without default instrumentations for a changed config', () => {
		const first = initFaroBrowser({config: {url: 'https://faro.example.com/a', app: {name: 'studio'}}})
		const second = initFaroBrowser({
			config: {url: 'https://faro.example.com/b', app: {name: 'studio'}},
			enableDefaultInstrumentations: false
		})

		expect(second).not.toBe(first)
		expect(faroMock.getWebInstrumentations).not.toHaveBeenCalled()
		expect(faroMock.initializeFaro).toHaveBeenLastCalledWith({
			url: 'https://faro.example.com/b', app: {name: 'studio'}, instrumentations: []
		})
	})

	it('forwards browser events, errors, logs, and user metadata', () => {
		const client = initFaroBrowser({
			config: {
				url: 'https://faro.example.com/collect',
				app: {name: 'studio'}
			}
		})

		captureFaroBrowserEvent(client, {
			name: 'ui.clicked', attributes: {button: 'save', token: 'private', key: 'private', bearer: 'private'}, domain: 'ui'
		})
		captureFaroBrowserError(client, new Error('boom'), {type: 'ui', attributes: {route: '/tasks', authorization: 'Bearer private'}})
		captureFaroBrowserLog(client, 'warn', 'hello', {attributes: {route: '/tasks', session_id: 'private'}})
		setFaroBrowserUser(client, {id: 'u-1', email: 'ion@example.com', attributes: {role: 'admin', api_key: 'private'}})

		expect(faroMock.pushEvent).toHaveBeenCalledWith('ui.clicked', {button: 'save'}, 'ui')
		expect(faroMock.pushError).toHaveBeenCalledTimes(1)
		expect(faroMock.pushError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
		expect(faroMock.pushError.mock.calls[0]?.[0]).toMatchObject({message: 'boom'})
		expect(faroMock.pushError.mock.calls[0]?.[1]).toEqual({
			type: 'ui',
			context: {route: '/tasks'}
		})
		expect(faroMock.pushLog).toHaveBeenCalledWith(['hello'], {
			level: 'warn',
			context: {route: '/tasks'}
		})
		expect(faroMock.setUser).toHaveBeenCalledWith({
			id: 'u-1',
			email: 'ion@example.com',
			attributes: {role: 'admin'}
		})
	})

	it('rejects query-like Faro telemetry dimensions without leaking their values', () => {
		const client = initFaroBrowser({
			config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}
		})
		captureFaroBrowserEvent(client, {
			name: 'ui.clicked?token=private', domain: 'tenant=private', attributes: {button: 'save'}
		})
		captureFaroBrowserError(client, new Error('boom'), {type: 'ui?token=private', attributes: {route: '/tasks'}})

		expect(faroMock.pushEvent).not.toHaveBeenCalled()
		expect(faroMock.pushError.mock.calls[0]?.[1]).toEqual({context: {route: '/tasks'}})
		expect(JSON.stringify([faroMock.pushEvent.mock.calls, faroMock.pushError.mock.calls[0]?.[1]])).not.toContain('private')
	})

	it('does not execute accessors on direct Faro telemetry inputs', () => {
		const client = initFaroBrowser({
			config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}
		})
		const getter = vi.fn(() => 'private')
		const hostile = (fields: readonly string[]) => Object.defineProperties({}, Object.fromEntries(
			fields.map((field) => [field, {enumerable: true, get: getter}])
		))

		captureFaroBrowserEvent(client, hostile(['name', 'attributes', 'domain']) as never)
		captureFaroBrowserError(client, new Error('boom'), hostile(['type', 'attributes']) as never)
		captureFaroBrowserLog(client, 'warn', 'safe', hostile(['attributes']) as never)
		setFaroBrowserUser(client, hostile(['id', 'email', 'username', 'attributes']) as never)

		expect(getter).not.toHaveBeenCalled()
		expect(faroMock.pushEvent).not.toHaveBeenCalled()
		expect(faroMock.pushError).not.toHaveBeenCalled()
		expect(faroMock.pushLog).not.toHaveBeenCalled()
		expect(faroMock.setUser).not.toHaveBeenCalled()
	})

	it('does not execute accessors on direct Faro clients or API methods', () => {
		const getter = vi.fn(() => ({pushError: vi.fn(), pushLog: vi.fn(), setUser: vi.fn()}))
		const client = Object.defineProperty({}, 'api', {enumerable: true, get: getter})
		const method = vi.fn()
		const api = Object.defineProperties({}, {
			pushError: {get: method}, pushLog: {get: method}, setUser: {get: method}
		})

		captureFaroBrowserError(client as never, new Error('boom'))
		captureFaroBrowserLog(client as never, 'warn', 'safe')
		setFaroBrowserUser(client as never, {id: 'safe'})
		captureFaroBrowserError({api} as never, new Error('boom'))
		captureFaroBrowserLog({api} as never, 'warn', 'safe')
		setFaroBrowserUser({api} as never, {id: 'safe'})

		expect(getter).not.toHaveBeenCalled()
		expect(method).not.toHaveBeenCalled()
	})

	it('observes rejected promises returned by direct Faro delivery and timing capabilities', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('faro failed')))
		const client = initFaroBrowser({config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}})
		try {
			expect(() => initFaroBrowser(rejected as never)).toThrow()
			expect(() => captureFaroBrowserEvent(rejected as never, rejected as never)).not.toThrow()
			expect(() => captureFaroBrowserError(rejected as never, rejected, rejected as never)).not.toThrow()
			expect(() => captureFaroBrowserLog(
				rejected as never, 'warn', rejected as never, rejected as never
			)).not.toThrow()
			expect(() => setFaroBrowserUser(rejected as never, rejected as never)).not.toThrow()
			faroMock.pushEvent.mockReturnValueOnce(rejected)
			captureFaroBrowserEvent(client, {name: 'failed.event'})
			await Promise.resolve()
			faroMock.pushError.mockReturnValueOnce(rejected)
			captureFaroBrowserError(client, new Error('failed'))
			await Promise.resolve()
			faroMock.pushLog.mockReturnValueOnce(rejected)
			captureFaroBrowserLog(client, 'warn', 'failed')
			await Promise.resolve()
			faroMock.setUser.mockReturnValueOnce(rejected)
			setFaroBrowserUser(client, {id: 'failed'})
			await Promise.resolve()
			captureFaroBrowserEvent(client, Object.defineProperties({}, {
				name: {get: () => rejected},
				attributes: {get: () => rejected},
				domain: {get: () => rejected}
			}) as never)
			captureFaroBrowserError(client, new Error('failed'), Object.defineProperties({}, {
				type: {get: () => rejected},
				attributes: {get: () => rejected}
			}) as never)
			captureFaroBrowserLog(client, 'warn', rejected as never)
			setFaroBrowserUser(client, Object.defineProperties({}, {
				id: {get: () => rejected},
				email: {get: () => rejected},
				username: {get: () => rejected},
				attributes: {get: () => rejected}
			}) as never)

			const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
			Object.defineProperty(globalThis, 'performance', {
				configurable: true,
				value: {now: () => rejected}
			})
			try {
				const performance = createFaroBrowserPerformancePort(client)
				await expect(performance.measureAsync?.('timing.failed', async() => 'ok')).resolves.toBe('ok')
			} finally {
				if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance)
			}
			expect(speciesReads).toBeGreaterThanOrEqual(17)
		} finally {
			await rejected.catch(() => undefined)
		}
	})

	it('normalizes optional and non-serializable Faro values', () => {
		const client = initFaroBrowser({config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}})
		const circular: {self?: unknown} = {}
		circular.self = circular

		captureFaroBrowserEvent(client, {name: 'empty'})
		captureFaroBrowserError(client, {reason: 'bad'}, {attributes: {none: null, circular}})
		captureFaroBrowserLog(client, 'trace', 'trace')
		setFaroBrowserUser(client, {})

		expect(faroMock.pushEvent).toHaveBeenCalledWith('empty', undefined, undefined)
		expect(faroMock.pushError.mock.calls[0]?.[0]).toMatchObject({message: '[unserializable]'})
		expect(faroMock.pushError.mock.calls[0]?.[1]).toEqual({context: {none: '', circular: '[unserializable]'}})
		expect(faroMock.pushLog).toHaveBeenCalledWith(['trace'], {level: 'trace'})
		expect(faroMock.setUser).toHaveBeenCalledWith({})
	})

	it('covers empty attributes, string errors, and omitted optional browser config', () => {
		const client = initFaroBrowser({
			config: {url: 'https://faro.example.com/collect', app: {name: 'studio', version: '', environment: ''}},
			enableDefaultInstrumentations: true
		})

		captureFaroBrowserEvent(client, {name: 'empty-attributes', attributes: {}})
		captureFaroBrowserError(client, 'string-error')
		captureFaroBrowserLog(client, 'debug', 'debug', {attributes: {}})
		setFaroBrowserUser(client, {attributes: {}})

		expect(faroMock.getWebInstrumentations).toHaveBeenCalledWith({
			captureConsole: false,
			enablePerformanceInstrumentation: false,
			enableContentSecurityPolicyInstrumentation: false
		})
		expect(faroMock.pushEvent).toHaveBeenCalledWith('empty-attributes', undefined, undefined)
		expect(faroMock.pushError.mock.calls[0]?.[0]).toMatchObject({message: 'string-error'})
		expect(faroMock.pushLog).toHaveBeenCalledWith(['debug'], {level: 'debug'})
		expect(faroMock.setUser).toHaveBeenCalledWith({})
	})

	it('dedupes lifecycle performance events while allowing custom events', () => {
		const client = initFaroBrowser({
			config: {
				url: 'https://faro.example.com/collect',
				app: {name: 'studio'}
			}
		})
		const bridge = createFaroBrowserPerformanceBridge(client)

		bridge.captureLifecycleEvent('browser.page_load', {route: '/tasks'})
		bridge.captureLifecycleEvent('browser.page_load', {route: '/tasks'})
		bridge.captureCustomEvent('browser.long_task', {value: 42})

		expect(faroMock.pushEvent).toHaveBeenCalledTimes(2)
		expect(faroMock.pushEvent).toHaveBeenNthCalledWith(1, 'browser.page_load', {route: '/tasks'}, 'performance')
		expect(faroMock.pushEvent).toHaveBeenNthCalledWith(2, 'browser.long_task', {value: '42'}, 'performance')
	})

	it('can disable lifecycle-event deduplication', () => {
		const client = initFaroBrowser({config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}})
		const bridge = createFaroBrowserPerformanceBridge(client, {dedupeLifecycleEvents: false})
		bridge.captureLifecycleEvent('browser.navigation')
		bridge.captureLifecycleEvent('browser.navigation')
		expect(faroMock.pushEvent).toHaveBeenCalledTimes(2)
	})

	it('single-flights unresolved Faro performance event delivery', async() => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => { release = resolve })
		faroMock.pushEvent.mockImplementation(() => pending)
		const client = initFaroBrowser({config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}})
		const bridges = Array.from({length: 1_000}, () => createFaroBrowserPerformanceBridge(client))

		for (let index = 0; index < 10_000; index += 1) {
			bridges[index % bridges.length]?.captureCustomEvent(`custom.${index}`)
		}
		expect(faroMock.pushEvent).toHaveBeenCalledOnce()

		release()
		await pending
		await Promise.resolve()
		bridges.at(-1)?.captureCustomEvent('custom.after')
		expect(faroMock.pushEvent).toHaveBeenCalledTimes(2)
	})

	it('adapts performance-browser calls into Faro lifecycle and rum events', async() => {
		const client = initFaroBrowser({
			config: {
				url: 'https://faro.example.com/collect',
				app: {name: 'studio'}
			}
		})
		const performance = createFaroBrowserPerformancePort(client)

		performance.record?.('browser.page_load', 120, {route: '/dashboard'})
		performance.record?.('browser.page_load', 140, {route: '/dashboard'})
		await performance.measureAsync?.('browser.navigation', async() => 'ok', {route: '/dashboard'})

		expect(faroMock.pushEvent).toHaveBeenNthCalledWith(1, 'browser.page_load', {
			route: '/dashboard',
			value: '120'
		}, 'performance')
		expect(faroMock.pushEvent.mock.calls[1]?.[0]).toBe('browser.navigation')
		expect(faroMock.pushEvent.mock.calls[1]?.[2]).toBe('performance')
		expect(faroMock.pushEvent).toHaveBeenCalledTimes(2)
	})

	it('handles minimal web-vitals, custom records, and Date fallback timing', async() => {
		const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
		Object.defineProperty(globalThis, 'performance', {value: undefined, configurable: true})
		try {
			const client = initFaroBrowser({config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}})
			const performance = createFaroBrowserPerformancePort(client)
			performance.record?.('custom.counter', 1)
			await performance.measureAsync?.('browser.page_load', async() => 'ok')

			expect(faroMock.pushEvent).toHaveBeenNthCalledWith(1, 'custom.counter', {value: '1'}, 'performance')
			expect(faroMock.pushEvent.mock.calls[1]?.[0]).toBe('browser.page_load')
		} finally {
			if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance)
		}
	})

	it('records custom rum events and emits timing for custom measured work', async() => {
		const client = initFaroBrowser({config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}})
		const performance = createFaroBrowserPerformancePort(client)
		performance.record?.('browser.widget', 2, {widget: 'menu'})
		await expect(performance.measureAsync?.('custom.measure', async() => 'ok')).resolves.toBe('ok')

		expect(faroMock.pushEvent).toHaveBeenNthCalledWith(1, 'browser.widget', {value: '2', widget: 'menu'}, 'performance')
		expect(faroMock.pushEvent.mock.calls[1]?.[0]).toBe('custom.measure')
	})

	it('records failed measured work without replacing its error or result', async() => {
		const client = initFaroBrowser({config: {url: 'https://faro.example.com/collect', app: {name: 'studio'}}})
		const performance = createFaroBrowserPerformancePort(client)
		const failure = new Error('business failure')
		await expect(performance.measureAsync?.('custom.failed', async() => { throw failure })).rejects.toBe(failure)
		expect(faroMock.pushEvent).toHaveBeenCalledWith(
			'custom.failed',
			expect.objectContaining({outcome: 'error'}),
			'performance'
		)

		faroMock.pushEvent.mockImplementationOnce(() => { throw new Error('faro unavailable') })
		await expect(performance.measureAsync?.('custom.success', async() => 'authoritative')).resolves.toBe('authoritative')
		expect(() => performance.record?.('custom.record', 1)).not.toThrow()
	})

	it('starts browser observers through the Faro adapter without duplicate reporting', () => {
		const client = initFaroBrowser({
			config: {
				url: 'https://faro.example.com/collect',
				app: {name: 'studio'}
			}
		})

		const stop = startFaroBrowserObservers({
			client,
			preset: 'development',
			route: '/projects/123?tab=overview',
			hostKind: 'studio',
			webVitals: true,
			longTasks: false,
			resourceFailures: false
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

		expect(faroMock.pushEvent).toHaveBeenCalledTimes(1)
		expect(faroMock.pushEvent).toHaveBeenCalledWith('browser.web_vital.lcp', {
			value: '2400',
			rating: 'good',
			navigationType: 'navigate',
			runtime: 'browser',
			route: '/projects/:id',
			kind: 'web-vital',
			hostKind: 'studio',
			rum_mode: 'full'
		}, 'performance')
	})
})
