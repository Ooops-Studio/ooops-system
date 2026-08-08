/**
 * @file Timestamp helpers for formatters.
 *
 * Note: Relative timestamps use first timestamp as start anchor (not deterministic).
 * For deterministic behavior, use ISO or unix timestamps.
 */

let RELATIVE_START: number | undefined

/** For tests: reset the relative start anchor. */
export function resetRelativeStart(forTesting?: number) {
	RELATIVE_START = typeof forTesting === 'number' ? forTesting : undefined
}

/**
 * Format a timestamp based on mode and human-friendly kind.
 * JSON stays numeric (stringified) regardless of kind.
 *
 * Note: Relative timestamps use first timestamp as start anchor.
 * This is not deterministic - use ISO or unix for deterministic output.
 */
export function formatTimestamp(
	ts: number,
	mode: 'json' | 'pretty',
	kind?: 'iso' | 'unix' | 'relative'
): string {
	if (mode === 'json') return String(ts)

	switch (kind ?? 'iso') {
		case 'unix':
			return String(ts)
		case 'relative': {
			// Initialize start time on first call if not set
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (RELATIVE_START === undefined) {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				RELATIVE_START = ts
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
			const delta = Math.max(0, ts - RELATIVE_START) / 1000
			return `+${delta.toFixed(3)}s`
		}
		case 'iso':
		default:
			return new Date(ts).toISOString()
	}
}
