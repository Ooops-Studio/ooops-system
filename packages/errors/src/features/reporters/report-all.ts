
import type {ErrorSink} from '../../sinks'
import type {EnrichedError} from '../../types/normalized-error'
import type {ObservabilityTap} from '../../types/observability'
import type {LoggerPort, MetricsPort, TracerPort} from '../../types/ports'
import {projectRedactedError, redactEnrichedError, sanitizeErrorDiagnostic} from '../../utils/redaction'

import {reportToLog} from './log-reporter'
import {reportToMetrics} from './metrics-reporter'
import {reportToTrace} from './trace-reporter'

export interface ReportAllOptions {
	readonly customReport?: (error: EnrichedError) => void | Promise<void>
	readonly logger?: LoggerPort
	readonly tracer?: TracerPort
	readonly metrics?: MetricsPort
	readonly observe?: ObservabilityTap
	readonly sink?: ErrorSink
}

export type ReporterName = 'custom' | 'log' | 'metrics' | 'trace' | 'sink'

export interface ReportAllResult {
	readonly configured: number
	readonly delivered: number
	readonly failed: number
}

/**
 * Fan out one already-redacted error. Reporter failures are isolated: exception
 * reporting must never be another source of application failure.
 */
export async function reportAll(
	error: EnrichedError,
	options: ReportAllOptions
): Promise<ReportAllResult> {
	const publicError = redactEnrichedError(error)
	const observe: ObservabilityTap = options.observe ?? (() => undefined)
	const reporters: Array<[ReporterName, () => Promise<void>]> = []
	const customReport = options.customReport
	if (customReport) {
		reporters.push(['custom', async() => {
			await customReport(projectRedactedError(publicError))
		}])
	}

	// Recursive self-report suppression is not a successful delivery. Exclude
	// those integrations from the attempted set so delivery diagnostics remain
	// truthful; each individual reporter keeps its own guard as defense-in-depth.
	if (options.logger && publicError.source !== 'logging') {
		reporters.push(['log', async() => await reportToLog(publicError, options.logger)])
	}
	if (options.metrics && publicError.source !== 'metrics') {
		reporters.push(['metrics', async() => await reportToMetrics(publicError, options.metrics)])
	}
	if (options.tracer && publicError.source !== 'tracing') {
		reporters.push(['trace', async() => await reportToTrace(publicError, options.tracer)])
	}
	const sink = options.sink
	if (sink) reporters.push(['sink', async() => {
		await sink.capture(projectRedactedError(publicError))
	}])

	let delivered = 0
	let failed = 0
	await Promise.all(reporters.map(async([name, report]) => {
		try {
			await report()
			delivered++
			observe('error:reporter', {reporter: name, status: 'ok', error: redactEnrichedError(publicError)})
		} catch(reportError) {
			failed++
			observe('error:reporter', {
				reporter: name,
				status: 'error',
				error: redactEnrichedError(publicError),
				reason: sanitizeErrorDiagnostic(reportError)
			})
		}
	}))

	observe('error:reported', {
		error: redactEnrichedError(publicError),
		delivery: {configured: reporters.length, delivered, failed}
	})
	return {configured: reporters.length, delivered, failed}
}
