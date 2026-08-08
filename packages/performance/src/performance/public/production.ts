import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createBasePerformanceHandler} from '../core/base-handler'
import type {ManagedPerformance} from '../types/ports'
import {failPerformanceSetup, registerPerformanceLifecycleCleanup} from '../utils/lifecycle-cleanup'
import {snapshotPerformancePresetOptions} from '../utils/preset-options'

export interface ProductionPerformanceOptions {
	clock?: Clock
	resource?: ObservabilityResource
	errors?: Errors
	tracer?: Tracing
	lifecycle?: LifecyclePort
}

const PRODUCTION_OPTION_FIELDS = new Set(['clock', 'resource', 'errors', 'tracer', 'lifecycle'])

export async function createProductionPerformance(options: ProductionPerformanceOptions = {}): Promise<ManagedPerformance> {
	const configured = snapshotPerformancePresetOptions(
		options, PRODUCTION_OPTION_FIELDS, 'Production performance options'
	)
	const {createMonitors, stopAllMonitors} = await import('../core/runtime/monitors')
	const handler = createBasePerformanceHandler({
		clock: configured.clock === undefined ? createSystemClock() : configured.clock as Clock,
		cardinalityLimit: 20,
		cardinalityMode: 'drop',
		enableEventLoopMonitor: true,
		enableGCMonitor: true,
		enableResourceMonitor: true,
		createRuntimeMonitoring: (monitorOptions) => {
			const monitors = createMonitors(monitorOptions)
			return {stop: () => stopAllMonitors(monitors)}
		},
		...(configured.errors ? {errors: configured.errors as Errors} : {}),
		...(configured.tracer ? {tracer: configured.tracer as Tracing} : {})
	})
	try {
		registerPerformanceLifecycleCleanup(configured.lifecycle as LifecyclePort | undefined, handler)
	} catch(error) {
		return await failPerformanceSetup(handler, error)
	}
	return handler
}
