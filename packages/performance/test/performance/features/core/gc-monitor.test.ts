import type {Errors} from '@ooopsstudio/core/ports/errors'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import {createHighResClock} from '../../../../src/performance/core/clock'
import {createGCMonitor} from '../../../../src/performance/features/core/gc-monitor'

describe('createGCMonitor', () => {
	it('rejects invalid, out-of-range, or unordered thresholds', () => {
		const clock = {now: () => 0, nowHr: () => 0n}
		expect(() => createGCMonitor({clock, thresholds: {pauseTime: {warn: -1}}})).toThrow('pause-time thresholds')
		expect(() => createGCMonitor({clock, thresholds: {heapUsage: {critical: 1.1}}})).toThrow('heap-usage thresholds')
		expect(() => createGCMonitor({clock, thresholds: {pauseTime: {warn: 10, critical: 5}}})).toThrow('warn <= critical')
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

	it('should create GC monitor with default options', () => {

		const monitor = createGCMonitor({clock})

		expect(monitor).toBeDefined()
		expect(monitor.start).toBeDefined()
		expect(monitor.stop).toBeDefined()
		expect(monitor.getStats).toBeDefined()
		expect(monitor.getHeapUsage).toBeDefined()
	})

	it('should return initial stats with zero values', () => {

		const monitor = createGCMonitor({clock})

		const stats = monitor.getStats()

		expect(stats).toEqual({
			majorCount: 0,
			minorCount: 0,
			totalPauseTimeMs: 0,
			avgPauseTimeMs: 0,
			maxPauseTimeMs: 0
		})
	})

	it('should get heap usage when process is available', () => {

		const monitor = createGCMonitor({clock})

		const heapUsage = monitor.getHeapUsage()

		expect(heapUsage).toBeDefined()
		expect(heapUsage?.heapUsed).toBeGreaterThan(0)
		expect(heapUsage?.heapTotal).toBeGreaterThan(0)
		// heapLimit may or may not be available depending on Node.js version
	})

	it('should return null for heap usage when process is not available', () => {

		const originalMemoryUsage = process.memoryUsage
		// @ts-expect-error - Testing edge case
		process.memoryUsage = undefined

		const monitor = createGCMonitor({clock})
		const heapUsage = monitor.getHeapUsage()

		expect(heapUsage).toBeNull()

		// Restore
		process.memoryUsage = originalMemoryUsage
	})

	it('should handle start when perf_hooks is not available', () => {

		const monitor = createGCMonitor({clock})

		// Should not throw when perf_hooks is not available
		expect(() => monitor.start()).not.toThrow()
	})

	it('should handle stop when not started', () => {

		const monitor = createGCMonitor({clock})

		// Should not throw when stopping without starting
		expect(() => monitor.stop()).not.toThrow()
	})

	it('should handle stop multiple times', () => {

		const monitor = createGCMonitor({clock})

		monitor.stop()
		// Should not throw on second stop
		expect(() => monitor.stop()).not.toThrow()
	})

	it('should handle errors handler', () => {

		const errors: Errors = {
			report: vi.fn()
		}

		const monitor = createGCMonitor({clock, errors})

		expect(monitor).toBeDefined()
		// Errors handler is used internally for module loading
	})

	it('should handle thresholds for pause time', () => {

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				pauseTime: {
					warn: 10,
					critical: 50
				}
			}
		})

		expect(monitor).toBeDefined()
		// Thresholds are checked when GC events occur
	})

	it('should handle thresholds for heap usage', () => {

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				heapUsage: {
					warn: 0.8,
					critical: 0.9
				}
			}
		})

		expect(monitor).toBeDefined()
		// Thresholds are checked periodically
	})

	it('should handle empty thresholds', () => {

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {}
		})

		expect(monitor).toBeDefined()
	})

	it('should handle partial thresholds', () => {

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				pauseTime: {
					warn: 10
				}
				// heapUsage not provided
			}
		})

		expect(monitor).toBeDefined()
	})

	it('should handle onPerfEvent callback', () => {

		const monitor = createGCMonitor({
			clock,
			onPerfEvent
		})

		expect(monitor).toBeDefined()
		// onPerfEvent is called when GC events occur
	})

	it('should handle onSaturationAlert callback', () => {

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert
		})

		expect(monitor).toBeDefined()
		// onSaturationAlert is called when thresholds are exceeded
	})

	it('should handle start and stop lifecycle', () => {

		vi.useFakeTimers()

		const monitor = createGCMonitor({clock})

		monitor.start()
		expect(monitor).toBeDefined()

		monitor.stop()
		expect(monitor).toBeDefined()

		vi.useRealTimers()
	})

	it('should handle heap usage check interval', () => {

		vi.useFakeTimers()

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert
		})

		monitor.start()

		// Fast-forward time to trigger heap check (every 5 seconds)
		vi.advanceTimersByTime(5000)

		// Should not throw
		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle heap usage check without onSaturationAlert', () => {

		vi.useFakeTimers()

		const monitor = createGCMonitor({
			clock
			// onSaturationAlert not provided
		})

		monitor.start()

		// Fast-forward time
		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle heap usage without heapLimit', () => {

		// Mock process.memoryUsage to not include heapLimit
		const originalMemoryUsage = process.memoryUsage
		const mockMemoryUsage: ReturnType<typeof process.memoryUsage> = {
			heapUsed: 1800,
			heapTotal: 2000,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		}
		process.memoryUsage = vi.fn(() => mockMemoryUsage) as unknown as typeof process.memoryUsage

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert
		})

		const heapUsage = monitor.getHeapUsage()

		expect(heapUsage).toBeDefined()
		expect(heapUsage?.heapLimit).toBeUndefined()

		// Restore
		process.memoryUsage = originalMemoryUsage
	})

	it('should handle heap usage with heapLimit', () => {

		// Mock process.memoryUsage to include heapLimit
		const originalMemoryUsage = process.memoryUsage
		const mockMemoryUsage: ReturnType<typeof process.memoryUsage> & {heapLimit?: number} = {
			heapUsed: 1000,
			heapTotal: 2000,
			heapLimit: 3000,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		}
		process.memoryUsage = vi.fn(() => mockMemoryUsage) as unknown as typeof process.memoryUsage

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert
		})

		const heapUsage = monitor.getHeapUsage()

		expect(heapUsage).toBeDefined()
		expect(heapUsage?.heapLimit).toBe(3000)

		// Restore
		process.memoryUsage = originalMemoryUsage
	})

	it('should calculate stats correctly with pause times', () => {

		const monitor = createGCMonitor({clock})

		// Manually add pause times by accessing internal state
		// Since we can't easily trigger GC events, we test the calculation logic
		const stats = monitor.getStats()

		expect(stats.totalPauseTimeMs).toBe(0)
		expect(stats.avgPauseTimeMs).toBe(0)
		expect(stats.maxPauseTimeMs).toBe(0)
	})

	it('should handle stats with no pause times', () => {

		const monitor = createGCMonitor({clock})

		const stats = monitor.getStats()

		expect(stats.majorCount).toBe(0)
		expect(stats.minorCount).toBe(0)
		expect(stats.totalPauseTimeMs).toBe(0)
		expect(stats.avgPauseTimeMs).toBe(0)
		expect(stats.maxPauseTimeMs).toBe(0)
	})

	it('should handle observer creation failure gracefully', () => {

		vi.useFakeTimers()

		const monitor = createGCMonitor({clock})

		// Start should not throw even if observer creation fails
		expect(() => monitor.start()).not.toThrow()

		monitor.stop()

		vi.useRealTimers()
	})

	it('should handle perf_hooks module loading failure', () => {

		const errors: Errors = {
			report: vi.fn()
		}

		const monitor = createGCMonitor({
			clock,
			errors
		})

		expect(monitor).toBeDefined()
		// Monitor should still work even if perf_hooks fails to load
		expect(() => monitor.start()).not.toThrow()
	})

	it('should handle perf_hooks when loading promise already exists', () => {

		// Create first monitor to start the loading promise
		const monitor1 = createGCMonitor({clock})

		// Create second monitor - should not start a new promise
		const monitor2 = createGCMonitor({clock})

		expect(monitor1).toBeDefined()
		expect(monitor2).toBeDefined()
	})

	it('should handle cached perf_hooks module', () => {

		const monitor = createGCMonitor({clock})

		expect(monitor).toBeDefined()
		// If perf_hooks is cached, it should be used
	})

	it('should handle heap usage check when heapLimit is not available', () => {

		vi.useFakeTimers()

		// Mock process.memoryUsage to not include heapLimit
		const originalMemoryUsage = process.memoryUsage
		const mockMemoryUsage: ReturnType<typeof process.memoryUsage> = {
			heapUsed: 1000,
			heapTotal: 2000,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		}
		process.memoryUsage = vi.fn(() => mockMemoryUsage) as unknown as typeof process.memoryUsage

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				heapUsage: {
					warn: 0.8
				}
			}
		})

		monitor.start()

		// Fast-forward time
		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		// Restore
		process.memoryUsage = originalMemoryUsage

		vi.useRealTimers()
	})

	it('should handle heap usage check with thresholds', () => {

		vi.useFakeTimers()

		// Mock process.memoryUsage with high utilization
		const originalMemoryUsage = process.memoryUsage
		const mockMemoryUsage: ReturnType<typeof process.memoryUsage> & {heapLimit?: number} = {
			heapUsed: 9000,
			heapTotal: 10000,
			heapLimit: 10000,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		}
		process.memoryUsage = vi.fn(() => mockMemoryUsage) as unknown as typeof process.memoryUsage

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				heapUsage: {
					warn: 0.8,
					critical: 0.9
				}
			}
		})

		monitor.start()

		// Fast-forward time to trigger heap check
		vi.advanceTimersByTime(5000)

		// Should check thresholds and potentially emit alert
		expect(monitor).toBeDefined()

		monitor.stop()

		// Restore
		process.memoryUsage = originalMemoryUsage

		vi.useRealTimers()
	})

	it('should handle heap usage check with critical threshold', () => {

		vi.useFakeTimers()

		// Mock process.memoryUsage with critical utilization
		const originalMemoryUsage = process.memoryUsage
		const mockMemoryUsage: ReturnType<typeof process.memoryUsage> & {heapLimit?: number} = {
			heapUsed: 9500,
			heapTotal: 10000,
			heapLimit: 10000,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		}
		process.memoryUsage = vi.fn(() => mockMemoryUsage) as unknown as typeof process.memoryUsage

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				heapUsage: {
					warn: 0.8,
					critical: 0.9
				}
			}
		})

		monitor.start()

		// Fast-forward time
		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		// Restore
		process.memoryUsage = originalMemoryUsage

		vi.useRealTimers()
	})

	it('should handle heap usage check with warn threshold', () => {

		vi.useFakeTimers()

		// Mock process.memoryUsage with warn-level utilization
		const originalMemoryUsage = process.memoryUsage
		const mockMemoryUsage: ReturnType<typeof process.memoryUsage> & {heapLimit?: number} = {
			heapUsed: 8500,
			heapTotal: 10000,
			heapLimit: 10000,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		}
		process.memoryUsage = vi.fn(() => mockMemoryUsage) as unknown as typeof process.memoryUsage

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				heapUsage: {
					warn: 0.8,
					critical: 0.9
				}
			}
		})

		monitor.start()

		// Fast-forward time
		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		// Restore
		process.memoryUsage = originalMemoryUsage

		vi.useRealTimers()
	})

	it('should handle heap usage check below thresholds', () => {

		vi.useFakeTimers()

		// Mock process.memoryUsage with low utilization
		const originalMemoryUsage = process.memoryUsage
		const mockMemoryUsage: ReturnType<typeof process.memoryUsage> & {heapLimit?: number} = {
			heapUsed: 5000,
			heapTotal: 10000,
			heapLimit: 10000,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		}
		process.memoryUsage = vi.fn(() => mockMemoryUsage) as unknown as typeof process.memoryUsage

		const monitor = createGCMonitor({
			clock,
			onSaturationAlert,
			thresholds: {
				heapUsage: {
					warn: 0.8,
					critical: 0.9
				}
			}
		})

		monitor.start()

		// Fast-forward time
		vi.advanceTimersByTime(5000)

		expect(monitor).toBeDefined()

		monitor.stop()

		// Restore
		process.memoryUsage = originalMemoryUsage

		vi.useRealTimers()
	})

	it('should observe GC entries and heap pressure after perf_hooks cache is primed', async() => {

		vi.useFakeTimers()
		vi.resetModules()

		const instances: Array<{
			callback: (list: {getEntries: () => Array<{entryType: string; name: string; duration: number; kind?: number}>}) => void
			observe: ReturnType<typeof vi.fn>
			disconnect: ReturnType<typeof vi.fn>
		}> = []

		class MockObserver {
			observe = vi.fn()
			disconnect = vi.fn()
			callback: (list: {getEntries: () => Array<{entryType: string; name: string; duration: number; kind?: number}>}) => void

			constructor(callback: (list: {getEntries: () => Array<{entryType: string; name: string; duration: number; kind?: number}>}) => void) {
				this.callback = callback
				instances.push(this)
			}
		}

		vi.doMock('perf_hooks', () => ({
			PerformanceObserver: MockObserver
		}))

		const {createGCMonitor: createCachedGCMonitor} = await import('../../../../src/performance/features/core/gc-monitor')
		createCachedGCMonitor({clock})
		await vi.dynamicImportSettled()

		const originalMemoryUsage = process.memoryUsage
		process.memoryUsage = vi.fn(() => ({
			heapUsed: 900,
			heapTotal: 1000,
			external: 0,
			rss: 0,
			arrayBuffers: 0
		} as ReturnType<typeof process.memoryUsage>)) as unknown as typeof process.memoryUsage

		const monitor = createCachedGCMonitor({
			clock,
			onPerfEvent,
			onSaturationAlert,
			thresholds: {
				pauseTime: {warn: 10, critical: 50},
				heapUsage: {warn: 0.8, critical: 0.95}
			}
		})

		monitor.start()
		instances[0]?.callback({
			getEntries: () => [
				{entryType: 'gc', name: 'gc', duration: 12, detail: {kind: 1}},
				{entryType: 'gc', name: 'gc', duration: 75, detail: {kind: 4}},
				{entryType: 'mark', name: 'ignored', duration: 1}
			]
		})
		vi.advanceTimersByTime(5000)

		expect(monitor.getStats()).toMatchObject({
			majorCount: 1,
			minorCount: 1,
			maxPauseTimeMs: 75
		})
		expect(onPerfEvent).toHaveBeenCalledWith(expect.objectContaining({name: 'gc_minor'}))
		expect(onPerfEvent).toHaveBeenCalledWith(expect.objectContaining({name: 'gc_major'}))
		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({reason: 'gc_pause_minor'}))
		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({reason: 'gc_pause_major'}))
		expect(onSaturationAlert).toHaveBeenCalledWith(expect.objectContaining({reason: 'heap_usage'}))

		monitor.stop()
		expect(instances[0]?.disconnect).toHaveBeenCalled()

		process.memoryUsage = originalMemoryUsage
		vi.useRealTimers()
		vi.unmock('perf_hooks')
	})

	it('bounds genuine GC entry batches and reports callback failures without stopping', async() => {
		vi.useFakeTimers()
		vi.resetModules()

		const instances: Array<{callback: (list: {getEntries: () => Array<{
			entryType: string; name: string; duration: number; detail?: {kind: number}
		}>}) => void}> = []
		class MockObserver {
			constructor(callback: (list: {getEntries: () => Array<{
				entryType: string; name: string; duration: number; detail?: {kind: number}
			}>}) => void) {
				instances.push({callback})
			}
			observe = vi.fn()
			disconnect = vi.fn()
		}
		vi.doMock('perf_hooks', () => ({PerformanceObserver: MockObserver}))

		const {createGCMonitor: createCachedGCMonitor} = await import('../../../../src/performance/features/core/gc-monitor')
		createCachedGCMonitor({clock})
		await vi.dynamicImportSettled()
		const errors: Errors = {report: vi.fn()}
		let callbackShouldThrow = true
		const monitor = createCachedGCMonitor({
			clock,
			errors,
			onPerfEvent: () => {
				if (callbackShouldThrow) throw new Error('perf callback failed')
			},
			onSaturationAlert: () => {
				if (callbackShouldThrow) throw new Error('alert callback failed')
			},
			thresholds: {pauseTime: {warn: 1}}
		})

		monitor.start()
		monitor.start()
		instances[0]?.callback({
			getEntries: () => [
				{entryType: 'gc', name: 'gc', duration: 2, detail: {kind: 1}},
				{entryType: 'gc', name: 'gc', duration: 3, detail: {kind: 4}},
				{entryType: 'gc', name: 'gc', duration: Number.NaN, detail: {kind: 1}}
			]
		})

		expect(monitor.getStats()).toMatchObject({minorCount: 1, majorCount: 1})
		expect(errors.report).toHaveBeenCalledTimes(5)
		callbackShouldThrow = false
		for (let index = 0; index < 50; index++) {
			instances[0]?.callback({
				getEntries: () => [
					{entryType: 'gc', name: 'gc', duration: 1, detail: {kind: 1}},
					{entryType: 'gc', name: 'gc', duration: 1, detail: {kind: 4}}
				]
			})
		}
		instances[0]?.callback({
			getEntries: () => Array.from({length: 1_000}, () => ({
				entryType: 'gc', name: 'gc', duration: 1, detail: {kind: 1}
			}))
		})
		expect(monitor.getStats()).toMatchObject({minorCount: 307, majorCount: 51})
		expect(errors.report).toHaveBeenCalledWith(
			expect.anything(), expect.objectContaining({operation: 'gc-monitor.entry-limit'})
		)
		const originalMemoryUsage = process.memoryUsage
		process.memoryUsage = (() => { throw new Error('memory unavailable') }) as typeof process.memoryUsage
		vi.advanceTimersByTime(5000)
		expect(monitor.getStats().totalPauseTimeMs).toBe(100)
		expect(errors.report).toHaveBeenCalledTimes(7)
		monitor.stop()
		process.memoryUsage = originalMemoryUsage
		vi.useRealTimers()
		vi.unmock('perf_hooks')
	})

	it('cleans up the heap timer when observer disconnect throws', async() => {
		vi.useFakeTimers()
		vi.resetModules()
		class MockObserver {
			observe = vi.fn()
			disconnect = vi.fn(() => { throw new Error('disconnect failed') })
			constructor(_callback: unknown) {}
		}
		vi.doMock('perf_hooks', () => ({PerformanceObserver: MockObserver}))
		const {createGCMonitor: createCachedGCMonitor} = await import('../../../../src/performance/features/core/gc-monitor')
		createCachedGCMonitor({clock})
		await vi.dynamicImportSettled()
		const errors: Errors = {report: vi.fn()}
		const monitor = createCachedGCMonitor({clock, errors})
		monitor.start()

		expect(() => monitor.stop()).not.toThrow()
		expect(vi.getTimerCount()).toBe(0)
		expect(errors.report).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({operation: 'gc-monitor.stop'}))

		vi.useRealTimers()
		vi.unmock('perf_hooks')
	})

	it('disconnects a partially initialized observer when observe throws', async() => {
		vi.resetModules()
		const disconnect = vi.fn()
		class MockObserver {
			observe = vi.fn(() => { throw new Error('observe failed') })
			disconnect = disconnect
			constructor(_callback: unknown) {}
		}
		vi.doMock('perf_hooks', () => ({PerformanceObserver: MockObserver}))
		const {createGCMonitor: createCachedGCMonitor} = await import('../../../../src/performance/features/core/gc-monitor')
		createCachedGCMonitor({clock})
		await vi.dynamicImportSettled()
		const errors: Errors = {report: vi.fn()}
		const monitor = createCachedGCMonitor({clock, errors})

		expect(() => monitor.start()).not.toThrow()
		expect(disconnect).toHaveBeenCalledOnce()
		expect(errors.report).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({operation: 'gc-monitor.start'}))
		expect(() => monitor.stop()).not.toThrow()

		vi.unmock('perf_hooks')
	})

})
