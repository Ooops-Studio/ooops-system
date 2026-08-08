import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Sampler} from '@ooopsstudio/core/utils/tracing'

import {createSpanRedaction} from '../features/redaction/span-redaction'
import type {TraceRedactionRule} from '../features/redaction/types'
import type {SpanProcessorPort} from '../types/ports'

import {createTracingCoreRuntime} from './runtime-core'
import type {ManagedTracing} from './types'

/** Runtime boundary for custom-only configuration and stricter redaction rules. */
export interface CustomTracingRuntimeOptions {
	readonly clock: Clock
	readonly sampler: Sampler
	readonly processor: SpanProcessorPort
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
	readonly lifecycle?: LifecyclePort
	readonly resource?: ObservabilityResource
	readonly redactionRules?: ReadonlyArray<TraceRedactionRule>
	readonly limits: {maxAttributesPerSpan: number; maxEventsPerSpan: number; maxAttrBytes: number}
}

export function createCustomTracingRuntime(options: CustomTracingRuntimeOptions): Promise<ManagedTracing> {
	return createTracingCoreRuntime({
		...options,
		preset: 'custom',
		redactAttributes: createSpanRedaction({
			rules: options.redactionRules ?? [],
			...(options.errors ? {errors: options.errors} : {})
		})
	})
}
