/**
 * @file Timestamp normalization utilities.
 * Converts timestamps to milliseconds since epoch for consistent metric recording.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'

/**
 * Normalize a timestamp to milliseconds since epoch
 * @param timestamp - Optional timestamp (if not provided, uses current time from clock)
 * @param clock - Clock instance for current time
 * @returns Timestamp in milliseconds since epoch
 */
export function normalizeTimestamp(timestamp: number | undefined, clock: Clock): number {

	if (timestamp !== undefined) {
		return timestamp
	}

	return clock.now()
}
