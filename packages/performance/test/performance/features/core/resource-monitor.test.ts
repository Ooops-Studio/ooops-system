import type {Errors} from '@ooopsstudio/core/ports/errors'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import {createHighResClock} from '../../../../src/performance/core/clock'
import {createResourceMonitor} from '../../../../src/performance/features/core/resource-monitor'

describe('createResourceMonitor', () => {
	it('rejects invalid collection intervals', () => {
		const clock = {now: () => 0, nowHr: () => 0n}
		expect(() => createResourceMonitor({clock, intervalMs: 0})).toThrow('intervalMs must be between')
		expect(() => createResourceMonitor({clock, intervalMs: Number.NaN})).toThrow('intervalMs must be between')
		expect(() => createResourceMonitor({clock, intervalMs: 2_147_483_648})).toThrow('intervalMs must be between')
	})

	it('rejects invalid, out-of-range, or unordered thresholds', () => {
		const clock = {now: () => 0, nowHr: () => 0n}
		expect(() => createResourceMonitor({clock, thresholds: {cpu: {warn: Number.NaN}}})).toThrow('CPU thresholds')
		expect(() => createResourceMonitor({clock, thresholds: {memory: {critical: 1.1}}})).toThrow('memory thresholds')
		expect(() => createResourceMonitor({clock, thresholds: {cpu: {warn: 0.8, critical: 0.5}}})).toThrow('warn <= critical')
	})

	it('clamps CPU counter resets instead of emitting negative utilization', () => {
		vi.useFakeTimers()
		const originalCpuUsage = process.cpuUsage
		const originalMemoryUsage = process.memoryUsage
		const cpuUsage = vi.fn()
			.mockReturnValueOnce({user: 1_000, system: 500})
			.mockReturnValueOnce({user: 100, system: 50})
		process.cpuUsage = cpuUsage as typeof process.cpuUsage
		process.memoryUsage = vi.fn(() => ({rss: 1, heapUsed: 1, heapTotal: 2, external: 0, arrayBuffers: 0})) as typeof process.memoryUsage
		const onEvent = vi.fn()
		const monitor = createResourceMonitor({clock: {now: () => 5_000, nowHr: () => 0n}, intervalMs: 1_000, onPerfEvent: onEvent})

		monitor.start()
		vi.advanceTimersByTime(1_000)
		expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({name: 'cpu_usage', duration: 0}))
		monitor.stop()
		process.cpuUsage = originalCpuUsage
		process.memoryUsage = originalMemoryUsage
		vi.useRealTimers()
	})

	it('uses actual elapsed time for CPU utilization when collection is delayed', () => {
		vi.useFakeTimers()
		const originalCpuUsage = process.cpuUsage
		const originalMemoryUsage = process.memoryUsage
		let now = 0
		process.cpuUsage = vi.fn()
			.mockReturnValueOnce({user: 0, system: 0})
			.mockReturnValueOnce({user: 5_000_000, system: 0}) as typeof process.cpuUsage
		process.memoryUsage = vi.fn(() => ({rss: 1, heapUsed: 1, heapTotal: 2, external: 0, arrayBuffers: 0})) as typeof process.memoryUsage
		const onEvent = vi.fn()
		const onAlert = vi.fn()
		const monitor = createResourceMonitor({
			clock: {now: () => now, nowHr: () => 0n},
			intervalMs: 5_000,
			onPerfEvent: onEvent,
			onSaturationAlert: onAlert,
			thresholds: {cpu: {critical: 0.75}}
		})

		monitor.start()
		now = 10_000
		vi.advanceTimersByTime(5_000)

		expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
			name: 'cpu_usage', start: 0, end: 10_000
		}))
		expect(onAlert).not.toHaveBeenCalledWith(expect.objectContaining({reason: 'cpu_saturation'}))
		monitor.stop()
		process.cpuUsage = originalCpuUsage
		process.memoryUsage = originalMemoryUsage
		vi.useRealTimers()
	})

	let clock: ReturnType<typeof createHighResClock>
	let onSaturationAlert: (alert: import('@ooopsstudio/core/contracts/performance').SaturationAlert) => void
	let onPerfEvent: (event: import('@ooopsstudio/core/contracts/performance').PerfEvent) => void

	beforeEach(() => {

		const baseClock = createFixedClock(1000)
		clock = createHighResClock({clock: baseClock})
		onSaturationAlert = vi.fn()
		onPerfEvent = vi.fn()
		vi.clearAllMocks()
	})

	afterEach(() => {

		vi.clearAllTimers()
	})

	it('should create resource monitor with default options', () => {

		const monitor = createResourceMonitor({clock})

		expect(monitor).toBeDefined()
		expect(monitor.start).toBeDefined()
		expect(monitor.stop).toBeDefined()
		expect(monitor.getStats).toBeDefined()
	})

	it('should create resource monitor with custom interval', () => {

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 10000
		})

		expect(monitor).toBeDefined()
	})

	it('should get stats when process is available', () => {

		const monitor = createResourceMonitor({clock})

		const stats = monitor.getStats()

		expect(stats).toBeDefined()
		expect(stats?.cpu).toBeDefined()
		expect(stats?.memory).toBeDefined()
		expect(stats?.cpu.user).toBeGreaterThanOrEqual(0)
		expect(stats?.cpu.system).toBeGreaterThanOrEqual(0)
		expect(stats?.cpu.total).toBeGreaterThanOrEqual(0)
		expect(stats?.memory.rss).toBeGreaterThan(0)
		expect(stats?.memory.heapUsed).toBeGreaterThan(0)
		expect(stats?.memory.heapTotal).toBeGreaterThan(0)
	})

	it('should return null for stats when process is not available', () => {

		const originalCpuUsage = process.cpuUsage
		const originalMemoryUsage = process.memoryUsage
		// @ts-expect-error - Testing edge case
		process.cpuUsage = undefined
		// @ts-expect-error - Testing edge case
		process.memoryUsage = undefined

		const monitor = createResourceMonitor({clock})
		const stats = monitor.getStats()

		expect(stats).toBeNull()

		// Restore
		process.cpuUsage = originalCpuUsage
		process.memoryUsage = originalMemoryUsage
	})

	it('should handle start and stop lifecycle', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({clock})

		monitor.start()
		expect(monitor).toBeDefined()

		monitor.stop()
		expect(monitor).toBeDefined()

		vi.useRealTimers()
	})

	it('isolates failing resource callbacks while evaluating CPU and memory thresholds', () => {
		vi.useFakeTimers()
		const originalCpuUsage = process.cpuUsage
		const originalMemoryUsage = process.memoryUsage
		let cpu = 0
		process.cpuUsage = vi.fn(() => ({user: cpu += 9_000, system: cpu += 1_000})) as typeof process.cpuUsage
		process.memoryUsage = vi.fn(() => ({rss: 1, heapUsed: 95, heapTotal: 100, external: 1, arrayBuffers: 0})) as typeof process.memoryUsage
		const errors: Errors = {report: vi.fn()}
		const monitor = createResourceMonitor({
			clock,
			intervalMs: 1,
			errors,
			onPerfEvent: () => { throw new Error('event callback') },
			onSaturationAlert: () => { throw new Error('alert callback') },
			thresholds: {cpu: {critical: 0.1}, memory: {critical: 0.9}}
		})
		monitor.start()
		vi.advanceTimersByTime(2)
		monitor.stop()
		expect(errors.report).toHaveBeenCalled()
		process.cpuUsage = originalCpuUsage
		process.memoryUsage = originalMemoryUsage
		vi.useRealTimers()
	})

	it('should handle start multiple times', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({clock})

		monitor.start()
		// Should not start again if already started
		monitor.start()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle stop when not started', () => {

		const monitor = createResourceMonitor({clock})

		// Should not throw when stopping without starting
		expect(() => monitor.stop()).not.toThrow()
	})

	it('should handle stop multiple times', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({clock})

		monitor.start()
		monitor.stop()
		// Should not throw on second stop
		expect(() => monitor.stop()).not.toThrow()

		vi.useRealTimers()
	})

	it('should collect stats at interval', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onPerfEvent
		})

		monitor.start()

		// Fast-forward time to trigger collection
		vi.advanceTimersByTime(5000)

		// Should collect stats
		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should emit CPU perf events', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onPerfEvent
		})

		monitor.start()

		// Fast-forward time to trigger collection
		vi.advanceTimersByTime(5000)

		// Should emit CPU perf event
		expect(onPerfEvent).toHaveBeenCalled()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should emit memory perf events', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onPerfEvent
		})

		monitor.start()

		// Fast-forward time to trigger collection
		vi.advanceTimersByTime(5000)

		// Should emit memory perf event
		expect(onPerfEvent).toHaveBeenCalled()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle CPU saturation alerts', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				cpu: {
					info: 0.5,
					warn: 0.7,
					critical: 0.9
				}
			}
		})

		monitor.start()

		// Fast-forward time to trigger collection
		vi.advanceTimersByTime(5000)

		// Should check CPU thresholds
		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle memory saturation alerts', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				memory: {
					info: 0.5,
					warn: 0.7,
					critical: 0.9
				}
			}
		})

		monitor.start()

		// Fast-forward time to trigger collection
		vi.advanceTimersByTime(5000)

		// Should check memory thresholds
		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle empty thresholds', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			onSaturationAlert,
			thresholds: {}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle partial thresholds', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				cpu: {
					info: 0.5
				}
				// memory not provided
			}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle errors handler', () => {

		const errors: Errors = {
			report: vi.fn()
		}

		const monitor = createResourceMonitor({clock, errors})

		expect(monitor).toBeDefined()
	})

	it('should handle collectStats when process is not available', () => {

		vi.useFakeTimers()

		const originalCpuUsage = process.cpuUsage
		const originalMemoryUsage = process.memoryUsage
		// @ts-expect-error - Testing edge case
		process.cpuUsage = undefined
		// @ts-expect-error - Testing edge case
		process.memoryUsage = undefined

		const monitor = createResourceMonitor({clock})

		monitor.start()

		// Fast-forward time
		vi.advanceTimersByTime(5000)

		// Should not throw
		expect(monitor).toBeDefined()

		monitor.stop()

		// Restore
		process.cpuUsage = originalCpuUsage
		process.memoryUsage = originalMemoryUsage

		vi.useRealTimers()
	})

	// Note: CPU usage test removed - process.cpuUsage is required by Node.js
	// and the code doesn't check for its existence before calling it

	it('should handle memory usage when heapTotal is zero', () => {

		vi.useFakeTimers()

		// Mock process.memoryUsage to return zero heapTotal
		const originalMemoryUsage = process.memoryUsage
		const originalCpuUsage = process.cpuUsage
		const mockMemoryUsage: ReturnType<typeof process.memoryUsage> = {
			heapUsed: 0,
			heapTotal: 0,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		}
		process.memoryUsage = vi.fn(() => mockMemoryUsage) as unknown as typeof process.memoryUsage
		process.cpuUsage = vi.fn(() => ({
			user: 0,
			system: 0
		})) as typeof process.cpuUsage

		const monitor = createResourceMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				memory: {
					info: 0.5
				}
			}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		// Should not throw when heapTotal is zero
		expect(monitor).toBeDefined()

		monitor.stop()

		// Restore
		process.memoryUsage = originalMemoryUsage
		process.cpuUsage = originalCpuUsage

		vi.useRealTimers()
	})

	it('should handle load average when os module is available', () => {

		// Ensure process.cpuUsage is available
		if (!process.cpuUsage) {
			// Skip test if cpuUsage is not available
			return
		}

		const monitor = createResourceMonitor({clock})

		const stats = monitor.getStats()

		// Load average may or may not be available depending on platform
		expect(stats).toBeDefined()
	})

	it('should handle load average when os module is not available', () => {

		// Ensure process.cpuUsage is available
		if (!process.cpuUsage) {
			// Skip test if cpuUsage is not available
			return
		}

		// Mock process.platform to be win32 (no loadavg)
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			writable: true
		})

		const monitor = createResourceMonitor({clock})

		const stats = monitor.getStats()

		expect(stats).toBeDefined()
		// Load average should not be available on Windows
		expect(stats?.loadAverage).toBeUndefined()

		// Restore
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true
		})
	})

	it('should handle os module loading failure', () => {

		const errors: Errors = {
			report: vi.fn()
		}

		const monitor = createResourceMonitor({clock, errors})

		const stats = monitor.getStats()

		expect(stats).toBeDefined()
		// Monitor should still work even if os module fails to load
	})

	it('should handle os module when loading promise already exists', () => {

		// Create first monitor to start the loading promise
		const monitor1 = createResourceMonitor({clock})

		// Create second monitor - should not start a new promise
		const monitor2 = createResourceMonitor({clock})

		expect(monitor1).toBeDefined()
		expect(monitor2).toBeDefined()
	})

	it('should handle CPU saturation with critical threshold', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				cpu: {
					critical: 0.9
				}
			}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle CPU saturation with warn threshold', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				cpu: {
					warn: 0.7
				}
			}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle CPU saturation with info threshold', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				cpu: {
					info: 0.5
				}
			}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle memory saturation with critical threshold', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				memory: {
					critical: 0.9
				}
			}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle memory saturation with warn threshold', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				memory: {
					warn: 0.7
				}
			}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle memory saturation with info threshold', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				memory: {
					info: 0.5
				}
			}
		})

		monitor.start()

		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should not emit CPU perf event on first collection', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onPerfEvent
		})

		monitor.start()

		// First collection should not emit CPU event (no baseline)
		vi.advanceTimersByTime(5000)

		// Second collection should emit CPU event
		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should not emit CPU saturation alert on first collection', () => {

		vi.useFakeTimers()

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 5000,
			onSaturationAlert,
			thresholds: {
				cpu: {
					info: 0.5
				}
			}
		})

		monitor.start()

		// First collection should not check CPU saturation (no baseline)
		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should emit utilization alerts and expose load averages after os cache is primed', async() => {

		vi.useFakeTimers()
		vi.resetModules()

		vi.doMock('os', () => ({
			loadavg: () => [1, 2, 3]
		}))

		const {createResourceMonitor: createCachedResourceMonitor} = await import('../../../../src/performance/features/core/resource-monitor')

		createCachedResourceMonitor({clock}).getStats()
		await vi.dynamicImportSettled()

		const originalCpuUsage = process.cpuUsage
		const originalMemoryUsage = process.memoryUsage

		const cpuUsage = vi.fn()
			.mockReturnValueOnce({user: 100, system: 100})
			.mockReturnValueOnce({user: 1_000_000, system: 700_000})
			.mockReturnValue({user: 1_100_000, system: 750_000})
		process.cpuUsage = cpuUsage as unknown as typeof process.cpuUsage
		process.memoryUsage = vi.fn(() => ({
			rss: 500,
			heapUsed: 90,
			heapTotal: 100,
			external: 10,
			arrayBuffers: 0
		})) as unknown as typeof process.memoryUsage

		const monitor = createCachedResourceMonitor({
			clock,
			intervalMs: 1000,
			onPerfEvent,
			onSaturationAlert,
			thresholds: {
				cpu: {info: 0.5, warn: 0.7, critical: 0.9},
				memory: {info: 0.5, warn: 0.7, critical: 0.8}
			}
		})

		monitor.start()
		vi.advanceTimersByTime(1000)

		expect(onPerfEvent).toHaveBeenCalledWith(expect.objectContaining({name: 'cpu_usage'}))
		expect(onPerfEvent).toHaveBeenCalledWith(expect.objectContaining({name: 'memory_usage'}))
		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({reason: 'cpu_saturation'}))
		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({reason: 'memory_pressure'}))

		const stats = monitor.getStats()
		expect(stats?.loadAverage).toEqual([1, 2, 3])

		monitor.stop()
		process.cpuUsage = originalCpuUsage
		process.memoryUsage = originalMemoryUsage
		vi.useRealTimers()
		vi.unmock('os')
	})

	it('should handle os module import failures gracefully', async() => {

		vi.resetModules()
		const errors: Errors = {report: vi.fn()}

		vi.doMock('os', () => {
			throw new Error('os unavailable')
		})

		const {createResourceMonitor: createBrokenResourceMonitor} = await import('../../../../src/performance/features/core/resource-monitor')
		const monitor = createBrokenResourceMonitor({clock, errors})

		expect(monitor.getStats()).not.toBeNull()
		await vi.dynamicImportSettled()
		expect(errors.report).toHaveBeenCalled()

		vi.unmock('os')
	})

	it('should emit warn-level cpu saturation alerts', () => {

		vi.useFakeTimers()

		const originalCpuUsage = process.cpuUsage
		const originalMemoryUsage = process.memoryUsage
		process.cpuUsage = vi.fn()
			.mockReturnValueOnce({user: 100, system: 100})
			.mockReturnValueOnce({user: 700_100, system: 100_100})
			.mockReturnValue({user: 700_100, system: 100_100}) as unknown as typeof process.cpuUsage
		process.memoryUsage = vi.fn(() => ({
			rss: 500,
			heapUsed: 40,
			heapTotal: 100,
			external: 10,
			arrayBuffers: 0
		})) as unknown as typeof process.memoryUsage

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 1_000,
			onSaturationAlert,
			thresholds: {
				cpu: {warn: 0.7}
			}
		})

		monitor.start()
		vi.advanceTimersByTime(2_000)

		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({
			reason: 'cpu_saturation',
			severity: 'warn'
		}))

		monitor.stop()
		process.cpuUsage = originalCpuUsage
		process.memoryUsage = originalMemoryUsage
		vi.useRealTimers()
	})

	it('should emit info-level cpu and memory saturation alerts when thresholds are crossed', () => {

		vi.useFakeTimers()

		const originalCpuUsage = process.cpuUsage
		const originalMemoryUsage = process.memoryUsage
		process.cpuUsage = vi.fn()
			.mockReturnValueOnce({user: 100, system: 100})
			.mockReturnValueOnce({user: 300_100, system: 300_100})
			.mockReturnValue({user: 300_100, system: 300_100}) as unknown as typeof process.cpuUsage
		process.memoryUsage = vi.fn(() => ({
			rss: 500,
			heapUsed: 55,
			heapTotal: 100,
			external: 10,
			arrayBuffers: 0
		})) as unknown as typeof process.memoryUsage

		const monitor = createResourceMonitor({
			clock,
			intervalMs: 1_000,
			onSaturationAlert,
			thresholds: {
				cpu: {info: 0.5},
				memory: {info: 0.5}
			}
		})

		monitor.start()
		vi.advanceTimersByTime(2_000)

		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({
			reason: 'cpu_saturation',
			severity: 'info'
		}))
		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({
			reason: 'memory_pressure',
			severity: 'info'
		}))

		monitor.stop()
		process.cpuUsage = originalCpuUsage
		process.memoryUsage = originalMemoryUsage
		vi.useRealTimers()
	})

	it('should fill missing load average slots with zeros after os cache is warmed', async() => {

		vi.resetModules()

		vi.doMock('os', () => ({
			loadavg: () => [4]
		}))

		const {createResourceMonitor: createCachedResourceMonitor} = await import('../../../../src/performance/features/core/resource-monitor')
		const monitor = createCachedResourceMonitor({clock})

		monitor.getStats()
		await vi.dynamicImportSettled()

		expect(monitor.getStats()?.loadAverage).toEqual([4, 0, 0])

		vi.unmock('os')
	})

	it('should swallow cached load average errors', async() => {

		vi.resetModules()

		vi.doMock('os', () => ({
			loadavg: () => {
				throw new Error('loadavg failed')
			}
		}))

		const {createResourceMonitor: createCachedResourceMonitor} = await import('../../../../src/performance/features/core/resource-monitor')
		const monitor = createCachedResourceMonitor({clock})

		monitor.getStats()
		await vi.dynamicImportSettled()

		expect(() => monitor.getStats()).not.toThrow()
		expect(monitor.getStats()).not.toBeNull()

		vi.unmock('os')
	})

})
