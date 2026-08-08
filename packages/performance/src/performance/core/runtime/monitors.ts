import type {PerfEvent, SaturationAlert} from '@ooopsstudio/core/contracts/performance'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import {createEventLoopMonitor, type EventLoopMonitor} from '../../features/core/event-loop-monitor'
import {createGCMonitor, type GCMonitor} from '../../features/core/gc-monitor'
import {createResourceMonitor, type ResourceMonitor} from '../../features/core/resource-monitor'
import {withErrorBoundary} from '../../utils/error-boundary'
import type {HighResClock} from '../clock'

export interface Monitors {
	eventLoopMonitor?: EventLoopMonitor
	gcMonitor?: GCMonitor
	resourceMonitor?: ResourceMonitor
}

export interface MonitorsOptions {
	clock: HighResClock
	onPerfEvent: (event: PerfEvent) => void
	onSaturationAlert?: (alert: SaturationAlert) => void
	errors?: Errors
	enableEventLoopMonitor: boolean
	enableGCMonitor: boolean
	enableResourceMonitor: boolean
}

export function createMonitors(options: MonitorsOptions): Monitors {
	const monitors: Monitors = {}
	const safelyEmitEvent = (event: PerfEvent) => {
		try { options.onPerfEvent(event) } catch { /* monitors never break the host */ }
	}
	const safelyEmitAlert = (alert: SaturationAlert) => {
		try { options.onSaturationAlert?.(alert) } catch { /* observers are isolated */ }
	}
	try {
		if (options.enableEventLoopMonitor) {
			monitors.eventLoopMonitor = createEventLoopMonitor({
				clock: options.clock,
				onPerfEvent: safelyEmitEvent,
				onSaturationAlert: safelyEmitAlert
			})
			withErrorBoundary(() => monitors.eventLoopMonitor?.start(), options.errors, {operation: 'eventLoopMonitor.start'})()
		}
		if (options.enableGCMonitor) {
			monitors.gcMonitor = createGCMonitor({
				clock: options.clock,
				...(options.errors ? {errors: options.errors} : {}),
				onPerfEvent: safelyEmitEvent,
				onSaturationAlert: safelyEmitAlert
			})
			withErrorBoundary(() => monitors.gcMonitor?.start(), options.errors, {operation: 'gcMonitor.start'})()
		}
		if (options.enableResourceMonitor) {
			monitors.resourceMonitor = createResourceMonitor({
				clock: options.clock,
				...(options.errors ? {errors: options.errors} : {}),
				onPerfEvent: safelyEmitEvent,
				onSaturationAlert: safelyEmitAlert
			})
			withErrorBoundary(() => monitors.resourceMonitor?.start(), options.errors, {operation: 'resourceMonitor.start'})()
		}
	} catch(error) {
		stopAllMonitors(monitors)
		throw error
	}
	return monitors
}

export function stopAllMonitors(monitors: Monitors): void {
	try { monitors.eventLoopMonitor?.stop() } catch { /* cleanup continues */ }
	try { monitors.gcMonitor?.stop() } catch { /* cleanup continues */ }
	try { monitors.resourceMonitor?.stop() } catch { /* cleanup continues */ }
}
