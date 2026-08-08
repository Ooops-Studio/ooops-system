/**
 * @file Event loop lag monitor.
 * Measures event loop delay using setImmediate or microtask benchmarks.
 */

import type {PerfEvent, SaturationAlert} from '@ooopsstudio/core/contracts/performance'

import type {HighResClock} from '../../core/clock'
import {nsToMs} from '../../core/clock'

/**
 * Event loop lag statistics
 */
export interface EventLoopStats {

	/** Mean lag in milliseconds */
	mean: number
	/** 95th percentile lag */
	p95: number
	/** 99th percentile lag */
	p99: number
	/** Maximum lag observed */
	max: number
	/** Number of samples */
	sampleCount: number
}

/**
 * Event loop monitor for tracking event loop lag
 */
export interface EventLoopMonitor {

	/** Start monitoring */
	start(): void

	/** Stop monitoring */
	stop(): void

	/** Get current statistics */
	getStats(): EventLoopStats | null

	/** Get the most recent lag measurement */
	getCurrentLag(): number | null
}

/**
 * Options for creating an event loop monitor
 */
export interface EventLoopMonitorOptions {

	/** High-resolution clock */
	clock: HighResClock

	/** Monitoring interval in milliseconds */
	intervalMs?: number

	/** Callback for saturation alerts */
	onSaturationAlert?: (alert: SaturationAlert) => void

	/** Callback for perf events */
	onPerfEvent?: (event: PerfEvent) => void

	/** Thresholds for saturation alerts */
	thresholds?: {
		info?: number
		warn?: number
		critical?: number
	}
}

/**
 * Create an event loop lag monitor.
 * Uses setImmediate to measure the delay between scheduling and execution.
 *
 * @param options - Monitor options
 * @returns Event loop monitor instance
 */
export function createEventLoopMonitor(options: EventLoopMonitorOptions): EventLoopMonitor {

	const {
		clock,
		intervalMs = 1000,
		onSaturationAlert,
		onPerfEvent,
		thresholds = {}
	} = options

	if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
		throw new Error('Event loop intervalMs must be between 1 and 2147483647')
	}
	const configuredThresholds = [thresholds.info, thresholds.warn, thresholds.critical]
		.filter((value): value is number => value !== undefined)
	if (!configuredThresholds.every((value) => Number.isFinite(value) && value >= 0)) {
		throw new Error('Event loop monitor thresholds must be non-negative finite numbers')
	}
	if (
		(thresholds.info !== undefined && thresholds.warn !== undefined && thresholds.info > thresholds.warn) ||
		(thresholds.warn !== undefined && thresholds.critical !== undefined && thresholds.warn > thresholds.critical) ||
		(thresholds.info !== undefined && thresholds.critical !== undefined && thresholds.info > thresholds.critical)
	) {
		throw new Error('Event loop monitor thresholds must satisfy info <= warn <= critical')
	}
	// Derive missing levels around explicit values so partial overrides preserve
	// their existing meaning while the effective thresholds remain ordered.
	const criticalThreshold = thresholds.critical ?? Math.max(100, thresholds.warn ?? thresholds.info ?? 0)
	const warnThreshold = thresholds.warn ?? Math.min(Math.max(50, thresholds.info ?? 0), criticalThreshold)
	const infoThreshold = thresholds.info ?? Math.min(20, warnThreshold)

	let timeoutId: ReturnType<typeof setTimeout> | null = null
	let immediateId: ReturnType<typeof setImmediate> | null = null
	let running = false
	const lagSamples: number[] = []
	let currentLag: number | null = null
	const scheduleNext = (): void => {
		if (!running) return
		running = false
		try {
			timeoutId = setTimeout(scheduleMeasurement, intervalMs)
			running = true
			timeoutId.unref?.()
		} catch { /* only timer acquisition failure leaves the monitor stopped */ }
	}

	/**
	 * Measure event loop lag using setImmediate
	 */
	function measureLag(): void {

		let scheduled: bigint
		try { scheduled = clock.nowHr() } catch {
			scheduleNext()
			return
		}
		try { immediateId = setImmediate(() => {
			immediateId = null
			if (!running) {
				return
			}
			let executed: bigint
			try { executed = clock.nowHr() } catch {
				scheduleNext()
				return
			}
			const lagMs = nsToMs(executed - scheduled)
			if (!Number.isFinite(lagMs) || lagMs < 0) {
				// A malformed/custom high-resolution clock must not poison all
				// subsequent percentiles. Keep monitoring and wait for a valid sample.
				scheduleNext()
				return
			}

			currentLag = lagMs

			// Add to samples (keep only last maxSamples)
			lagSamples.push(lagMs)
			if (lagSamples.length > 100) {
				lagSamples.shift()
			}

			// Emit perf event
			if (onPerfEvent) {
				try {
					const end = clock.now()
					onPerfEvent({
						name: 'event_loop_lag',
						duration: lagMs,
						start: end - lagMs,
						end,
						source: 'runtime'
					})
				} catch {
					// Callback failures must not stop monitoring.
				}
			}

			// Check saturation thresholds
			if (onSaturationAlert) {
				let severity: 'info' | 'warn' | 'critical' | null = null
				let threshold = 0

				if (lagMs >= criticalThreshold) {
					severity = 'critical'
					threshold = criticalThreshold
				} else if (lagMs >= warnThreshold) {
					severity = 'warn'
					threshold = warnThreshold
				} else if (lagMs >= infoThreshold) {
					severity = 'info'
					threshold = infoThreshold
				}

				if (severity) {
					try {
						onSaturationAlert({
							reason: 'event_loop_lag',
							severity,
							value: lagMs,
							threshold
						})
					} catch {
						// Callback failures must not stop monitoring.
					}
				}
			}

			// A callback may synchronously stop the monitor. Do not leave a stray
			// interval timer behind after that re-entrant shutdown.
			scheduleNext()
		}) } catch { running = false }
	}

	/**
	 * Periodic measurement
	 */
	function scheduleMeasurement(): void {

		if (!running) {
			return
		}
		measureLag()
	}

	/**
	 * Calculate percentiles from samples
	 */
	function calculatePercentiles(sorted: number[], percentile: number): number {

		if (sorted.length === 0) {
			return 0
		}

		const index = Math.ceil((percentile / 100) * sorted.length) - 1
		return sorted[Math.max(0, index)] ?? 0
	}

	return {
		start(): void {

			if (running) {
				return // Already started
			}

			running = true
			scheduleMeasurement()
		},
		stop(): void {

			running = false
			if (timeoutId !== null) {
				clearTimeout(timeoutId)
				timeoutId = null
			}
			if (immediateId !== null) {
				clearImmediate(immediateId)
				immediateId = null
			}
		},
		getStats(): EventLoopStats | null {

			if (lagSamples.length === 0) {
				return null
			}

			const sorted = [...lagSamples].sort((a, b) => a - b)
			const mean = sorted.reduce((sum, val) => sum + val, 0) / sorted.length

			return {
				mean,
				p95: calculatePercentiles(sorted, 95),
				p99: calculatePercentiles(sorted, 99),
				max: sorted[sorted.length - 1] ?? 0,
				sampleCount: sorted.length
			}
		},
		getCurrentLag(): number | null {

			return currentLag
		}
	}
}
