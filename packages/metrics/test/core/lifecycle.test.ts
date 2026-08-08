import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {describe, expect, it, vi} from 'vitest'

import {hasManagedMetricsLifecycle, wireMetricsLifecycle} from '../../src/core/lifecycle'
import type {MetricsHandlerPort} from '../../src/types/ports'

function createHandler(): MetricsHandlerPort {
	return {
		increment: vi.fn(), record: vi.fn(), counter: vi.fn(), upDownCounter: vi.fn(),
		gauge: vi.fn(), histogram: vi.fn(), timer: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
		shutdown: vi.fn().mockResolvedValue(undefined)
	}
}

describe('metrics lifecycle wiring', () => {
	it('awaits shutdown rollback and disposes registered hooks when wiring fails', async() => {
		const handler = createHandler()
		const dispose = vi.fn()
		const lifecycle: LifecyclePort = {
			registerShutdownHook: () => dispose,
			registerFlushHook: () => { throw new Error('flush registration failed') }
		}
		await expect(wireMetricsLifecycle(handler, lifecycle)).rejects.toThrow('flush registration failed')
		expect(handler.shutdown).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('wires flush and shutdown once and deactivates after successful shutdown', async() => {
		const handler = createHandler()
		const shutdown = handler.shutdown as ReturnType<typeof vi.fn>
		const disposeShutdown = vi.fn()
		const disposeFlush = vi.fn()
		const lifecycle = {
			registerShutdownHook: vi.fn(() => disposeShutdown),
			registerFlushHook: vi.fn(() => disposeFlush)
		}
		const managed = await wireMetricsLifecycle(handler, lifecycle satisfies LifecyclePort)
		expect(managed).toBe(handler)
		expect(hasManagedMetricsLifecycle(managed)).toBe(true)
		await wireMetricsLifecycle(handler, lifecycle satisfies LifecyclePort)
		expect(lifecycle.registerShutdownHook).toHaveBeenCalledOnce()
		expect(lifecycle.registerFlushHook).toHaveBeenCalledOnce()

		await lifecycle.registerFlushHook.mock.calls[0]![1]()
		await lifecycle.registerShutdownHook.mock.calls[0]![1]({reason: 'manual', startedAt: 0, duration: 0})
		expect(handler.flush).toHaveBeenCalledOnce()
		expect(shutdown).toHaveBeenCalledOnce()
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledOnce()
	})

	it('reports sanitized hook failures without replacing them', async() => {
		const original = new Error('private exporter failure')
		const handler = createHandler()
		handler.shutdown = vi.fn().mockRejectedValue(original)
		const onError = vi.fn()
		const logger = {
			level: 'warn' as const,
			trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
			error: vi.fn(), fatal: vi.fn(), context: vi.fn()
		}
		const lifecycle = {
			registerShutdownHook: vi.fn(() => vi.fn()),
			registerFlushHook: vi.fn(() => vi.fn())
		}
		await wireMetricsLifecycle(handler, lifecycle satisfies LifecyclePort, {onError, logger})
		const hook = lifecycle.registerShutdownHook.mock.calls[0]![1]
		await expect(hook({reason: 'manual', startedAt: 0, duration: 0})).rejects.toBe(original)
		expect(onError).toHaveBeenCalledWith(original, {operation: 'shutdown'})
		expect(logger.warn).toHaveBeenCalledWith('metrics.lifecycle_hook_failed', {
			operation: 'shutdown', error: 'metrics_lifecycle_hook_failed'
		})
		expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private exporter failure')
	})

	it('rejects accessor-backed hook capabilities without executing them', async() => {
		const handler = createHandler()
		const getter = vi.fn(() => vi.fn())
		const lifecycle = Object.defineProperty({
			registerShutdownHook: vi.fn(() => vi.fn())
		}, 'registerFlushHook', {enumerable: true, get: getter})

		await expect(wireMetricsLifecycle(handler, lifecycle as never))
			.rejects.toThrow('stable shutdown and flush registration functions')
		expect(getter).not.toHaveBeenCalled()
		expect(handler.shutdown).toHaveBeenCalledOnce()
	})

	it('rejects missing lifecycle capabilities and shuts down the unowned handler', async() => {
		const handler = createHandler()
		const lifecycle = {registerShutdownHook: vi.fn(() => vi.fn())}

		await expect(wireMetricsLifecycle(handler, lifecycle as never))
			.rejects.toThrow('stable shutdown and flush registration functions')
		expect(handler.shutdown).toHaveBeenCalledOnce()
	})

	it('rejects invalid disposers and rolls back previously registered hooks', async() => {
		const handler = createHandler()
		const disposeShutdown = vi.fn()
		const lifecycle = {
			registerShutdownHook: vi.fn(() => disposeShutdown),
			registerFlushHook: vi.fn(() => undefined)
		}

		await expect(wireMetricsLifecycle(handler, lifecycle as never))
			.rejects.toThrow('registration must return a disposer')
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(handler.shutdown).toHaveBeenCalledOnce()
	})

	it('rolls back hooks when the handler cannot be marked as lifecycle-managed', async() => {
		const handler = Object.preventExtensions(createHandler())
		const shutdown = handler.shutdown as ReturnType<typeof vi.fn>
		const disposeShutdown = vi.fn()
		const disposeFlush = vi.fn()
		const lifecycle = {
			registerShutdownHook: vi.fn(() => disposeShutdown),
			registerFlushHook: vi.fn(() => disposeFlush)
		}

		await expect(wireMetricsLifecycle(handler, lifecycle satisfies LifecyclePort)).rejects.toThrow()
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledOnce()
		expect(shutdown).toHaveBeenCalledOnce()
		expect(hasManagedMetricsLifecycle(handler)).toBe(false)
	})

	it('returns the handler unchanged without lifecycle ownership', async() => {
		const handler = createHandler()
		expect(await wireMetricsLifecycle(handler)).toBe(handler)
		expect(hasManagedMetricsLifecycle(undefined)).toBe(false)
	})
})
