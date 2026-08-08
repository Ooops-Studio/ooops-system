import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext, SpanKind} from '@ooopsstudio/core/contracts/tracing'
import type {Sampler} from '@ooopsstudio/core/utils/tracing'

import {deepFreezeSpanRecord, snapshotSpanAttributes} from './span-recorder-safety'

interface TracerAdmissionOptions {
	sampler: Sampler
	isShutdownRequested(): boolean
	reportInternalError(error: unknown, context: {operation: string}): void
}

/** Own lifecycle-aware admission and sampling state for one tracer. */
export function createTracerAdmission(options: TracerAdmissionOptions) {
	return {
		shouldDropSpan: (
			kind: SpanKind,
			parent: SpanContext | undefined,
			name: string,
			attributes?: LogAttributes
		): boolean => {
			if (options.isShutdownRequested()) return true
			let decision: ReturnType<Sampler['decide']>
			try {
				const samplingParent = parent ? Object.freeze({...parent}) : undefined
				const samplingAttributes = attributes
					? deepFreezeSpanRecord(snapshotSpanAttributes(attributes, 128, 8_192) ?? {})
					: undefined
				decision = options.sampler.decide(samplingParent, name, samplingAttributes)
			} catch(error) {
				options.reportInternalError(error, {operation: 'sampling'})
				return true
			}
			if (decision !== 'drop' && decision !== 'record-and-sample') {
				options.reportInternalError(new Error('Tracing sampler returned an invalid decision'), {operation: 'sampling'})
				return true
			}
			return decision === 'drop'
		},
		dispose: (): void => undefined
	}
}
