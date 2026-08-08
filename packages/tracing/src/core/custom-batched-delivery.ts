import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import type {SpanExporterPort, SpanProcessorPort} from '../types/ports'

import {BatchingProcessor} from './batching-processor'
import type {BatchingConfig} from './processor-types'
import {captureSpanExporter} from './processor-utils'
import {createResilientExporter, type ResilientExporterOptions} from './transferring'

export interface CustomBatchedDeliveryOptions {
	readonly clock: Clock
	readonly exporter: SpanExporterPort
	readonly batching: BatchingConfig
	readonly resilience: Pick<ResilientExporterOptions,
		'retryPolicy' | 'tokenBucketRate' | 'tokenBucketBurst' | 'breakerThreshold' | 'breakerHalfOpenTimeout'>
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly logger?: Logging
}

export function createCustomBatchedTracingProcessor(options: CustomBatchedDeliveryOptions): SpanProcessorPort {
	const exporter = createResilientExporter({
		...options.resilience,
		exporter: captureSpanExporter(options.exporter),
		clock: options.clock,
		...(options.logger ? {logger: options.logger} : {})
	})
	return new BatchingProcessor(exporter, options.batching, options.clock, options.metrics, options.errors)
}
