import {afterEach, describe, expect, it, vi} from 'vitest'

import {createCustomLifecycle} from '../../src/public/custom'

function runtime() {
	const clock = {now: Date.now}
	return createCustomLifecycle({
		clock,
		monotonicClock: clock,
		shutdown: {drainGracePeriodMs: 0},
		health: {intervalMs: 10, checkTimeoutMs: 100, runTimeoutMs: 100, concurrency: 2}
	})
}

afterEach(() => vi.useRealTimers())

describe('lifecycle health policy', () => {
	it('marks required checks unhealthy on exactly the third consecutive failure', async() => {
		vi.useFakeTimers()
		const lifecycle = runtime()
		lifecycle.registerHealthCheck({
			name: 'database', criticality: 'required', check: () => ({healthy: false, code: 'DB_DOWN'})
		})
		await lifecycle.start()
		expect(lifecycle.getStatus().health).toBe('degraded')
		await vi.advanceTimersByTimeAsync(10)
		expect(lifecycle.getStatus().health).toBe('degraded')
		await vi.advanceTimersByTimeAsync(10)
		expect(lifecycle.getStatus().health).toBe('unhealthy')
		expect(lifecycle.getHealthSnapshot().checks.database?.consecutiveFailures).toBe(3)
		await lifecycle.shutdown()
	})

	it('keeps optional failures degraded and recovers counters after one success', async() => {
		vi.useFakeTimers()
		const lifecycle = runtime()
		let healthy = false
		lifecycle.registerHealthCheck({
			name: 'storage', criticality: 'optional', check: () => healthy ? {healthy: true} : {healthy: false}
		})
		await lifecycle.start()
		await vi.advanceTimersByTimeAsync(50)
		expect(lifecycle.getStatus().health).toBe('degraded')
		healthy = true
		await vi.advanceTimersByTimeAsync(10)
		expect(lifecycle.getStatus().health).toBe('healthy')
		expect(lifecycle.getHealthSnapshot().checks.storage?.consecutiveFailures).toBe(0)
		await lifecycle.shutdown()
	})

	it('applies critical required failures immediately and manual degradation without scoring', async() => {
		const lifecycle = runtime()
		lifecycle.registerHealthCheck({
			name: 'primary', criticality: 'required', check: () => ({healthy: false, critical: true})
		})
		await lifecycle.start()
		expect(lifecycle.getStatus().health).toBe('unhealthy')

		const manual = runtime()
		manual.recordDegradation('lag', 'warning')
		expect(manual.getStatus().health).toBe('degraded')
		manual.clearDegradation('lag')
		expect(manual.getStatus().health).toBe('healthy')
		manual.recordDegradation('fatal', 'critical')
		expect(manual.getStatus().health).toBe('unhealthy')
		manual.clearDegradation()
		expect(manual.getStatus().health).toBe('healthy')
		await lifecycle.shutdown()
		await manual.shutdown()
	})

	it('keeps timed-out physical health work owned without failing startup or overlapping runs', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const check = vi.fn(async() => {
			await gate
			return {healthy: true} as const
		})
		const lifecycle = createCustomLifecycle({
			clock: {now: Date.now},
			shutdown: {drainGracePeriodMs: 0},
			health: {intervalMs: 1, checkTimeoutMs: 100, runTimeoutMs: 5, concurrency: 1}
		})
		lifecycle.registerHealthCheck({name: 'slow', criticality: 'required', check})
		const starting = lifecycle.start()
		await vi.advanceTimersByTimeAsync(5)
		await expect(starting).resolves.toBeUndefined()
		expect(lifecycle.getStatus()).toMatchObject({state: 'running', health: 'degraded', failedChecks: 1})

		await vi.advanceTimersByTimeAsync(20)
		expect(check).toHaveBeenCalledOnce()
		release()
		await vi.runAllTicks()
		await lifecycle.shutdown()
	})
})
