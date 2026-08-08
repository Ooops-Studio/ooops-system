/**
 * @file Optional port interfaces for error handler dependencies.
 * These are optional - handlers gracefully degrade if not provided.
 */

import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {TracerPort} from '@ooopsstudio/core/ports/tracing'

/**
 * Minimal logging port interface (reuses existing Logging port)
 */
export type LoggerPort = Logging

/** Optional string cache used only by the errors deduplication runtime. */
export interface CachePort {
	get?(key: string): Promise<string | undefined> | string | undefined
	set?(key: string, value: string, ttl?: number): Promise<void> | void
	delete?(key: string): Promise<void> | void
}

export type {LifecyclePort, MetricsPort, TracerPort}
