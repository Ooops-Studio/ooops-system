/**
 * @file GC monitor for tracking garbage collection events.
 * Uses Node.js perf_hooks if available (requires --expose-gc or perf hooks).
 */

import {createPerformanceOnError} from '../../utils/on-error'

import type {
	GCMonitor,
	GCMonitorOptions,
	GCStats,
	PerformanceEntryList,
	PerformanceObserverConstructor,
	PerformanceObserverInterface,
	PerfHooksModule,
	PerfHooksModuleType
} from './gc-monitor-types'

export type {GCMonitor, GCMonitorOptions, GCStats} from './gc-monitor-types'

// Module-level cache for perf_hooks module
let perfHooksModuleCache: PerfHooksModuleType | null = null
let perfHooksLoadingPromise: Promise<void> | null = null
const MAX_GC_ENTRIES_PER_CALLBACK = 256

/**
 * Create a GC monitor.
 * Requires Node.js with perf_hooks support (--expose-gc or perf hooks enabled).
 * Falls back to no-op if not available.
 *
 * @param options - Monitor options
 * @returns GC monitor instance
 */
export function createGCMonitor(options: GCMonitorOptions): GCMonitor {

	const {
		clock,
		errors,
		onSaturationAlert,
		onPerfEvent,
		thresholds = {}
	} = options

	const onError = createPerformanceOnError(errors, {
		operation: 'module-load',
		monitor: 'gc-monitor'
	})

	// Check if perf_hooks is available
	let perfHooks: PerfHooksModule | null = null

	// Use cached module if available
	if (perfHooksModuleCache && perfHooksModuleCache.PerformanceObserver) {
		const Observer = perfHooksModuleCache.PerformanceObserver as PerformanceObserverConstructor
		perfHooks = {
			PerformanceObserver: Observer
		}
	} else {
		// Try to load perf_hooks module asynchronously (for future calls)
		if (!perfHooksLoadingPromise) {
			perfHooksLoadingPromise = import('perf_hooks')
				.then((module) => {
					perfHooksModuleCache = module
				})
				.catch((error) => {
					perfHooksModuleCache = null
					perfHooksLoadingPromise = null
					onError(error, {module: 'perf_hooks'})
				})
		}
		// For now, perfHooks will be null (no-op monitor)
		// Future calls will use the cached module
	}

	const pauseTimeThresholds = {...(thresholds.pauseTime ?? {})}
	const heapUsageThresholds = {...(thresholds.heapUsage ?? {})}
	validatePair(pauseTimeThresholds, 'GC pause-time')
	validatePair(heapUsageThresholds, 'GC heap-usage', 1)

	let majorCount = 0
	let minorCount = 0
	const pauseTimes: number[] = []
	let observer: PerformanceObserverInterface | null = null
	let heapCheckIntervalId: ReturnType<typeof setInterval> | null = null
	let running = false

	function startObserver(): void {
		if (!perfHooks || observer || !running) {
			return
		}
		let candidate: PerformanceObserverInterface | null = null
		try {
			candidate = new perfHooks.PerformanceObserver((list: PerformanceEntryList) => {
				try {
					let processed = 0
					for (const entry of list.getEntries()) {
						if (processed >= MAX_GC_ENTRIES_PER_CALLBACK) {
							onError(new Error('GC observer callback entry limit exceeded'), {
								operation: 'gc-monitor.entry-limit'
							})
							break
						}
						processed += 1
						if (entry.entryType === 'gc') {
							// Node 22+ exposes GC kind through detail; the legacy kind accessor is deprecated.
							handleGCEvent(entry.detail?.kind ?? 2, entry.duration)
						}
					}
				} catch(error) {
					onError(error, {operation: 'gc-monitor.observer'})
				}
			})

			candidate.observe({entryTypes: ['gc']})
			observer = candidate
			heapCheckIntervalId = setInterval(safeCheckHeapUsage, 5000)
			heapCheckIntervalId.unref?.()
		} catch(error) {
			const partialObserver = candidate
			candidate = null
			observer = null
			if (heapCheckIntervalId !== null) {
				clearInterval(heapCheckIntervalId)
				heapCheckIntervalId = null
			}
			try { partialObserver?.disconnect() } catch(cleanupError) {
				onError(cleanupError, {operation: 'gc-monitor.start-cleanup'})
			}
			running = false
			onError(error, {operation: 'gc-monitor.start'})
		}
	}

	if (!perfHooks && perfHooksLoadingPromise) {
		void perfHooksLoadingPromise.then(() => {
			if (!perfHooksModuleCache?.PerformanceObserver) {
				return
			}
			perfHooks = {PerformanceObserver: perfHooksModuleCache.PerformanceObserver as PerformanceObserverConstructor}
			startObserver()
		})
	}

	/**
	 * Handle GC event
	 */
	function handleGCEvent(kind: number, pauseTimeMs: number): void {

		if (!running) {
			return
		}
		if (!Number.isFinite(pauseTimeMs) || pauseTimeMs < 0) {
			onError(new Error('GC pause duration must be a non-negative finite number'), {
				operation: 'gc-monitor.invalid-entry'
			})
			return
		}
		// V8 exposes minor as 1; major and incremental collections are treated as major.
		if (kind === 1) {
			minorCount++
		} else {
			majorCount++
		}

		pauseTimes.push(pauseTimeMs)

		// Keep only last 100 pause times
		if (pauseTimes.length > 100) {
			pauseTimes.shift()
		}

		// Emit perf event
		if (onPerfEvent) {
			try {
				const end = clock.now()
				onPerfEvent({
					name: `gc_${kind === 1 ? 'minor' : 'major'}`,
					duration: pauseTimeMs,
					start: end - pauseTimeMs,
					end,
					labels: {
						kind: kind === 1 ? 'minor' : 'major'
					},
					source: 'runtime'
				})
			} catch(error) {
				onError(error, {operation: 'gc-monitor.perf-event'})
			}
		}

		// Check saturation thresholds
		if (onSaturationAlert) {
			let severity: 'warn' | 'critical' | null = null
			let threshold = 0

			if (pauseTimeThresholds.critical !== undefined && pauseTimeMs >= pauseTimeThresholds.critical) {
				severity = 'critical'
				threshold = pauseTimeThresholds.critical
			} else if (pauseTimeThresholds.warn !== undefined && pauseTimeMs >= pauseTimeThresholds.warn) {
				severity = 'warn'
				threshold = pauseTimeThresholds.warn
			}

			if (severity) {
				try {
					onSaturationAlert({
						reason: `gc_pause_${kind === 1 ? 'minor' : 'major'}`,
						severity,
						value: pauseTimeMs,
						threshold
					})
				} catch(error) {
					onError(error, {operation: 'gc-monitor.saturation-alert'})
				}
			}
		}
	}

	/**
	 * Check heap usage and emit alerts if needed
	 */
	function checkHeapUsage(): void {

		if (!running) {
			return
		}
		if (!onSaturationAlert) {
			return
		}

		const usage = process.memoryUsage()
		const heapLimit = (usage as {heapLimit?: number}).heapLimit ?? usage.heapTotal
		const heapUsed = usage.heapUsed

		if (heapLimit > 0) {
			const utilization = heapUsed / heapLimit
			let severity: 'warn' | 'critical' | null = null
			let threshold = 0

			if (heapUsageThresholds.critical !== undefined && utilization >= heapUsageThresholds.critical) {
				severity = 'critical'
				threshold = heapUsageThresholds.critical
			} else if (heapUsageThresholds.warn !== undefined && utilization >= heapUsageThresholds.warn) {
				severity = 'warn'
				threshold = heapUsageThresholds.warn
			}

			if (severity) {
				try {
					onSaturationAlert({
						reason: 'heap_usage',
						severity,
						value: utilization,
						threshold
					})
				} catch(error) {
					onError(error, {operation: 'gc-monitor.saturation-alert'})
				}
			}
		}
	}

	function safeCheckHeapUsage(): void {
		try {
			checkHeapUsage()
		} catch(error) {
			onError(error, {operation: 'gc-monitor.heap-check'})
		}
	}

	return {
		start(): void {

			if (running) {
				return
			}

			try {
				running = true
				startObserver()
			} catch(error) {
				running = false
				onError(error, {operation: 'gc-monitor.start'})
				// Observer creation failed, continue as no-op
			}
		},
		stop(): void {

			running = false
			const activeObserver = observer
			observer = null
			try {
				activeObserver?.disconnect()
			} catch(error) {
				onError(error, {operation: 'gc-monitor.stop'})
			}
			const activeHeapCheckInterval = heapCheckIntervalId
			heapCheckIntervalId = null
			if (activeHeapCheckInterval !== null) {
				clearInterval(activeHeapCheckInterval)
			}
		},
		getStats(): GCStats {

			const totalPauseTimeMs = pauseTimes.reduce((sum, val) => sum + val, 0)
			const avgPauseTimeMs = pauseTimes.length > 0 ? totalPauseTimeMs / pauseTimes.length : 0
			const maxPauseTimeMs = pauseTimes.length > 0 ? Math.max(...pauseTimes) : 0

			return {
				majorCount,
				minorCount,
				totalPauseTimeMs,
				avgPauseTimeMs,
				maxPauseTimeMs
			}
		},
		getHeapUsage(): {
			heapUsed: number
			heapTotal: number
			heapLimit?: number
		} | null {

			if (typeof process === 'undefined' || !process.memoryUsage) {
				return null
			}

			const usage = process.memoryUsage()
			const result: {
				heapUsed: number
				heapTotal: number
				heapLimit?: number
			} = {
				heapUsed: usage.heapUsed,
				heapTotal: usage.heapTotal
			}
			const heapLimit = (usage as {heapLimit?: number}).heapLimit
			if (heapLimit !== undefined) {
				result.heapLimit = heapLimit
			}
			return result
		}
	}
}

function validatePair(
	thresholds: {warn?: number; critical?: number},
	name: string,
	max = Number.POSITIVE_INFINITY
): void {
	const values = [thresholds.warn, thresholds.critical]
		.filter((value): value is number => value !== undefined)
	if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= max)) {
		throw new Error(`${name} thresholds must be finite numbers between 0 and ${max}`)
	}
	if (thresholds.warn !== undefined && thresholds.critical !== undefined && thresholds.warn > thresholds.critical) {
		throw new Error(`${name} thresholds must satisfy warn <= critical`)
	}
}
