import {createContainer} from '@ooopsstudio/core/runtime/container'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerMetrics} from '../src'
import type {ManagedMetrics} from '../src/public/types'

import {createRecordingMetricsExporter} from './support/recording-exporter'

function createBoundContainer() {
	const container = createContainer()
	container.bind(TOK.Clock, createSystemClock())
	return container
}

describe('registerMetrics', () => {
	it('registers the async development preset', async() => {
		const container = createBoundContainer()
		await registerMetrics(container, {preset: 'development', options: {console: false}})
		const metrics = container.get<ManagedMetrics>(TOK.Metrics)
		expect(typeof metrics.getStatus).toBe('function')
		expect('destroy' in metrics).toBe(false)
		await metrics.shutdown()
	})

	it('registers custom delivery using the container clock', async() => {
		const container = createBoundContainer()
		const exporter = createRecordingMetricsExporter()
		await registerMetrics(container, {
			preset: 'custom',
			options: {destinations: [{provider: 'custom', exporter}]} as never
		})
		const metrics = container.get<ManagedMetrics>(TOK.Metrics)
		metrics.counter('registered_total')
		await metrics.flush()
		expect(exporter.getMetricsByName('registered_total')).toHaveLength(1)
		await metrics.shutdown()
	})

	it('rejects hostile registration data without executing getters', async() => {
		const container = createBoundContainer()
		const getter = vi.fn(() => 'development')
		const registration = Object.defineProperty({}, 'preset', {enumerable: true, get: getter})
		await expect(registerMetrics(container, registration as never)).rejects.toThrow('stable data fields')
		expect(getter).not.toHaveBeenCalled()
	})

	it('bounds hostile container prototype traversal', async() => {
		let prototypeReads = 0
		const createHostile = (): object => new Proxy({}, {
			getPrototypeOf: () => {
				prototypeReads += 1
				if (prototypeReads > 200) throw new Error('unbounded container traversal')
				return createHostile()
			}
		})

		await expect(registerMetrics(createHostile() as never, {
			preset: 'development', options: {console: false}
		})).rejects.toThrow('valid reversible container')
		expect(prototypeReads).toBeLessThanOrEqual(160)
	})

	it('awaits shutdown when container binding rollback fails', async() => {
		const container = createBoundContainer()
		const originalBind = container.bind.bind(container)
		container.bind = vi.fn((token, value) => {
			originalBind(token, value)
			if (token === TOK.Metrics) throw new Error('bind failed')
		}) as typeof container.bind
		await expect(registerMetrics(container, {preset: 'development', options: {console: false}}))
			.rejects.toThrow('Metrics registration failed')
		expect(container.has(TOK.Metrics)).toBe(false)
	})

	it('owns registration before caller-controlled container traps can re-enter', async() => {
		const target = createBoundContainer()
		let reentrant: Promise<void> | undefined
		let proxy: typeof target
		proxy = new Proxy(target, {
			getOwnPropertyDescriptor(object, key) {
				if (key === 'has' && !reentrant) {
					reentrant = registerMetrics(proxy, {preset: 'development', options: {console: false}})
				}
				return Reflect.getOwnPropertyDescriptor(object, key)
			}
		})

		await registerMetrics(proxy, {preset: 'development', options: {console: false}})
		await expect(reentrant).rejects.toThrow('already registered')
		await proxy.get<ManagedMetrics>(TOK.Metrics).shutdown()
	})

	it('preserves the receiver for container methods', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, createSystemClock()]])
		const container = {
			values,
			bind<T>(this: {values: Map<symbol, unknown>}, token: symbol, value: T) { this.values.set(token, value) },
			unbind(this: {values: Map<symbol, unknown>}, token: symbol) { return this.values.delete(token) },
			get<T>(this: {values: Map<symbol, unknown>}, token: symbol): T {
				const value = this.values.get(token)
				if (value === undefined) throw new Error('missing')
				return value as T
			},
			tryGet<T>(this: {values: Map<symbol, unknown>}, token: symbol) { return this.values.get(token) as T | undefined },
			has(this: {values: Map<symbol, unknown>}, token: symbol) { return this.values.has(token) }
		}

		await registerMetrics(container, {preset: 'development', options: {console: false}})
		await container.get<ManagedMetrics>(TOK.Metrics).shutdown()
	})

	it('rejects silent binds and removes any partial registration', async() => {
		const container = createBoundContainer()
		container.bind = vi.fn(() => undefined) as typeof container.bind

		await expect(registerMetrics(container, {preset: 'development', options: {console: false}}))
			.rejects.toThrow('did not retain')
		expect(container.has(TOK.Metrics)).toBe(false)
	})

	it('does not expose caller-controlled container failures', async() => {
		const container = createBoundContainer()
		container.bind = vi.fn(() => { throw new Error('Bearer private-secret') }) as typeof container.bind

		const error = await registerMetrics(container, {preset: 'development', options: {console: false}})
			.catch((failure: unknown) => failure)
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toBe('Metrics registration failed')
		expect(String(error)).not.toContain('private-secret')
	})

	it('prevents concurrent and duplicate registration', async() => {
		const container = createBoundContainer()
		await registerMetrics(container, {preset: 'development', options: {console: false}})
		await expect(registerMetrics(container, {preset: 'development', options: {console: false}}))
			.rejects.toThrow('already registered')
		await container.get<ManagedMetrics>(TOK.Metrics).shutdown()
	})
})
