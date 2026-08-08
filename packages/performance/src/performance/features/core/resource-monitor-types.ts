import type {PerfEvent, SaturationAlert} from '@ooopsstudio/core/contracts/performance'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import type {HighResClock} from '../../core/clock'

export interface CPUStats {
	user: number
	system: number
	total: number
}

export interface MemoryStats {
	rss: number
	heapUsed: number
	heapTotal: number
	external: number
}

export interface ResourceStats {
	cpu: CPUStats
	memory: MemoryStats
	loadAverage?: [number, number, number]
}

export interface ResourceMonitor {
	start(): void
	stop(): void
	getStats(): ResourceStats | null
}

export interface ResourceMonitorOptions {
	clock: HighResClock
	errors?: Errors
	intervalMs?: number
	onSaturationAlert?: (alert: SaturationAlert) => void
	onPerfEvent?: (event: PerfEvent) => void
	thresholds?: {
		cpu?: {info?: number; warn?: number; critical?: number}
		memory?: {info?: number; warn?: number; critical?: number}
	}
}
