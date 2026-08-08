import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createBasePerformanceHandler} from '../../src/performance/core/base-handler'
import {createCustomPerformance} from '../../src/performance/public/custom'
import {attachPerformanceObservability} from '../../src/performance/public/observability'

describe('performance observability attachment', () => {
	it('rejects invalid listeners without inspecting arbitrary properties', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		expect(() => attachPerformanceObservability(performance, {} as never))
			.toThrow('performance_invalid_observability')
		await performance.shutdown()
	})

	it('rejects runtimes that do not own a registered dispatcher', () => {
		expect(() => attachPerformanceObservability({} as never, vi.fn()))
			.toThrow('PERFORMANCE_TELEMETRY_UNAVAILABLE')
	})

	it('emits immutable budget violations', async() => {
		const performance = await createCustomPerformance({
			clock: createFixedClock(1), budgets: [{name: 'slow', target: 0, window: 1_000}]
		})
		const listener = vi.fn()
		const detach = attachPerformanceObservability(performance, listener)
		performance.record('slow', 1)
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({kind: 'budget_violation'}))
		expect(Object.isFrozen(listener.mock.calls.find(([event]) => event.kind === 'budget_violation')?.[0])).toBe(true)
		detach()
		await performance.shutdown()
	})

	it('emits bounded self metrics without exposing runtime state', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		const listener = vi.fn()
		const detach = attachPerformanceObservability(performance, listener)
		performance.record('request', 5)
		expect(listener).toHaveBeenCalledWith({
			kind: 'self_metric', name: '_performance_recorded_total', value: 1, labels: {source: 'mark'}
		})
		detach()
		await performance.shutdown()
	})

	it('emits performance events while isolating observer failures', async() => {
		const listener = vi.fn(() => { throw new Error('observer failed') })
		const performance = createBasePerformanceHandler({
			clock: createFixedClock(1), cardinalityLimit: 10, cardinalityMode: 'drop',
			enableEventLoopMonitor: false, enableGCMonitor: false, enableResourceMonitor: false,
			callbacks: {onSaturationAlert: () => undefined}
		})
		const detach = attachPerformanceObservability(performance, listener)
		performance.record('request', 1)
		expect(listener).toHaveBeenCalled()
		detach()
		await expect(performance.shutdown()).resolves.toBeUndefined()
	})

	it('observes rejected async listeners and bounds unresolved callbacks', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('observer failed')))
		const listener = vi.fn(() => rejected)
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		const detach = attachPerformanceObservability(performance, listener as never)
		try {
			performance.record('first', 1)
			performance.record('second', 1)
			expect(speciesReads).toBeGreaterThan(0)
			expect(listener.mock.calls.length).toBeLessThan(6)
		} finally {
			detach()
			await rejected.catch(() => undefined)
			await performance.shutdown()
		}
	})

	it('bounds listeners that synchronously record another measurement', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		const listener = vi.fn(() => performance.record('nested', 1))
		const detach = attachPerformanceObservability(performance, listener)
		try {
			expect(() => performance.record('root', 1)).not.toThrow()
			expect(listener.mock.calls.length).toBeLessThan(20)
		} finally {
			detach()
			await performance.shutdown()
		}
	})

	it('preserves the re-entry fence across synchronous detach and re-attach', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		let detach = () => undefined
		const listener = vi.fn(() => {
			detach()
			detach = attachPerformanceObservability(performance, listener)
			performance.record('nested', 1)
		})
		detach = attachPerformanceObservability(performance, listener)
		try {
			expect(() => performance.record('root', 1)).not.toThrow()
			expect(listener.mock.calls.length).toBeLessThan(20)
		} finally {
			detach()
			await performance.shutdown()
		}
	})

	it('preserves the runtime fence when a pending listener replaces its attachment', async() => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => { release = resolve })
		const performance = await createCustomPerformance({clock: createFixedClock(1)})
		let detach = () => undefined
		const listener = vi.fn(() => {
			if (listener.mock.calls.length === 1) queueMicrotask(() => {
				detach()
				detach = attachPerformanceObservability(performance, listener as never)
				performance.record('nested', 1)
			})
			return pending
		})
		detach = attachPerformanceObservability(performance, listener as never)
		try {
			performance.record('root', 1)
			await Promise.resolve()
			await Promise.resolve()
			expect(listener).toHaveBeenCalledOnce()
			release()
			await pending
			await Promise.resolve()
			performance.record('after-settlement', 1)
			expect(listener.mock.calls.length).toBeGreaterThan(1)
		} finally {
			release()
			await pending
			await Promise.resolve()
			detach()
			await performance.shutdown()
		}
	})

	it('recovers after listener timeout without letting late settlement clear a new fence', async() => {
		vi.useFakeTimers()
		try {
			const performance = await createCustomPerformance({clock: createFixedClock(1)})
			let releaseStalled!: () => void
			const stalledPromise = new Promise<void>((resolve) => { releaseStalled = resolve })
			const stalled = vi.fn(() => stalledPromise)
			const detachStalled = attachPerformanceObservability(performance, stalled as never)
			performance.record('first', 1)
			performance.record('blocked', 1)
			expect(stalled).toHaveBeenCalledOnce()

			await vi.advanceTimersByTimeAsync(5_000)
			performance.record('disabled', 1)
			expect(stalled).toHaveBeenCalledOnce()
			detachStalled()

			let releaseRecovered!: () => void
			const recoveredPromise = new Promise<void>((resolve) => { releaseRecovered = resolve })
			const recovered = vi.fn(() => recoveredPromise)
			const detachRecovered = attachPerformanceObservability(performance, recovered)
			performance.record('recovered', 1)
			expect(recovered).toHaveBeenCalledOnce()
			releaseStalled()
			await stalledPromise
			await Promise.resolve()
			performance.record('still-blocked', 1)
			expect(recovered).toHaveBeenCalledOnce()
			releaseRecovered()
			await recoveredPromise
			detachRecovered()
			await performance.shutdown()
		} finally {
			vi.useRealTimers()
		}
	})
})
