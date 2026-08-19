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

	/** Samples required before evaluating the rolling percentile. */
	minimumSamples?: number

	/** Milliseconds between reminders while warning or critical persists. Zero disables reminders. */
	reminderIntervalMs?: number

}

type EventLoopSaturationState = 'healthy' | 'warn' | 'critical'

const MAX_LAG_SAMPLES = 100
const DEFAULT_MINIMUM_SAMPLES = 20
const DEFAULT_REMINDER_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_TRANSITION_CONFIRMATION_SAMPLES = 5
const DEFAULT_RECOVERY_CONFIRMATION_SAMPLES = 30

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
		thresholds = {},
		minimumSamples = DEFAULT_MINIMUM_SAMPLES,
		reminderIntervalMs = DEFAULT_REMINDER_INTERVAL_MS
	} = options

	if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
		throw new Error('Event loop intervalMs must be between 1 and 2147483647')
	}
	if (!Number.isSafeInteger(minimumSamples) || minimumSamples <= 0 || minimumSamples > MAX_LAG_SAMPLES) {
		throw new Error(`Event loop minimumSamples must be between 1 and ${MAX_LAG_SAMPLES}`)
	}
	if (!Number.isSafeInteger(reminderIntervalMs) || reminderIntervalMs < 0 || reminderIntervalMs > 2_147_483_647) {
		throw new Error('Event loop reminderIntervalMs must be between 0 and 2147483647')
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
	let saturationState: EventLoopSaturationState = 'healthy'
	let pendingSaturationState: EventLoopSaturationState | null = null
	let pendingSaturationSamples = 0
	let lastSaturationNotificationAt: number | null = null
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
			if (lagSamples.length > MAX_LAG_SAMPLES) {
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

			// Evaluate saturation from the rolling p95 instead of reacting to a
			// single delayed tick. Emit only transitions plus a bounded reminder.
			if (onSaturationAlert && lagSamples.length >= minimumSamples) {
				const sorted = [...lagSamples].sort((a, b) => a - b)
				const p95 = calculatePercentiles(sorted, 95)
				// Treat the informational band as recovery hysteresis. Once the
				// runtime has entered warning or critical, it must fall below the
				// info threshold before it is considered healthy again. This avoids
				// warning/recovery log flapping while p95 hovers around the warning
				// boundary without losing the per-sample lag metric.
				const measuredState: EventLoopSaturationState = p95 >= criticalThreshold
					? 'critical'
					: p95 >= warnThreshold
						? 'warn'
						: p95 < infoThreshold ? 'healthy' : saturationState
				// Keep an active incident at its highest observed severity until the
				// recovery band is stable. A critical incident must not oscillate back
				// to warning whenever rolling p95 crosses the critical boundary; that
				// downgrade is not actionable and previously flooded downstream logs.
				const observedState: EventLoopSaturationState = saturationState === 'critical' && measuredState === 'warn'
					? 'critical'
					: measuredState
				if (observedState === saturationState) {
					pendingSaturationState = null
					pendingSaturationSamples = 0
				} else if (pendingSaturationState === observedState) {
					pendingSaturationSamples += 1
				} else {
					pendingSaturationState = observedState
					pendingSaturationSamples = 1
				}
				const confirmationSamples = observedState === 'healthy'
					? DEFAULT_RECOVERY_CONFIRMATION_SAMPLES
					: DEFAULT_TRANSITION_CONFIRMATION_SAMPLES
				const nextState = observedState !== saturationState && pendingSaturationSamples >= confirmationSamples
					? observedState
					: saturationState
				let observedAt: number | null = null
				try { observedAt = clock.now() } catch { /* reminders are optional when the wall clock fails */ }
				const stateChanged = nextState !== saturationState
				const active = nextState === 'warn' || nextState === 'critical'
				const reminderDue = active && reminderIntervalMs > 0 && observedAt !== null &&
					lastSaturationNotificationAt !== null &&
					observedAt - lastSaturationNotificationAt >= reminderIntervalMs

				if (stateChanged || reminderDue) {
					const previousState = saturationState
					saturationState = nextState
					if (stateChanged) {
						pendingSaturationState = null
						pendingSaturationSamples = 0
					}
					if (observedAt !== null) lastSaturationNotificationAt = observedAt
					const severity = nextState === 'healthy' ? 'info' : nextState
					const threshold = nextState === 'critical'
						? criticalThreshold
						: nextState === 'warn' ? warnThreshold : infoThreshold
					try {
						onSaturationAlert({
							reason: 'event_loop_lag',
							severity,
							value: p95,
							threshold,
							state: nextState,
							previousState,
							...(reminderDue ? {reminder: true} : {}),
							aggregation: 'p95',
							sampleCount: lagSamples.length
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
