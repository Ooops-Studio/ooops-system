import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {createAlwaysOnSampler, createParentBasedSampler} from '@ooopsstudio/core/utils/tracing'

import {MAX_ATTRIBUTES_DEVELOPMENT, MAX_ATTR_BYTES_DEVELOPMENT, MAX_EVENTS_DEVELOPMENT} from '../constants'
import {SimpleProcessor} from '../core/simple-processor'
import {createConsoleExporter} from '../features/exporters/console-exporter'
import {captureClock} from '../utils/capabilities'

import {snapshotDevelopmentOptions} from './options'
import {createStandardTracingRuntime} from './standard-runtime'
import type {ManagedTracing} from './types'

export interface DevelopmentTracingOptions {
	readonly clock?: Clock
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
	readonly lifecycle?: LifecyclePort
	readonly resource?: ObservabilityResource
}

/** Local-only tracing: direct, complete, redacted console output. */
export async function createDevelopmentTracing(options: DevelopmentTracingOptions = {}): Promise<ManagedTracing> {
	const safeOptions = snapshotDevelopmentOptions(options) as unknown as DevelopmentTracingOptions
	const clock = captureClock(safeOptions.clock ?? createSystemClock())
	return createStandardTracingRuntime({
		clock,
		sampler: createParentBasedSampler(createAlwaysOnSampler()),
		processor: new SimpleProcessor(createConsoleExporter({color: true})),
		...(safeOptions.errors ? {errors: safeOptions.errors} : {}),
		...(safeOptions.metrics ? {metrics: safeOptions.metrics} : {}),
		...(safeOptions.logger ? {logger: safeOptions.logger} : {}),
		...(safeOptions.lifecycle ? {lifecycle: safeOptions.lifecycle} : {}),
		...(safeOptions.resource ? {resource: safeOptions.resource} : {}),
		limits: {
			maxAttributesPerSpan: MAX_ATTRIBUTES_DEVELOPMENT,
			maxEventsPerSpan: MAX_EVENTS_DEVELOPMENT,
			maxAttrBytes: MAX_ATTR_BYTES_DEVELOPMENT
		},
		preset: 'development'
	})
}
