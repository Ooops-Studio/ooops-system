/**
 * @file Rate limit engine types.
 * Engines are pure logic - no observability, no logging.
 */

/**
 * Discriminated union for engine types.
 * Used by handler to select and report which engine is active.
 */
export type RateLimitEngineType = 'redis' | 'memory'

/** Raw engine decision consumed by the handler. */
export interface RateLimitEngineResult {
	allowed: boolean
	remaining: number
	resetAt: number
	/** Earliest admission time for a denied request; defaults to resetAt. */
	retryAt?: number
}

/**
 * Rate limit engine interface.
 * Engines implement pure rate limiting logic without observability.
 *
 * Key design principle:
 * - Engines are stateless from caller perspective (state is internal or in Redis)
 * - Engines know nothing about rules, contexts, metrics, or logging
 * - Handler is responsible for key generation and observability
 */
export interface RateLimitEngine {

	/** Engine type identifier for metrics/logging */
	readonly type: RateLimitEngineType

	/**
	 * Check and consume tokens atomically.
	 *
	 * @param key - Pre-generated storage key (handler generates this)
	 * @param limit - Maximum allowed requests in window
	 * @param windowMs - Window duration in milliseconds
	 * @param cost - Number of tokens to consume (default: 1). MUST be > 0.
	 *   For probe operations, use `peek()` instead.
	 * @returns Engine result with count and remaining
	 */
	checkAndConsume(
		key: string,
		limit: number,
		windowMs: number,
		cost?: number
	): Promise<RateLimitEngineResult>

	/**
	 * Peek at current state without consuming tokens.
	 * This is an explicit API for probe mode - it guarantees a completely non-mutating read.
	 *
	 * **Contract:**
	 * - MUST NOT mutate any internal state:
	 *   - no token consumption
	 *   - no count increments
	 *   - no window rotations written back
	 *   - no cleanup side-effects (no deletes / inserts)
	 * - MUST return accurate `allowed`, `remaining`, and `resetAt` values
	 * - Multiple calls with the same parameters MUST return identical results
	 * - This is the ONLY way to check quota without consumption
	 *
	 * **Implementation:**
	 * Engines MUST implement dedicated peek logic that does NOT call `checkAndConsume`.
	 * Peek operations MUST treat engine state as read-only. Implementations SHOULD:
	 * - read the current state from internal storage
	 * - apply any time-based calculations (refill, leak, rotate) in local variables only
	 * - NEVER write the derived state back to internal storage
	 *
	 * In other words: peek computes a **virtual** view of state at `now` without
	 * persisting that view.
	 *
	 * **CRITICAL:** Do NOT implement peek by calling `checkAndConsume(key, limit, windowMs, 0)`.
	 * `checkAndConsume` with cost=0 is explicitly forbidden and will throw an error.
	 *
	 * @param key - Pre-generated storage key (handler generates this)
	 * @param limit - Maximum allowed requests in window
	 * @param windowMs - Window duration in milliseconds
	 * @param cost - Optional requested cost to test for admission without consuming.
	 *   Defaults to 1. MUST be >= 0.
	 * @returns Engine result with current count and remaining (no consumption)
	 */
	peek(
		key: string,
		limit: number,
		windowMs: number,
		cost?: number
	): Promise<RateLimitEngineResult>

}
