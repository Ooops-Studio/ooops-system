import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createCustomTracing} from '../src/public/custom'

describe('managed tracing contract', () => {
	it('does not assimilate thenables returned by the public custom exporter adapter', async() => {
		const then = vi.fn()
		const tracing = await createCustomTracing({
			clock: createFixedClock(100),
			destination: {provider: 'custom', exporter: {export: () => ({then}) as never}}
		})

		tracing.startSpan('hostile-export').end()
		await expect(tracing.forceFlush()).rejects.toThrow('must return a native Promise')
		expect(then).not.toHaveBeenCalled()
	})

	it('exposes a frozen bounded status and drains active spans before closing', async() => {
		const exported: unknown[] = []
		const shutdownExporter = vi.fn(async() => undefined)
		const tracing = await createCustomTracing({
			clock: createFixedClock(100),
			sampling: {strategy: 'fixed-rate', rate: 1},
			destination: {provider: 'custom', exporter: {
				export: async(batch) => { exported.push(...batch) },
				shutdown: shutdownExporter
			}}
		})
		const span = tracing.startSpan('manual')
		const status = tracing.getStatus()
		expect(Object.isFrozen(status)).toBe(true)
		expect(status).toMatchObject({state: 'running', activeSpans: 1, sinkState: 'healthy'})
		const closing = tracing.shutdown()
		expect(tracing.getStatus().state).toBe('draining')
		expect(() => tracing.startSpan('late')).not.toThrow()
		expect(tracing.getStatus().droppedTotal).toBeGreaterThan(0)
		span.end()
		await closing
		expect(tracing.getStatus()).toMatchObject({state: 'closed', activeSpans: 0, sinkState: 'closed'})
		expect(exported).toHaveLength(1)
		expect(shutdownExporter).toHaveBeenCalledOnce()
		await expect(Promise.all([tracing.shutdown(), tracing.shutdown()])).resolves.toBeDefined()
	})

	it('keeps failed shutdown draining and retries only finalization', async() => {
		let attempts = 0
		const tracing = await createCustomTracing({
			clock: createFixedClock(100),
			destination: {provider: 'custom', exporter: {
				export: async() => undefined,
				shutdown: async() => { if (++attempts === 1) throw Object.assign(new Error('failed'), {code: 'EXPORT_CLOSE_FAILED'}) }
			}}
		})
		await expect(tracing.shutdown()).rejects.toThrow()
		expect(tracing.getStatus()).toMatchObject({
			state: 'draining', sinkState: 'unhealthy', lastFailureCode: 'TRACING_FINALIZATION_FAILURE'
		})
		await expect(tracing.shutdown()).resolves.toBeUndefined()
		expect(tracing.getStatus().state).toBe('closed')
		expect(attempts).toBe(2)
	})

	it('does not expose the removed per-span sampling override', async() => {
		const tracing = await createCustomTracing({
			clock: createFixedClock(100),
			sampling: {strategy: 'fixed-rate', rate: 0},
			destination: {provider: 'custom', exporter: {export: async() => undefined}}
		})
		expect(() => tracing.startSpan('invalid', {sample: false} as never)).toThrow('closed plain data object')
		await tracing.inSpan('sampled-out', async() => undefined)
		expect(tracing.getStatus().droppedTotal).toBeGreaterThan(0)
		await tracing.shutdown()
	})

	it('propagates forceFlush to an optional custom exporter flush barrier', async() => {
		const flush = vi.fn(async() => undefined)
		const tracing = await createCustomTracing({
			clock: createFixedClock(100),
			destination: {provider: 'custom', exporter: {export: async() => undefined, flush}}
		})
		await tracing.forceFlush()
		expect(flush).toHaveBeenCalledOnce()
		await tracing.shutdown()
		expect(flush).toHaveBeenCalledTimes(2)
	})

	it('reports partial delivery as degraded and clears it after recovery', async() => {
		let attempt = 0
		const tracing = await createCustomTracing({
			clock: createFixedClock(100),
			destination: {provider: 'custom', exporter: {export: async() => ++attempt === 1
				? {status: 'partial', acceptedCount: 0}
				: {status: 'success', acceptedCount: 1}}}
		})
		tracing.startSpan('partial').end()
		await expect(tracing.forceFlush()).rejects.toThrow('partial')
		expect(tracing.getStatus()).toMatchObject({sinkState: 'degraded', lastFailureCode: 'TRACING_EXPORT_FAILURE'})
		tracing.startSpan('recovered').end()
		await tracing.forceFlush()
		expect(tracing.getStatus()).toMatchObject({sinkState: 'healthy'})
		expect(tracing.getStatus()).not.toHaveProperty('lastFailureCode')
		await tracing.shutdown()
	})
})
