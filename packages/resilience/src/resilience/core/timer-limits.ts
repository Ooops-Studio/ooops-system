/** Largest delay Node.js schedules without coercing it to a near-immediate timer. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export function isSafeTimerDelay(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS
}
