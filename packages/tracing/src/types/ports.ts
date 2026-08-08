/**
 * @file Port interfaces for tracing service.
 */
import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import type {
	SpanExportResult,
	SpanExporter
} from '@ooopsstudio/core/runtime/tracing'
import type {Sampler} from '@ooopsstudio/core/utils/tracing'
/**
 * Span processor interface.
 * Processes spans before export (batching, filtering, etc.).
 */
export interface SpanProcessorPort {
	/**
	 * Called when a span ends.
	 * @param span - Completed span record
	 */
	onEnd(span: SpanRecord): void
	/**
	 * Flush pending spans.
	 * @returns Promise that resolves when flush is complete
	 */
	flush(): Promise<void>
	/**
	 * Shutdown the processor.
	 * @returns Promise that resolves when shutdown is complete
	 */
	shutdown(): Promise<void>
	/** Current queue size, if any. */
	getQueueSize?(): number
	/** Install or replace processor telemetry hooks. */
	setObserver?(observer: {
		onExported?(count: number): void
		onDropped?(count: number, error?: unknown, metricsReported?: boolean): void
		onExportFailure?(error: unknown): void
		onPartialDelivery?(error: unknown): void
		onRetry?(): void
		onSinkState?(state: 'healthy' | 'degraded' | 'unhealthy'): void
	}): void
}
/**
 * Span exporter port (re-export from engines for convenience).
 */
export interface SpanExporterPort extends SpanExporter {
	/** Optional internal final delivery barrier. */
	flush?(): Promise<void>
	/** Internal shutdown-drain signal: interrupt retries but keep first attempts admissible. */
	prepareShutdown?(): void
}
/**
 * Structured export outcome re-export.
 */
export type SpanExportResultPort = SpanExportResult
/**
 * Sampler port (re-export from engines for convenience).
 */
export type SamplerPort = Sampler
