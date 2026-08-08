import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes, LogContext, LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import type {LoggingSamplingPolicy} from './handler'

export type EnrichingProvider = (
	record: Readonly<LogRecord>
) => LogAttributes | Promise<LogAttributes>

export type EnrichingOnError = (error: unknown, info?: {provider?: string}) => void

export interface MergeContextOptions {
	readonly dedupeTags?: boolean
}

export interface EnrichingOptions {
	context?: LogContext
	providers?: ReadonlyArray<EnrichingProvider>
	errors?: Errors
}

export type Enriching = (
	record: Readonly<LogRecord>,
	options?: EnrichingOptions
) => Promise<LogRecord> | LogRecord

export interface EnrichingPresetOptions {
	readonly clock?: Clock
	readonly resource?: ObservabilityResource
	readonly context?: LogContext
	readonly providers?: ReadonlyArray<EnrichingProvider>
	readonly mutableLevel?: boolean
	readonly sampling?: LoggingSamplingPolicy
	readonly errors?: Errors
	readonly selfMetrics?: boolean
	readonly metrics?: MetricsPort
	readonly lifecycle?: LifecyclePort
}

export type EnrichingDevelopmentOptions = EnrichingPresetOptions
export type EnrichingProductionOptions = EnrichingPresetOptions
export type EnrichingCustomOptions = EnrichingPresetOptions
