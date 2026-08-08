import {describe, expect, it, vi} from 'vitest'

import {
	attachCacheObservability,
	type CacheObservabilityEvent
} from '../../src/cache/public/observability'
import {
	emitCacheTelemetry,
	registerCacheTelemetryTarget
} from '../../src/cache/runtime-capabilities'

function runtime() {
	return {
		getStatus: () => Object.freeze({
			state: 'running', activeOperations: 0, activeLoads: 0,
			droppedTotal: 0, backendState: 'healthy'
		}),
		flush: async() => undefined,
		shutdown: async() => undefined
	} as never
}

describe('cache observability attachment', () => {
	it('delivers the bounded frozen event vocabulary unchanged', () => {
		const cache = runtime()
		const controller = {}
		registerCacheTelemetryTarget(cache, controller)
		const events: CacheObservabilityEvent[] = []
		const detach = attachCacheObservability(cache, (event) => events.push(event))

		emitCacheTelemetry(controller, {kind: 'operation', operation: 'get', result: 'success'})
		emitCacheTelemetry(controller, {kind: 'lookup', result: 'fresh'})
		emitCacheTelemetry(controller, {kind: 'dropped', reason: 'capacity'})
		emitCacheTelemetry(controller, {kind: 'active_operations', count: 1})
		emitCacheTelemetry(controller, {kind: 'active_loads', count: 1})
		emitCacheTelemetry(controller, {
			kind: 'backend_failed', operation: 'read', code: 'CACHE_BACKEND_FAILURE'
		})
		emitCacheTelemetry(controller, {
			kind: 'finalization_failed', operation: 'flush', code: 'CACHE_FLUSH_FAILURE'
		})
		emitCacheTelemetry(controller, {kind: 'recovered'})

		expect(events.map((event) => event.kind)).toEqual([
			'operation', 'lookup', 'dropped', 'active_operations', 'active_loads',
			'backend_failed', 'finalization_failed', 'recovered'
		])
		expect(events.every(Object.isFrozen)).toBe(true)
		detach()
	})

	it('allows one observer and provides an idempotent disposer', () => {
		const cache = runtime()
		const controller = {}
		registerCacheTelemetryTarget(cache, controller)
		const detach = attachCacheObservability(cache, vi.fn())
		expect(() => attachCacheObservability(cache, vi.fn())).toThrow('already attached')
		detach()
		detach()
		expect(() => attachCacheObservability(cache, vi.fn())).not.toThrow()
	})

	it('isolates listener failures from cache telemetry emission', () => {
		const cache = runtime()
		const controller = {}
		registerCacheTelemetryTarget(cache, controller)
		attachCacheObservability(cache, () => { throw new Error('observer failure') })
		expect(() => emitCacheTelemetry(controller, {
			kind: 'backend_failed', operation: 'read', code: 'CACHE_BACKEND_FAILURE'
		})).not.toThrow()
	})

	it('rejects invalid listeners without claiming attachment ownership', () => {
		const cache = runtime()
		const controller = {}
		registerCacheTelemetryTarget(cache, controller)
		expect(() => attachCacheObservability(cache, undefined as never)).toThrow(TypeError)
		expect(() => attachCacheObservability(cache, vi.fn())).not.toThrow()
	})
})
