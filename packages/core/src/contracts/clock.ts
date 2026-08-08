/**
 * @file Time-source abstractions for deterministic behavior and fake timers
 * in tests. Contracts carry no timers; scheduling belongs to services.
 */

export interface Clock {
	/** Epoch milliseconds; monotonicity is not guaranteed. */
	now(): number
}

export interface Deadline {
	/** Point in time (epoch ms) when the deadline occurs. */
	readonly at: number
	/** Remaining ms at 'currentTime' (or using the same Clock). */
	timeRemaining(currentTime?: number): number
	/** Whether the deadline has passed at 'currentTime'. */
	expired(currentTime?: number): boolean
}