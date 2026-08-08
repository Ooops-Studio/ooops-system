import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'

import type {SpanExporterPort, SpanProcessorPort} from '../types/ports'

import {captureSpanExporter} from './processor-utils'
import {SimpleProcessor} from './simple-processor'
import {createResilientExporter, type ResilientExporterOptions} from './transferring'

export interface CustomDirectDeliveryOptions {
	readonly clock: Clock
	readonly exporter: SpanExporterPort
	readonly resilience: Pick<ResilientExporterOptions,
		'retryPolicy' | 'tokenBucketRate' | 'tokenBucketBurst' | 'breakerThreshold' | 'breakerHalfOpenTimeout'>
	readonly errors?: Errors
	readonly logger?: Logging
}

export function createCustomDirectTracingProcessor(options: CustomDirectDeliveryOptions): SpanProcessorPort {
	const exporter = createResilientExporter({
		...options.resilience,
		exporter: captureSpanExporter(options.exporter),
		clock: options.clock,
		...(options.errors ? {errors: options.errors} : {}),
		...(options.logger ? {logger: options.logger} : {})
	})
	return new SimpleProcessor(exporter)
}
