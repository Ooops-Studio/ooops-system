/**
 * @file Canonical logging data model shared across the monorepo.
 * Pure types only; no DI and no service coupling. Timestamps are epoch
 * milliseconds (a Clock is injected by implementations).
 */

import type {JsonValue} from './json'

/** Ascending severity. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/**
 * Free-form, read-only enrichment fields. Keep well-known keys (e.g. requestId,
 * userId, traceId) here as conventions rather than hard-coding them in the type.
 */
export type LogAttributes = Readonly<Record<string, JsonValue>>

/** Optional labels for classification */
export type LogTags = ReadonlyArray<string>

/**
 * Context blended into events:
 * - namespace: logical area (e.g., 'http', 'db')
 * - attributes: structured metadata (JSON-safe)
 * - tags: lightweight labels
 */
export interface LogContext {
	readonly namespace?: string
	readonly attributes?: LogAttributes
	readonly tags?: LogTags
}

/**
 * Canonical log record shape emitted internally by logging implementations and
 * transported to sinks/observers. Errors are normalized via the Errors port and
 * are not part of this record.
 */
export interface LogRecord {
	/** Severity of the event. */
	readonly level: LogLevel
	/** Epoch milliseconds from an injected clock. */
	readonly time: number
	/** Human-readable message. */
	readonly message: string
	/** Arbitrary structured attributes (optional). */
	readonly context?: LogContext
}