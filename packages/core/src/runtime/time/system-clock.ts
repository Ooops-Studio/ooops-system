/**
 * @file System wall-clock in milliseconds. DI-free, no logging, no timers on import.
 * Example: const clock = createSystemClock(); const t = clock.now()
 */

export interface MillisClock {
	/** Current wall time in milliseconds since Unix epoch */
	now(): number
}

const nativeDateNow = Date.now.bind(Date)

/** Uses Date.now() for portability and performance */
export function createSystemClock(): MillisClock {
	return {
		// Capture the intrinsic once so later prototype/global rewiring cannot
		// poison timestamps across every service sharing this clock.
		now: () => nativeDateNow()
	}
}
