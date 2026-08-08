import type {PerfEvent, SaturationAlert} from '@ooopsstudio/core/contracts/performance'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import type {HighResClock} from '../../core/clock'

export interface GCStats {
	majorCount: number
	minorCount: number
	totalPauseTimeMs: number
	avgPauseTimeMs: number
	maxPauseTimeMs: number
}

export interface GCMonitor {
	start(): void
	stop(): void
	getStats(): GCStats
	getHeapUsage(): {heapUsed: number; heapTotal: number; heapLimit?: number} | null
}

export interface GCMonitorOptions {
	clock: HighResClock
	errors?: Errors
	onSaturationAlert?: (alert: SaturationAlert) => void
	onPerfEvent?: (event: PerfEvent) => void
	thresholds?: {
		pauseTime?: {warn?: number; critical?: number}
		heapUsage?: {warn?: number; critical?: number}
	}
}

export interface PerformanceEntryList {
	getEntries(): ReadonlyArray<PerformanceEntry>
}

export interface PerformanceEntry {
	entryType: string
	name: string
	duration: number
	detail?: {kind?: number}
}

export interface PerformanceObserverInterface {
	observe(options: {entryTypes: string[]}): void
	disconnect(): void
}

export interface PerformanceObserverConstructor {
	new (callback: (list: PerformanceEntryList) => void): PerformanceObserverInterface
}

export interface PerfHooksModule {
	PerformanceObserver: PerformanceObserverConstructor
}

export type PerfHooksModuleType = typeof import('perf_hooks')
