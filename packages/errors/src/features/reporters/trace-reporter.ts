/**
 * @file Trace reporter for error handling.
 */

import type {EnrichedError} from '../../types/normalized-error'
import type {TracerPort} from '../../types/ports'
import {projectRedactedError, redactEnrichedError, sanitizeErrorDiagnosticId} from '../../utils/redaction'

/**
 * Internal implementation of trace reporting
 */
async function reportToTraceImpl(error: EnrichedError, tracer: TracerPort): Promise<void> {
	// Tracing failures are already being diagnosed by the errors service. Sending
	// them back to the failing tracer would create the same recursive feedback
	// loop that the logging reporter explicitly prevents.
	if (error.source === 'tracing') return

	const reports: Array<Promise<unknown>> = []
	const recordException = tracer.recordException
	const addBreadcrumb = tracer.addBreadcrumb
	const readTraceId = tracer.currentTraceId
	// Record exception if available
	if (recordException) {
		let currentTraceId: string | undefined
		try { currentTraceId = sanitizeErrorDiagnosticId(readTraceId?.()) } catch { currentTraceId = undefined }
		const traceId = error.traceId ?? currentTraceId
		const correlationId = error.correlationId
		// Give each tracer callback an isolated projection. A hostile or merely
		// stateful recordException implementation must not be able to alter the
		// breadcrumb assembled by the sibling callback.
		reports.push(Promise.resolve().then(() => recordException(projectRedactedError(error), {
			...(traceId ? {traceId} : {}),
			...(correlationId ? {correlationId} : {})
		})))
	}

	// Add breadcrumb if available
	if (addBreadcrumb) {
		reports.push(Promise.resolve().then(() => addBreadcrumb({
			category: 'error',
			message: error.message,
			level: error.severity,
			data: {
				kind: error.kind,
				code: error.code,
				category: error.category,
				...(error.correlationId ? {correlationId: error.correlationId} : {}),
				...(error.traceId ? {traceId: error.traceId} : {})
			}
		})))
	}
	const results = await Promise.allSettled(reports)
	const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
	if (failure) throw failure.reason
}

/**
 * Report an error to tracing
 * @param error - The error to report
 * @param tracer - Optional tracer port
 * @returns Promise that resolves when reporting is complete
 */
export async function reportToTrace(error: EnrichedError, tracer?: TracerPort): Promise<void> {
	if (!tracer) return
	await reportToTraceImpl(redactEnrichedError(error), tracer)
}
