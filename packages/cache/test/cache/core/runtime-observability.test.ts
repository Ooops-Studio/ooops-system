import {describe, expect, it} from 'vitest'

import {createCacheRuntimeObservability} from '../../../src/cache/core/runtime-observability'
import {CacheTimeoutError} from '../../../src/cache/core/runtime-safety'

describe('cache internal delivery telemetry', () => {
	it('projects only bounded public status and clears transient failures on recovery', () => {
		const telemetry = createCacheRuntimeObservability()
		telemetry.reportError(new Error('private backend message'), 'get')
		const failed = telemetry.snapshot('running', 2)
		expect(failed).toEqual({
			state: 'running', activeOperations: 2, activeLoads: 0, droppedTotal: 0,
			backendState: 'unhealthy', lastFailureCode: 'CACHE_BACKEND_FAILURE'
		})
		expect(JSON.stringify(failed)).not.toContain('private backend message')
		expect(Object.isFrozen(failed)).toBe(true)
		telemetry.markBackendSuccess()
		expect(telemetry.snapshot('running', 0)).toEqual({
			state: 'running', activeOperations: 0, activeLoads: 0,
			droppedTotal: 0, backendState: 'healthy'
		})
	})

	it('tracks timeout settlement and finalization failure independently', () => {
		const telemetry = createCacheRuntimeObservability()
		telemetry.markBackendTimeout()
		expect(telemetry.snapshot('running', 0)).toMatchObject({backendState: 'degraded'})
		telemetry.markBackendSettlement(true)
		expect(telemetry.snapshot('running', 0)).toMatchObject({backendState: 'healthy'})
		telemetry.reportError(new Error('flush failed'), 'flush')
		expect(telemetry.snapshot('draining', 0)).toMatchObject({
			backendState: 'unhealthy', lastFailureCode: 'CACHE_FLUSH_FAILURE'
		})
	})

	it('does not let an older timeout settlement erase a newer backend failure', () => {
		const telemetry = createCacheRuntimeObservability()
		telemetry.markBackendTimeout()
		telemetry.reportError(new Error('newer backend failure'), 'get')
		telemetry.markBackendSettlement(true)

		expect(telemetry.snapshot('running', 0)).toMatchObject({
			backendState: 'unhealthy', lastFailureCode: 'CACHE_BACKEND_FAILURE'
		})
	})

	it('does not reclassify an explicitly tracked timeout at an outer boundary', () => {
		const telemetry = createCacheRuntimeObservability()
		telemetry.markBackendTimeout()
		telemetry.reportError(new CacheTimeoutError('timed out'), 'flush')
		expect(telemetry.snapshot('running', 0)).toMatchObject({
			backendState: 'degraded', lastFailureCode: 'CACHE_BACKEND_TIMEOUT'
		})

		telemetry.markBackendSettlement(true)
		expect(telemetry.snapshot('running', 0)).toMatchObject({backendState: 'healthy'})
	})

	it('retains only the unresolved timeout after a newer operation recovers', () => {
		const telemetry = createCacheRuntimeObservability()
		telemetry.markBackendTimeout()
		telemetry.reportError(new Error('newer failure'), 'get')
		telemetry.markBackendSuccess()
		expect(telemetry.snapshot('running', 0)).toMatchObject({
			backendState: 'degraded', lastFailureCode: 'CACHE_BACKEND_TIMEOUT'
		})

		telemetry.markBackendSettlement(true)
		expect(telemetry.snapshot('running', 0)).toMatchObject({backendState: 'healthy'})
	})
})
