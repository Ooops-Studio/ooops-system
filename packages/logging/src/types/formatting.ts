/**
 * @file Public types for the Formatting stage in the logging pipeline.
 *
 * The Formatting stage converts a redacted LogRecord into a single text line for output.
 * Modes:
 *  - 'json'   : stable single-line JSON (deterministic field order)
 *  - 'pretty' : human-friendly line with colors when TTY is detected (auto)
 *
 * Implementation notes (non-normative):
 * - TTY is auto-detected by the implementation; no user-facing switch.
 * - Must NOT throw on user paths; report internal issues via `onError` and
 *   return a safe fallback string.
 * - Structured data lives under `attributes`; error is already redacted/normalized.
 */

import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'

/** Available textual formats for a single record. */
export type FormattingMode = 'json' | 'pretty'

/**
 * Options for a formatting pass.
 * No stylistic knobs are exposed; indent/order/colors are fixed by implementation.
 * TTY gating is automatic; the formatter decides based on the runtime.
 */
export interface FormattingOptions {
	/** Output format. Presets choose this. */
	mode: FormattingMode
	/**
	 * Human timestamp rendering (pretty only). JSON ignores this and stays numeric.
   * - 'iso'      → 2025-01-01T12:34:56.123Z
   * - 'unix'     → 1735721696123 (ms since epoch)
   * - 'relative' → +12.345s relative to process start
   */
	timestampFormat?: 'iso' | 'unix' | 'relative'
	/**
   * Optional error hook. Called when the formatter encounters an internal failure.
   * Formatter MUST still return a safe fallback string and never throw.
   */
	errors?: Errors | undefined
}

/**
 * Formatting function signature. Returns a single line of text.
 * MUST NOT throw; use `onError` for internal issues and degrade gracefully.
 */
export type Formatting =
	(record: Readonly<LogRecord>, options: Readonly<FormattingOptions>) => string
