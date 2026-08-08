import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Sampler} from '@ooopsstudio/core/utils/tracing'

import {createSpanRedaction} from '../features/redaction/span-redaction'
import type {SpanProcessorPort} from '../types/ports'

import {createTracingCoreRuntime} from './runtime-core'
import type {ManagedTracing} from './types'

/** Runtime shared by fixed development and production presets. */
export interface StandardTracingRuntimeOptions {
	readonly clock: Clock
	readonly sampler: Sampler
	readonly processor: SpanProcessorPort
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
	readonly lifecycle?: LifecyclePort
	readonly resource?: ObservabilityResource
	readonly limits: {maxAttributesPerSpan: number; maxEventsPerSpan: number; maxAttrBytes: number}
	readonly preset: 'development' | 'production'
}

export function createStandardTracingRuntime(options: StandardTracingRuntimeOptions): Promise<ManagedTracing> {
	return createTracingCoreRuntime({
		...options,
		redactAttributes: createSpanRedaction({
			rules: [],
			...(options.errors ? {errors: options.errors} : {})
		})
	})
}
