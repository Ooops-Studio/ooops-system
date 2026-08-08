/**
 * @file Type exports for error handler presets.
 */

export const ERRORS_PUBLIC_TYPES_RUNTIME = true

export type {
	ErrorHandlerPort,
	ErrorsHandlerPort,
	ErrorHandlerOptions,
	ErrorClassificationRegistry
} from '../types/error-handler'

export type {
	EnrichedError,
	ErrorSeverity,
	ErrorCategory
} from '../types/normalized-error'

export type {
	LoggerPort,
	TracerPort,
	MetricsPort,
	CachePort
} from '../types/ports'

export type {ErrorSink, SentryErrorSinkConfig} from '../sinks/types'

export type {
	ErrorObservabilityEvent,
	ErrorObservabilityPayload,
	ErrorObservabilityPayloadMap,
	ObservabilityTap
} from '../types/observability'
