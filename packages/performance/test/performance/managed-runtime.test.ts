import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createBasePerformanceHandler} from '../../src/performance/core/base-handler'
import {createPerformanceCallbackDispatcher} from '../../src/performance/core/callback-dispatcher'
import {createCustomPerformance} from '../../src/performance/public/custom'
import {createDevelopmentPerformance} from '../../src/performance/public/development'
import {attachPerformanceObservability} from '../../src/performance/public/observability'
import {createProductionPerformance} from '../../src/performance/public/production'

const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => { resolve = done })
	return {promise, resolve}
}

describe('managed performance runtime', () => {
	it('snapshots and freezes an emission only once for multiple observers', () => {
		const mutating = vi.fn((event: {name: string}) => { event.name = 'mutated' })
		const observing = vi.fn()
		const dispatcher = createPerformanceCallbackDispatcher({onPerfEvent: mutating as never})
		dispatcher.add({onPerfEvent: observing})

		dispatcher.emit('onPerfEvent', {
			name: 'original', duration: 1, start: 0, end: 1, source: 'mark'
		})

		expect(mutating).toHaveBeenCalledOnce()
		expect(observing).toHaveBeenCalledWith(expect.objectContaining({name: 'original'}))
		expect(Object.isFrozen(observing.mock.calls[0]?.[0])).toBe(true)
	})

	it('does not invoke callback bundle accessors or proxy traps', () => {
		const readCallback = vi.fn(() => vi.fn())
		const accessorBundle = Object.defineProperty({}, 'onSelfMetric', {get: readCallback})
		const get = vi.fn(() => vi.fn())
		const proxyBundle = new Proxy({}, {get})
		const dispatcher = createPerformanceCallbackDispatcher(accessorBundle as never)
		dispatcher.add(proxyBundle as never)

		expect(() => dispatcher.emit('onSelfMetric', 'metric', 1)).not.toThrow()
		expect(readCallback).not.toHaveBeenCalled()
		expect(get).not.toHaveBeenCalled()
	})

	it('does not assimilate thenables returned by telemetry observers', () => {
		const readThen = vi.fn(() => { throw new Error('must not assimilate') })
		const dispatcher = createPerformanceCallbackDispatcher({
			onSelfMetric: (() => Object.defineProperty({}, 'then', {get: readThen})) as never
		})

		expect(() => dispatcher.emit('onSelfMetric', 'metric', 1)).not.toThrow()
		expect(readThen).not.toHaveBeenCalled()
	})

	it('bounds unresolved async telemetry callbacks per bundle and event type', async() => {
		const gate = deferred<void>()
		const onSelfMetric = vi.fn(() => gate.promise)
		const onPerfEvent = vi.fn(() => gate.promise)
		const dispatcher = createPerformanceCallbackDispatcher({
			onSelfMetric: onSelfMetric as never,
			onPerfEvent: onPerfEvent as never
		})
		const event = {name: 'request', duration: 1, start: 0, end: 1, source: 'mark' as const}

		for (let index = 0; index < 10_000; index += 1) {
			dispatcher.emit('onSelfMetric', 'metric', 1)
			dispatcher.emit('onPerfEvent', event)
		}
		expect(onSelfMetric).toHaveBeenCalledOnce()
		expect(onPerfEvent).toHaveBeenCalledOnce()

		gate.resolve()
		await gate.promise
		await Promise.resolve()
		dispatcher.emit('onSelfMetric', 'metric', 1)
		expect(onSelfMetric).toHaveBeenCalledTimes(2)
	})

	it('bounds synchronous telemetry re-entry per bundle and event type', () => {
		let dispatcher!: ReturnType<typeof createPerformanceCallbackDispatcher>
		const onSelfMetric = vi.fn(() => dispatcher.emit('onSelfMetric', 'nested', 1))
		dispatcher = createPerformanceCallbackDispatcher({onSelfMetric})

		expect(() => dispatcher.emit('onSelfMetric', 'root', 1)).not.toThrow()
		expect(onSelfMetric).toHaveBeenCalledOnce()
	})

	it('rolls back started monitors when extension setup fails', () => {
		const stop = vi.fn()
		expect(() => createBasePerformanceHandler({
			clock: createFixedClock(1),
			cardinalityLimit: 10,
			cardinalityMode: 'drop',
			enableEventLoopMonitor: true,
			enableGCMonitor: false,
			enableResourceMonitor: false,
			createRuntimeMonitoring: () => ({stop}),
			createExtensions: () => { throw new Error('extension setup failed') }
		})).toThrow('extension setup failed')
		expect(stop).toHaveBeenCalledOnce()
	})

	it('continues exporter shutdown when monitor cleanup throws', async() => {
		const shutdownExporter = vi.fn(async() => undefined)
		const performance = createBasePerformanceHandler({
			clock: createFixedClock(1),
			cardinalityLimit: 10,
			cardinalityMode: 'drop',
			enableEventLoopMonitor: true,
			enableGCMonitor: false,
			enableResourceMonitor: false,
			createRuntimeMonitoring: () => ({stop: () => { throw new Error('monitor stop failed') }}),
			createExtensions: () => ({shutdown: shutdownExporter})
		})

		await expect(performance.shutdown()).resolves.toBeUndefined()
		expect(shutdownExporter).toHaveBeenCalledOnce()
		expect(performance.getStatus()).toMatchObject({state: 'closed', sinkState: 'closed'})
	})

	it('emits frozen dimension events and detaches idempotently', async() => {
		const performance = createBasePerformanceHandler({
			clock: createFixedClock(1),
			cardinalityLimit: 0,
			cardinalityMode: 'warn',
			enableEventLoopMonitor: false,
			enableGCMonitor: false,
			enableResourceMonitor: false
		})
		const listener = vi.fn()
		const detach = attachPerformanceObservability(performance, listener)

		performance.record('attacker_controlled_metric', 1, {tenant: 'attacker-controlled-value'})
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'dimension_explosion', reason: 'limit-exceeded'
		}))
		expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true)
		detach(); detach()
		listener.mockClear()
		performance.record('second_metric', 1)
		expect(listener).not.toHaveBeenCalled()
		await performance.shutdown()
	})

	it('provides the retained API and frozen limited status for every preset', async() => {
		for (const performance of [
			await createDevelopmentPerformance({clock: createFixedClock(1)}),
			await createProductionPerformance({clock: createFixedClock(1)}),
			await createCustomPerformance({clock: createFixedClock(1)})
		]) {
			expect(Object.keys(performance).sort()).toEqual([
				'flush', 'getBudgetStatus', 'getStatus', 'measureAsync', 'measureDBQuery',
				'measureDBQuerySync', 'measureRequest', 'measureSpan', 'measureSync', 'record', 'shutdown'
			].sort())
			expect(Object.isFrozen(performance.getStatus())).toBe(true)
			expect(performance.getStatus()).toMatchObject({state: 'running', activeMeasurements: 0, queueSize: 0})
			await performance.shutdown()
			expect(performance.getStatus()).toMatchObject({state: 'closed', sinkState: 'closed'})
		}
	})

	it('drains an accepted operation, closes admission, and keeps business callbacks exactly once', async() => {
		const gate = deferred<string>()
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		const operation = vi.fn(async() => await gate.promise)
		const measured = performance.measureAsync('request', operation)
		await Promise.resolve()
		const shutdown = performance.shutdown()
		expect(performance.getStatus()).toMatchObject({state: 'draining', activeMeasurements: 1})
		const afterDrain = vi.fn(async() => 'direct')
		await expect(performance.measureAsync('request', afterDrain)).resolves.toBe('direct')
		gate.resolve('ok')
		await expect(measured).resolves.toBe('ok')
		await shutdown
		expect(operation).toHaveBeenCalledOnce()
		expect(afterDrain).toHaveBeenCalledOnce()
	})

	it('preserves successful active-operation drain when timer cleanup fails', async() => {
		const gate = deferred<string>()
		const timer = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(1 as never)
		const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => { throw new Error('clear unavailable') })
		try {
			const performance = await createCustomPerformance({clock: createFixedClock(1)})
			const measured = performance.measureAsync('request', async() => await gate.promise)
			await Promise.resolve()
			const shutdown = performance.shutdown()
			gate.resolve('ok')
			await expect(measured).resolves.toBe('ok')
			await expect(shutdown).resolves.toBeUndefined()
			expect(performance.getStatus()).toMatchObject({state: 'closed', activeMeasurements: 0})
		} finally {
			timer.mockRestore()
			clear.mockRestore()
		}
	})

	it('flushes without closing admission and isolates observability listeners', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		const listener = vi.fn(() => { throw new Error('observer') })
		const dispose = attachPerformanceObservability(performance, listener)
		await performance.flush()
		performance.record('request', 5)
		expect(performance.getStatus().state).toBe('running')
		expect(listener).toHaveBeenCalled()
		dispose(); dispose()
		await performance.shutdown()
	})

	it('validates declarative custom options and allows optional budgets', async() => {
		await expect(createCustomPerformance({destinations: new Array(3).fill({name: 'x', exporter: {export() {}}})} as never))
			.rejects.toThrow('at most two')
		await expect(createCustomPerformance({delivery: {flushIntervalMs: 1}})).rejects.toThrow('requires at least one destination')
		await expect(createCustomPerformance({n1Detection: {enabled: false} as never})).rejects.toThrow('enabled: true')
		const coerceName = vi.fn(() => 'destination')
		await expect(createCustomPerformance({
			destinations: [{name: {toString: coerceName} as never, exporter: {export() {}}}]
		})).rejects.toThrow('safe identifiers')
		expect(coerceName).not.toHaveBeenCalled()
	})

	it('rejects proxy configuration before invoking ownKeys', async() => {
		const ownKeys = vi.fn(() => ['clock'])
		const options = new Proxy({}, {ownKeys})
		await expect(createCustomPerformance(options as never)).rejects.toThrow('closed plain data object')
		expect(ownKeys).not.toHaveBeenCalled()
	})

	it('rejects oversized preset, custom, and resource keys before policy scans', async() => {
		const oversizedKey = 'x'.repeat(1_048_577)
		const setHas = vi.spyOn(Set.prototype, 'has')
		try {
			await expect(createDevelopmentPerformance({[oversizedKey]: true} as never))
				.rejects.toThrow('closed plain data object')
			await expect(createProductionPerformance({[oversizedKey]: true} as never))
				.rejects.toThrow('closed plain data object')
			await expect(createCustomPerformance({[oversizedKey]: true} as never))
				.rejects.toThrow('closed plain data object')
			expect(setHas.mock.calls.some(([value]) => value === oversizedKey)).toBe(false)
		} finally {
			setHas.mockRestore()
		}

		await expect(createCustomPerformance({
			resource: {serviceName: 'service', attributes: {[oversizedKey]: 'value'}}
		})).rejects.toThrow('attribute keys must be at most 128 characters')

		const budgetSetHas = vi.spyOn(Set.prototype, 'has')
		try {
			await expect(createCustomPerformance({
				budgets: [{name: oversizedKey, target: 1, window: 1}]
			})).rejects.toThrow('at most 128 characters')
			expect(budgetSetHas.mock.calls.some(([value]) => value === oversizedKey)).toBe(false)
		} finally {
			budgetSetHas.mockRestore()
		}
	})

	it('rejects oversized budget status keys before map lookup', async() => {
		const oversizedName = 'x'.repeat(1_048_577)
		const performance = await createCustomPerformance({
			clock: createFixedClock(1),
			budgets: [{name: 'request', target: 1, window: 1}]
		})
		const mapGet = vi.spyOn(Map.prototype, 'get')
		try {
			expect(performance.getBudgetStatus?.(oversizedName)).toBeUndefined()
			expect(mapGet.mock.calls.some(([value]) => value === oversizedName)).toBe(false)
		} finally {
			mapGet.mockRestore()
			await performance.shutdown()
		}
	})

	it('does not invoke lifecycle registration accessors or proxy traps', async() => {
		const readFlush = vi.fn(() => vi.fn())
		const accessorLifecycle = Object.defineProperty({}, 'registerFlushHook', {get: readFlush})
		const accessorPerformance = await createCustomPerformance({lifecycle: accessorLifecycle as never})
		expect(readFlush).not.toHaveBeenCalled()
		await accessorPerformance.shutdown()

		const getPrototypeOf = vi.fn(() => Object.prototype)
		const proxyLifecycle = new Proxy({}, {getPrototypeOf})
		const proxyPerformance = await createCustomPerformance({lifecycle: proxyLifecycle as never})
		expect(getPrototypeOf).not.toHaveBeenCalled()
		await proxyPerformance.shutdown()
	})

	it('contains rejected registration and disposer promises from lifecycle ports', async() => {
		const dispose = vi.fn(() => Promise.reject(new Error('dispose failed')))
		const lifecycle = {
			registerFlushHook: vi.fn(() => Promise.reject(new Error('registration failed'))),
			registerShutdownHook: vi.fn(() => dispose)
		}
		const performance = await createCustomPerformance({lifecycle: lifecycle as never})

		await expect(performance.shutdown()).resolves.toBeUndefined()
		await Promise.resolve()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('does not inspect proxy error ports during setup or reporting', async() => {
		const getOwnPropertyDescriptor = vi.fn(() => ({configurable: true, value: vi.fn()}))
		const errors = new Proxy({}, {getOwnPropertyDescriptor})
		const performance = await createCustomPerformance({errors: errors as never})
		performance.record('', 1)
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		await performance.shutdown()
	})

	it('rejects accessor-backed event labels without invoking them', async() => {
		const readLabel = vi.fn(() => 'secret')
		const labels = Object.defineProperty({}, 'token', {enumerable: true, get: readLabel})
		const performance = await createCustomPerformance({clock: createFixedClock(1)})

		expect(() => performance.record('request', 1, labels as never)).not.toThrow()
		expect(readLabel).not.toHaveBeenCalled()
		expect(performance.getStatus()).toMatchObject({droppedTotal: 1})
		await performance.shutdown()
	})

	it('rejects duplicate observability attachment and allows reattachment after detach', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		const dispose = attachPerformanceObservability(performance, vi.fn())
		expect(() => attachPerformanceObservability(performance, vi.fn()))
			.toThrow('PERFORMANCE_OBSERVABILITY_ATTACHED')
		dispose()
		const second = attachPerformanceObservability(performance, vi.fn())
		second()
		await performance.shutdown()
	})

	it('captures destination capabilities before asynchronous module loading', async() => {
		const original = vi.fn(async() => undefined)
		const replacement = vi.fn(async() => undefined)
		const exporter = {export: original}
		const destinations = [{name: 'stable', exporter}]
		const creating = createCustomPerformance({
			clock: createFixedClock(1), destinations,
			delivery: {flushIntervalMs: 0}
		})
		destinations[0] = {name: 'replaced', exporter: {export: replacement}}
		exporter.export = replacement
		const performance = await creating
		performance.record('request', 1)
		await performance.flush()

		expect(original).toHaveBeenCalledOnce()
		expect(replacement).not.toHaveBeenCalled()
		await performance.shutdown()
	})

	it('rejects accessor-backed custom arrays without invoking their items', async() => {
		const readDestination = vi.fn(() => ({name: 'unsafe', exporter: {export: vi.fn()}}))
		const destinations: unknown[] = []
		Object.defineProperty(destinations, '0', {enumerable: true, get: readDestination})
		Object.defineProperty(destinations, 'length', {value: 1})

		await expect(createCustomPerformance({destinations: destinations as never}))
			.rejects.toThrow('stable data items')
		expect(readDestination).not.toHaveBeenCalled()
	})

	it('exports only a stable DB failure code and never raw database errors', async() => {
		const batches: unknown[] = []
		const performance = await createCustomPerformance({
			clock: createFixedClock(1),
			resource: {serviceName: 'tests', attributes: {
				region: 'eu', apiToken: 'resource-secret', credential: 'short-secret'
			}},
			destinations: [{name: 'recording', exporter: {async export(batch) { batches.push(...batch) }}}],
			delivery: {flushIntervalMs: 0}
		})
		await expect(performance.measureDBQuery(
			'db.documents.select',
			async() => { throw new Error('password=database-secret') },
			{operation: 'select', queryHash: 'stable-hash', error: 'database-secret'} as never,
			{credential: 'label-secret'}
		)).rejects.toThrow('database-secret')
		await performance.flush()
		expect(batches).toHaveLength(1)
		expect(batches[0]).toMatchObject({
			event: {labels: {credential: '[redacted]'}, dbMetadata: {
				operation: 'select', queryHash: 'stable-hash', success: false, failureCode: 'query_failed'
			}},
			resource: {serviceName: 'tests', attributes: {
				region: 'eu', apiToken: '[redacted]', credential: '[redacted]'
			}}
		})
		expect(JSON.stringify(batches)).not.toContain('database-secret')
		expect(JSON.stringify(batches)).not.toContain('resource-secret')
		expect(JSON.stringify(batches)).not.toContain('label-secret')
		await performance.shutdown()
	})
})
