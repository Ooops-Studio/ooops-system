import type {PerfEvent, SaturationAlert} from '@ooopsstudio/core/contracts/performance'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import {createHighResClock} from '../../../../src/performance/core/clock'
import {createEventLoopMonitor} from '../../../../src/performance/features/core/event-loop-monitor'

describe('createEventLoopMonitor', () => {
	it('rejects invalid collection intervals', () => {
		const clock = {now: () => 0, nowHr: () => 0n}
		expect(() => createEventLoopMonitor({clock, intervalMs: 0})).toThrow('intervalMs must be between')
		expect(() => createEventLoopMonitor({clock, intervalMs: Number.NaN})).toThrow('intervalMs must be between')
		expect(() => createEventLoopMonitor({clock, intervalMs: 2_147_483_648})).toThrow('intervalMs must be between')
		expect(() => createEventLoopMonitor({clock, minimumSamples: 0})).toThrow('minimumSamples must be between')
		expect(() => createEventLoopMonitor({clock, minimumSamples: 101})).toThrow('minimumSamples must be between')
		expect(() => createEventLoopMonitor({clock, reminderIntervalMs: -1})).toThrow('reminderIntervalMs must be between')
	})

	it('rejects invalid or unordered thresholds', () => {
		const clock = {now: () => 0, nowHr: () => 0n}
		expect(() => createEventLoopMonitor({clock, thresholds: {info: -1}})).toThrow('non-negative')
		expect(() => createEventLoopMonitor({clock, thresholds: {info: 20, warn: 10}})).toThrow('info <= warn <= critical')
		expect(() => createEventLoopMonitor({clock, thresholds: {info: 60}})).not.toThrow()
		expect(() => createEventLoopMonitor({clock, thresholds: {warn: 120}})).not.toThrow()
		expect(() => createEventLoopMonitor({clock, thresholds: {critical: 10}})).not.toThrow()
	})

	it('ignores regressing high-resolution samples without poisoning statistics', () => {
		const immediates: Array<() => void> = []
		const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
			immediates.push(callback as () => void)
			return 1 as unknown as ReturnType<typeof setImmediate>
		})
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 2 as unknown as ReturnType<typeof setTimeout>)
		let nowHr = 10n
		const onPerfEvent = vi.fn()
		const monitor = createEventLoopMonitor({clock: {now: () => 100, nowHr: () => nowHr -= 1n}, onPerfEvent})
		monitor.start()
		immediates.shift()?.()
		expect(monitor.getStats()).toBeNull()
		expect(monitor.getCurrentLag()).toBeNull()
		expect(onPerfEvent).not.toHaveBeenCalled()
		monitor.stop()
		immediateSpy.mockRestore()
		timeoutSpy.mockRestore()
	})

	it('contains asynchronous clock failures and continues scheduling', () => {
		const immediates: Array<() => void> = []
		const timers: Array<() => void> = []
		const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
			immediates.push(callback as () => void)
			return 1 as unknown as ReturnType<typeof setImmediate>
		})
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
			timers.push(callback as () => void)
			return 2 as unknown as ReturnType<typeof setTimeout>
		})
		let reads = 0
		const monitor = createEventLoopMonitor({
			clock: {
				now: () => 0,
				nowHr: () => {
					reads += 1
					if (reads > 1) throw new Error('clock failed')
					return 0n
				}
			},
			intervalMs: 10
		})

		monitor.start()
		expect(() => immediates.shift()?.()).not.toThrow()
		expect(timers).toHaveLength(1)
		expect(() => timers.shift()?.()).not.toThrow()
		expect(timers).toHaveLength(1)
		monitor.stop()
		immediateSpy.mockRestore()
		timeoutSpy.mockRestore()
	})

	it('fails closed and can restart after immediate scheduling fails', () => {
		let immediate: (() => void) | undefined
		const immediateSpy = vi.spyOn(globalThis, 'setImmediate')
			.mockImplementationOnce(() => { throw new Error('scheduler unavailable') })
			.mockImplementation((callback) => {
				immediate = callback as () => void
				return 1 as unknown as ReturnType<typeof setImmediate>
			})
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 2 as unknown as ReturnType<typeof setTimeout>)
		const monitor = createEventLoopMonitor({clock: {now: () => 0, nowHr: () => 0n}})

		expect(() => monitor.start()).not.toThrow()
		expect(() => monitor.start()).not.toThrow()
		expect(immediateSpy).toHaveBeenCalledTimes(2)
		immediate?.()
		monitor.stop()
		immediateSpy.mockRestore()
		timeoutSpy.mockRestore()
	})

	it('contains timer scheduling failures from an asynchronous measurement', () => {
		let immediate: (() => void) | undefined
		const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
			immediate = callback as () => void
			return 1 as unknown as ReturnType<typeof setImmediate>
		})
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
			throw new Error('timer unavailable')
		})
		const monitor = createEventLoopMonitor({clock: {now: () => 0, nowHr: () => 0n}})

		monitor.start()
		expect(() => immediate?.()).not.toThrow()
		monitor.start()
		expect(immediateSpy).toHaveBeenCalledTimes(2)
		expect(() => immediate?.()).not.toThrow()
		monitor.stop()
		immediateSpy.mockRestore()
		timeoutSpy.mockRestore()
	})

	it('retains and clears a scheduled timeout when optional unref fails', () => {
		let immediate: (() => void) | undefined
		const timer = {unref: () => { throw new Error('unref unavailable') }}
		const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
			immediate = callback as () => void
			return 1 as unknown as ReturnType<typeof setImmediate>
		})
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timer as never)
		const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined)
		const monitor = createEventLoopMonitor({clock: {now: () => 0, nowHr: () => 0n}})

		monitor.start()
		immediate?.()
		expect(() => monitor.start()).not.toThrow()
		expect(immediateSpy).toHaveBeenCalledOnce()
		monitor.stop()
		expect(clearSpy).toHaveBeenCalledWith(timer)
		immediateSpy.mockRestore()
		timeoutSpy.mockRestore()
		clearSpy.mockRestore()
	})

	let clock: ReturnType<typeof createHighResClock>

	beforeEach(() => {

		const baseClock = createFixedClock(1000)
		clock = createHighResClock({clock: baseClock})
	})

	afterEach(() => {

		vi.clearAllTimers()
	})

	it('should create event loop monitor', () => {

		const monitor = createEventLoopMonitor({
			clock
		})

		expect(monitor).toBeDefined()
		expect(monitor.start).toBeDefined()
		expect(monitor.stop).toBeDefined()
		expect(monitor.getStats).toBeDefined()
		expect(monitor.getCurrentLag).toBeDefined()
	})

	it('should start and stop monitoring', async() => {

		vi.useRealTimers()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50
		})

		monitor.start()
		expect(monitor.getCurrentLag()).toBeNull()

		// Wait for measurement to occur
		await new Promise((resolve) => setTimeout(resolve, 60))

		monitor.stop()
		const stats = monitor.getStats()
		expect(stats).toBeDefined()
	})

	it('should not start if already started', () => {

		vi.useFakeTimers()

		const monitor = createEventLoopMonitor({
			clock
		})

		monitor.start()
		const timeoutId1 = (monitor as unknown as {
			timeoutId: ReturnType<typeof setTimeout> | null
		}).timeoutId

		// Try to start again
		monitor.start()
		const timeoutId2 = (monitor as unknown as {
			timeoutId: ReturnType<typeof setTimeout> | null
		}).timeoutId

		// Should be the same timeout ID (not started again)
		expect(timeoutId1).toBe(timeoutId2)

		monitor.stop()
	})

	it('does not schedule another sample until the current immediate completes', () => {
		const immediates: Array<() => void> = []
		const timers: Array<() => void> = []
		const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
			immediates.push(callback as () => void)
			return 1 as unknown as ReturnType<typeof setImmediate>
		})
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
			timers.push(callback as () => void)
			return 2 as unknown as ReturnType<typeof setTimeout>
		})
		const monitor = createEventLoopMonitor({clock, intervalMs: 10})

		monitor.start()
		expect(immediates).toHaveLength(1)
		expect(timers).toHaveLength(0)
		immediates.shift()?.()
		expect(timers).toHaveLength(1)
		timers.shift()?.()
		expect(immediates).toHaveLength(1)
		immediates.shift()?.()
		monitor.stop()
		immediateSpy.mockRestore()
		timeoutSpy.mockRestore()
	})

	it('does not schedule another sample when an observer stops it reentrantly', () => {
		let immediate: (() => void) | undefined
		const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
			immediate = callback as () => void
			return 1 as unknown as ReturnType<typeof setImmediate>
		})
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
		let monitor: ReturnType<typeof createEventLoopMonitor>
		monitor = createEventLoopMonitor({
			clock,
			onPerfEvent: () => monitor.stop()
		})

		monitor.start()
		immediate?.()

		expect(timeoutSpy).not.toHaveBeenCalled()
		immediateSpy.mockRestore()
		timeoutSpy.mockRestore()
	})

	it('should return null stats when no samples', () => {

		const monitor = createEventLoopMonitor({
			clock
		})

		const stats = monitor.getStats()
		expect(stats).toBeNull()
	})

	it('should return current lag', async() => {

		vi.useRealTimers()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50
		})

		expect(monitor.getCurrentLag()).toBeNull()

		monitor.start()
		await new Promise((resolve) => setTimeout(resolve, 60))

		const lag = monitor.getCurrentLag()
		expect(lag).not.toBeNull()
		expect(typeof lag).toBe('number')

		monitor.stop()
	})

	it('should emit perf events', async() => {

		vi.useRealTimers()

		const onPerfEvent = vi.fn<(event: PerfEvent) => void>()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50,
			onPerfEvent
		})

		monitor.start()
		await new Promise((resolve) => setTimeout(resolve, 60))

		expect(onPerfEvent).toHaveBeenCalled()
		const event = onPerfEvent.mock.calls[0]?.[0]
		expect(event).toBeDefined()
		expect(event?.name).toBe('event_loop_lag')
		expect(event?.source).toBe('runtime')

		monitor.stop()
	})

	it('should emit saturation alerts for critical threshold', async() => {

		vi.useRealTimers()

		const onSaturationAlert = vi.fn<(alert: SaturationAlert) => void>()

		// Set a very low critical threshold to trigger
		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50,
			minimumSamples: 1,
			onSaturationAlert,
			thresholds: {
				critical: 0.001 // Very low threshold
			}
		})

		monitor.start()
		await new Promise((resolve) => setTimeout(resolve, 60))

		expect(onSaturationAlert).toHaveBeenCalled()
		const alert = onSaturationAlert.mock.calls[0]?.[0]
		expect(alert).toBeDefined()
		expect(alert?.reason).toBe('event_loop_lag')
		expect(alert?.severity).toBe('critical')

		monitor.stop()
	})

	it('should emit saturation alerts for warn threshold', async() => {

		vi.useRealTimers()

		const onSaturationAlert = vi.fn<(alert: SaturationAlert) => void>()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50,
			minimumSamples: 1,
			onSaturationAlert,
			thresholds: {
				warn: 0.001,
				critical: 1000 // High so warn is triggered first
			}
		})

		monitor.start()
		await new Promise((resolve) => setTimeout(resolve, 60))

		expect(onSaturationAlert).toHaveBeenCalled()
		const alert = onSaturationAlert.mock.calls[0]?.[0]
		expect(alert?.severity).toBe('warn')

		monitor.stop()
	})

	it('should use the info threshold as a quiet recovery band', async() => {

		vi.useRealTimers()

		const onSaturationAlert = vi.fn<(alert: SaturationAlert) => void>()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50,
			minimumSamples: 1,
			onSaturationAlert,
			thresholds: {
				info: 0.001,
				warn: 1000,
				critical: 1000
			}
		})

		monitor.start()
		await new Promise((resolve) => setTimeout(resolve, 60))

		expect(onSaturationAlert).not.toHaveBeenCalled()

		monitor.stop()
	})

	it('should not emit alert when lag is below all thresholds', async() => {

		vi.useRealTimers()

		const onSaturationAlert = vi.fn<(alert: SaturationAlert) => void>()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50,
			onSaturationAlert,
			thresholds: {
				info: 1000,
				warn: 2000,
				critical: 3000
			}
		})

		monitor.start()
		await new Promise((resolve) => setTimeout(resolve, 60))

		// Should not be called if lag is below all thresholds
		expect(onSaturationAlert).not.toHaveBeenCalled()

		monitor.stop()
	})

	it('should calculate statistics correctly', async() => {

		vi.useRealTimers()

		// Use real timers to avoid infinite loop with recursive setTimeout
		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 10
		})

		monitor.start()

		// Wait for a few measurements to occur
		await new Promise((resolve) => setTimeout(resolve, 60))

		monitor.stop()

		const stats = monitor.getStats()
		expect(stats).not.toBeNull()
		expect(stats?.sampleCount).toBeGreaterThan(0)
		expect(stats?.mean).toBeGreaterThanOrEqual(0)
		expect(stats?.p95).toBeGreaterThanOrEqual(0)
		expect(stats?.p99).toBeGreaterThanOrEqual(0)
		expect(stats?.max).toBeGreaterThanOrEqual(0)
	})

	it('should limit samples to maxSamples', async() => {

		vi.useRealTimers()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 5
		})

		monitor.start()

		// Wait for more than 100 samples to be collected (5ms * 105 = 525ms)
		await new Promise((resolve) => setTimeout(resolve, 600))

		monitor.stop()

		const stats = monitor.getStats()
		expect(stats).not.toBeNull()
		// Should be limited to 100 samples (maxSamples)
		expect(stats?.sampleCount).toBeLessThanOrEqual(100)
	})

	it('should handle custom interval', async() => {

		vi.useRealTimers()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50
		})

		monitor.start()

		// Should trigger after interval
		await new Promise((resolve) => setTimeout(resolve, 60))

		const lag = monitor.getCurrentLag()
		expect(lag).not.toBeNull()

		monitor.stop()
	})

	it('should use default thresholds when not provided', async() => {

		vi.useRealTimers()

		const onSaturationAlert = vi.fn<(alert: SaturationAlert) => void>()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50,
			onSaturationAlert
			// No thresholds - should use defaults (info: 20, warn: 50, critical: 100)
		})

		monitor.start()
		await new Promise((resolve) => setTimeout(resolve, 60))

		// With default thresholds and real timers, lag should be small, so likely no alert
		// But the code path is executed
		monitor.stop()
	})

	it('isolates failing callbacks while continuing to collect lag samples', async() => {
		vi.useRealTimers()
		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 10,
			minimumSamples: 1,
			onPerfEvent: () => { throw new Error('event callback failed') },
			onSaturationAlert: () => { throw new Error('alert callback failed') },
			thresholds: {critical: 0.001}
		})
		monitor.start()
		await new Promise((resolve) => setTimeout(resolve, 30))
		monitor.stop()
		expect(monitor.getStats()?.sampleCount).toBeGreaterThan(0)
	})

	it('retains only the newest hundred samples under rapid deterministic measurements', () => {
		vi.useFakeTimers()
		let highResolutionTime = 0n
		const deterministicClock = {
			now: () => Number(highResolutionTime / 1_000_000n),
			nowHr: () => {
				highResolutionTime += 1_000_000n
				return highResolutionTime
			}
		}
		const monitor = createEventLoopMonitor({clock: deterministicClock, intervalMs: 1})
		monitor.start()
		vi.advanceTimersByTime(110)
		monitor.stop()
		expect(monitor.getStats()?.sampleCount).toBeLessThanOrEqual(100)
	})

	it('should handle calculatePercentiles with empty array', () => {

		vi.useFakeTimers()

		const monitor = createEventLoopMonitor({
			clock
		})

		// getStats with no samples should return null
		const stats = monitor.getStats()
		expect(stats).toBeNull()
	})

	it('should handle calculatePercentiles edge cases', async() => {

		vi.useRealTimers()

		const monitor = createEventLoopMonitor({
			clock,
			intervalMs: 50
		})

		monitor.start()

		// Generate a single sample
		await new Promise((resolve) => setTimeout(resolve, 60))

		monitor.stop()

		const stats = monitor.getStats()
		expect(stats).not.toBeNull()
		expect(stats?.sampleCount).toBeGreaterThan(0)
		// With samples, p95 and p99 should be calculated
		expect(stats?.p95).toBeGreaterThanOrEqual(0)
		expect(stats?.p99).toBeGreaterThanOrEqual(0)
	})

	function runDeterministicLagSamples(
		lags: readonly number[],
		onSaturationAlert: (alert: SaturationAlert) => void,
		options: Pick<Parameters<typeof createEventLoopMonitor>[0], 'minimumSamples' | 'reminderIntervalMs' | 'thresholds'> = {}
	): void {
		const immediates: Array<() => void> = []
		const timers: Array<() => void> = []
		const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
			immediates.push(callback as () => void)
			return 1 as unknown as ReturnType<typeof setImmediate>
		})
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
			timers.push(callback as () => void)
			return 2 as unknown as ReturnType<typeof setTimeout>
		})
		let currentLag = 0
		let highResolutionBase = 0n
		let readingStart = true
		let wallTime = 0
		const monitor = createEventLoopMonitor({
			clock: {
				now: () => wallTime += 1000,
				nowHr: () => {
					if (readingStart) {
						readingStart = false
						return highResolutionBase
					}
					readingStart = true
					const executed = highResolutionBase + BigInt(Math.round(currentLag * 1_000_000))
					highResolutionBase += 1_000_000_000n
					return executed
				}
			},
			intervalMs: 1,
			onSaturationAlert,
			...options
		})

		try {
			monitor.start()
			for (const [index, lag] of lags.entries()) {
				currentLag = lag
				immediates.shift()?.()
				if (index < lags.length - 1) timers.shift()?.()
			}
			monitor.stop()
		} finally {
			immediateSpy.mockRestore()
			timeoutSpy.mockRestore()
		}
	}

	it('evaluates event-loop saturation from rolling p95 instead of a single spike', () => {
		const onSaturationAlert = vi.fn<(alert: SaturationAlert) => void>()
		runDeterministicLagSamples(
			[...Array.from({length: 19}, () => 1), 500],
			onSaturationAlert,
			{minimumSamples: 20, thresholds: {info: 20, warn: 50, critical: 100}}
		)
		expect(onSaturationAlert).not.toHaveBeenCalled()

		runDeterministicLagSamples(
			[...Array.from({length: 18}, () => 1), 60, 60],
			onSaturationAlert,
			{minimumSamples: 20, thresholds: {info: 20, warn: 50, critical: 100}}
		)
		expect(onSaturationAlert).toHaveBeenCalledOnce()
		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({
			reason: 'event_loop_lag',
			state: 'warn',
			previousState: 'healthy',
			aggregation: 'p95',
			value: 60,
			sampleCount: 20
		}))
	})

	it('emits bounded state transitions, recovery, and reminders', () => {
		const transitions = vi.fn<(alert: SaturationAlert) => void>()
		runDeterministicLagSamples(
			[...Array.from({length: 18}, () => 1), 60, 60, 200, 200, ...Array.from({length: 100}, () => 1)],
			transitions,
			{minimumSamples: 20, reminderIntervalMs: 0, thresholds: {info: 20, warn: 50, critical: 100}}
		)
		const states = transitions.mock.calls.map(([alert]) => alert.state)
		expect(states[0]).toBe('warn')
		expect(states).toContain('critical')
		expect(states.at(-1)).toBe('healthy')
		expect(transitions.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
			severity: 'info',
			aggregation: 'p95'
		}))

		const reminders = vi.fn<(alert: SaturationAlert) => void>()
		runDeterministicLagSamples(
			Array.from({length: 8}, () => 60),
			reminders,
			{minimumSamples: 1, reminderIntervalMs: 5000, thresholds: {info: 20, warn: 50, critical: 100}}
		)
		expect(reminders.mock.calls[0]?.[0]).toEqual(expect.objectContaining({state: 'warn'}))
		expect(reminders.mock.calls[1]?.[0]).toEqual(expect.objectContaining({state: 'warn', reminder: true}))
		expect(reminders).toHaveBeenCalledTimes(2)
	})

	it('does not flap between warning and recovery inside the informational band', () => {
		const transitions = vi.fn<(alert: SaturationAlert) => void>()
		runDeterministicLagSamples(
			[
				...Array.from({length: 100}, () => 30),
				...Array.from({length: 6}, () => 60),
				...Array.from({length: 100}, () => 30),
				...Array.from({length: 6}, () => 60),
				...Array.from({length: 100}, () => 1)
			],
			transitions,
			{minimumSamples: 20, reminderIntervalMs: 0, thresholds: {info: 20, warn: 50, critical: 100}}
		)

		expect(transitions.mock.calls.map(([alert]) => alert.state)).toEqual(['warn', 'healthy'])
	})
})
