/**
 * @file CPU and memory resource monitor.
 * Tracks CPU usage, memory usage, and load averages at configurable intervals.
 */

import {createPerformanceOnError} from '../../utils/on-error'

import {getResourceLoadAverage} from './resource-load-average'
import type {CPUStats, MemoryStats, ResourceMonitor, ResourceMonitorOptions, ResourceStats} from './resource-monitor-types'

export type {CPUStats, MemoryStats, ResourceMonitor, ResourceMonitorOptions, ResourceStats} from './resource-monitor-types'

/**
 * Create a resource monitor.
 * Tracks CPU and memory usage at configurable intervals.
 *
 * @param options - Monitor options
 * @returns Resource monitor instance
 */
export function createResourceMonitor(options: ResourceMonitorOptions): ResourceMonitor {

	const {
		clock,
		errors,
		intervalMs = 5000,
		onSaturationAlert,
		onPerfEvent,
		thresholds = {}
	} = options

	const onError = createPerformanceOnError(errors, {
		operation: 'module-load',
		monitor: 'resource-monitor'
	})
	if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
		throw new Error('Resource monitor intervalMs must be between 1 and 2147483647')
	}

	const cpuThresholds = {...(thresholds.cpu ?? {})}
	const memoryThresholds = {...(thresholds.memory ?? {})}
	validateThresholds(cpuThresholds, 'CPU')
	validateThresholds(memoryThresholds, 'memory', 1)

	let intervalId: ReturnType<typeof setInterval> | null = null
	let lastCPUUsage: {user: number; system: number} | null = null
	let lastCPUCollectedAt: number | null = null
	let running = false

	function safeCollectStats(): void {
		if (!running) {
			return
		}
		try {
			collectStats()
		} catch(error) {
			onError(error, {operation: 'resource-monitor.tick'})
		}
	}

	/**
	 * Collect and emit resource statistics
	 */
	function collectStats(): void {

		if (
			typeof process === 'undefined' ||
			typeof process.cpuUsage !== 'function' ||
			typeof process.memoryUsage !== 'function'
		) {
			return
		}

		const now = clock.now()

		// CPU usage
		const cpuUsage = process.cpuUsage()

		if (lastCPUUsage) {
			const elapsedMs = lastCPUCollectedAt !== null && now > lastCPUCollectedAt
				? now - lastCPUCollectedAt
				: intervalMs
			const userDelta = Math.max(0, cpuUsage.user - lastCPUUsage.user)
			const systemDelta = Math.max(0, cpuUsage.system - lastCPUUsage.system)
			const totalDelta = userDelta + systemDelta

			// Emit CPU perf event (convert microseconds to milliseconds)
			if (onPerfEvent) {
				try {
					onPerfEvent({
						name: 'cpu_usage',
						duration: totalDelta / 1000, // Convert to ms
						start: now - elapsedMs,
						end: now,
						labels: {
							user: String(userDelta / 1000),
							system: String(systemDelta / 1000),
							utilization: String(totalDelta / (elapsedMs * 1000))
						},
						source: 'runtime'
					})
				} catch(error) {
					onError(error, {operation: 'resource-monitor.perf-event'})
				}
			}

			// Check CPU saturation (approximate: total CPU time / interval)
			// This is a rough approximation
			const cpuUtilization = totalDelta / (elapsedMs * 1000) // Convert to ratio
			if (onSaturationAlert) {
				let severity: 'info' | 'warn' | 'critical' | null = null
				let threshold = 0

				if (cpuThresholds.critical !== undefined && cpuUtilization >= cpuThresholds.critical) {
					severity = 'critical'
					threshold = cpuThresholds.critical
				} else if (cpuThresholds.warn !== undefined && cpuUtilization >= cpuThresholds.warn) {
					severity = 'warn'
					threshold = cpuThresholds.warn
				} else if (cpuThresholds.info !== undefined && cpuUtilization >= cpuThresholds.info) {
					severity = 'info'
					threshold = cpuThresholds.info
				}

				if (severity) {
					try {
						onSaturationAlert({
							reason: 'cpu_saturation',
							severity,
							value: cpuUtilization,
							threshold
						})
					} catch(error) {
						onError(error, {operation: 'resource-monitor.saturation-alert'})
					}
				}
			}
		}

		lastCPUUsage = cpuUsage
		lastCPUCollectedAt = now

		// Memory usage
		const memoryUsage = process.memoryUsage()
		const memoryStats: MemoryStats = {
			rss: memoryUsage.rss,
			heapUsed: memoryUsage.heapUsed,
			heapTotal: memoryUsage.heapTotal,
			external: memoryUsage.external
		}

		// Emit memory perf event
		if (onPerfEvent) {
			try {
				onPerfEvent({
					name: 'memory_usage',
					duration: 0, // Memory is a snapshot, not a duration
					start: now,
					end: now,
					labels: {
						rss: String(memoryStats.rss),
						heapUsed: String(memoryStats.heapUsed),
						heapTotal: String(memoryStats.heapTotal),
						external: String(memoryStats.external)
					},
					source: 'runtime'
				})
			} catch(error) {
				onError(error, {operation: 'resource-monitor.perf-event'})
			}
		}

		// Check memory saturation (heap used / heap total)
		if (memoryStats.heapTotal > 0 && onSaturationAlert) {
			const memoryUtilization = memoryStats.heapUsed / memoryStats.heapTotal
			let severity: 'info' | 'warn' | 'critical' | null = null
			let threshold = 0

			if (memoryThresholds.critical !== undefined && memoryUtilization >= memoryThresholds.critical) {
				severity = 'critical'
				threshold = memoryThresholds.critical
			} else if (memoryThresholds.warn !== undefined && memoryUtilization >= memoryThresholds.warn) {
				severity = 'warn'
				threshold = memoryThresholds.warn
			} else if (memoryThresholds.info !== undefined && memoryUtilization >= memoryThresholds.info) {
				severity = 'info'
				threshold = memoryThresholds.info
			}

			if (severity) {
				try {
					onSaturationAlert({
						reason: 'memory_pressure',
						severity,
						value: memoryUtilization,
						threshold
					})
				} catch(error) {
					onError(error, {operation: 'resource-monitor.saturation-alert'})
				}
			}
		}
	}

	return {
		start(): void {

			if (intervalId !== null) {
				return // Already started
			}

			// Initialize CPU usage baseline
			if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
				lastCPUUsage = process.cpuUsage()
				lastCPUCollectedAt = clock.now()
			}

			running = true
			// Start periodic collection
			intervalId = setInterval(safeCollectStats, intervalMs)
			intervalId.unref?.()
		},
		stop(): void {

			running = false
			if (intervalId !== null) {
				clearInterval(intervalId)
				intervalId = null
			}

			lastCPUUsage = null
			lastCPUCollectedAt = null
		},
		getStats(): ResourceStats | null {

			if (
				typeof process === 'undefined' ||
				typeof process.cpuUsage !== 'function' ||
				typeof process.memoryUsage !== 'function'
			) {
				return null
			}

			const cpuUsage = process.cpuUsage()
			const memoryUsage = process.memoryUsage()

			const cpu: CPUStats = {
				user: cpuUsage.user,
				system: cpuUsage.system,
				total: cpuUsage.user + cpuUsage.system
			}

			const memory: MemoryStats = {
				rss: memoryUsage.rss,
				heapUsed: memoryUsage.heapUsed,
				heapTotal: memoryUsage.heapTotal,
				external: memoryUsage.external
			}

			const loadAverage = getResourceLoadAverage(onError)

			const stats: ResourceStats = {
				cpu,
				memory
			}
			if (loadAverage) {
				stats.loadAverage = loadAverage
			}
			return stats
		}
	}
}

function validateThresholds(
	thresholds: {info?: number; warn?: number; critical?: number},
	name: string,
	max = Number.POSITIVE_INFINITY
): void {
	const ordered = [thresholds.info, thresholds.warn, thresholds.critical]
		.filter((value): value is number => value !== undefined)
	if (!ordered.every((value) => Number.isFinite(value) && value >= 0 && value <= max)) {
		throw new Error(`${name} thresholds must be finite numbers between 0 and ${max}`)
	}
	if (
		(thresholds.info !== undefined && thresholds.warn !== undefined && thresholds.info > thresholds.warn) ||
		(thresholds.warn !== undefined && thresholds.critical !== undefined && thresholds.warn > thresholds.critical) ||
		(thresholds.info !== undefined && thresholds.critical !== undefined && thresholds.info > thresholds.critical)
	) {
		throw new Error(`${name} thresholds must satisfy info <= warn <= critical`)
	}
}
