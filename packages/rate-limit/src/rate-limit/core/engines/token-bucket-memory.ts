import type {Clock} from '@ooopsstudio/core/contracts/clock'

import type {RateLimitEngineResult} from '../../types/engine'
import {readRateLimitClock, safeRateLimitDeadline} from '../time'

import {
	CAPACITY_CLEANUP_RETRY_MS,
	CLEANUP_INTERVAL_MS,
	MAX_KEYS_THRESHOLD,
	MICROTOKENS_PER_TOKEN,
	assertMemoryKeyCapacity
} from './constants'

interface TokenBucketState {
	tokens: number
	fractionalRemainder: number
	lastRefill: number
	cleanupAt: number
}

/** Guards only binary floating-point noise at microtoken boundaries. */
const MICROTOKEN_PRECISION_EPSILON = 0.000_001

export function createMemoryTokenBucket(options: {
	clock: Clock
	capacity?: number
	refillRate?: number
}) {
	const {clock, capacity, refillRate} = options
	const buckets = new Map<string, TokenBucketState>()
	const initializedAt = readRateLimitClock(clock, 'token-bucket initialization')
	let nextCleanupAt = safeRateLimitDeadline(
		initializedAt, CLEANUP_INTERVAL_MS, 'token-bucket cleanup'
	)
	let nextCapacityCleanupAt = initializedAt

	function refillTokens(state: TokenBucketState, now: number, limit: number, windowMs: number): TokenBucketState {
		const cap = capacity ?? limit
		const rate = refillRate ?? (limit / windowMs)
		const elapsed = Math.max(0, now - state.lastRefill)
		const capMicrotokens = Math.round(cap * MICROTOKENS_PER_TOKEN)
		const cappedElapsed = Math.min(elapsed, cap / rate)
		// Multiply elapsed time before converting to microtokens. This preserves
		// slow rates (for example one token/hour) that otherwise lose a
		// fractional microtoken through intermediate floating-point rounding.
		const added = rate * cappedElapsed * MICROTOKENS_PER_TOKEN
		const safeAdded = Number.isFinite(added) ? added : capMicrotokens
		const total = state.tokens + state.fractionalRemainder + safeAdded
		const clamped = Math.min(capMicrotokens, Math.max(0, total))
		return {
			tokens: Math.floor(clamped),
			fractionalRemainder: clamped - Math.floor(clamped),
			lastRefill: Math.max(state.lastRefill, now),
			cleanupAt: state.cleanupAt
		}
	}

	function maybeCleanup(now: number, requestedKey: string): void {
		const capacityCleanup = !buckets.has(requestedKey)
		&& buckets.size >= MAX_KEYS_THRESHOLD
		&& now >= nextCapacityCleanupAt
		if (now < nextCleanupAt && !capacityCleanup) return
		for (const [key, state] of buckets) {
			if (state.cleanupAt <= now) buckets.delete(key)
		}
		nextCleanupAt = safeRateLimitDeadline(now, CLEANUP_INTERVAL_MS, 'token-bucket cleanup')
		nextCapacityCleanupAt = safeRateLimitDeadline(now, CAPACITY_CLEANUP_RETRY_MS, 'token-bucket capacity cleanup')
	}

	function createInitialState(now: number, limit: number, windowMs: number): TokenBucketState {
		const cap = capacity ?? limit
		return {
			tokens: Math.round(cap * MICROTOKENS_PER_TOKEN),
			fractionalRemainder: 0,
			lastRefill: now,
			cleanupAt: safeRateLimitDeadline(now, windowMs, 'token-bucket initial cleanup')
		}
	}

	function toDecision(state: TokenBucketState, now: number, limit: number, windowMs: number, cost: number): RateLimitEngineResult {
		const cap = capacity ?? limit
		const rate = refillRate ?? (limit / windowMs)
		const available = state.tokens + state.fractionalRemainder
		const availableTokens = available / MICROTOKENS_PER_TOKEN
		// Public/Redis decisions expose whole-token remaining values. Floor the
		// policy bound as well as availability so a fractional limit combined with
		// a larger burst capacity cannot leak a fractional or rounded-up value.
		const remaining = Math.min(Math.floor(limit), Math.max(0, Math.floor(availableTokens)))
		const precisionEpsilonTokens = MICROTOKEN_PRECISION_EPSILON / MICROTOKENS_PER_TOKEN
		// Deadlines must use the same precision boundary as admission. Otherwise a
		// bucket can be admissible at the reported deadline minus one millisecond.
		const tokensNeeded = Math.max(0, Math.min(limit, cap) - availableTokens - precisionEpsilonTokens)
		const admissionTokensNeeded = Math.max(0, cost - availableTokens - precisionEpsilonTokens)
		const deadlineBase = Math.max(now, state.lastRefill)
		const allowed = available + MICROTOKEN_PRECISION_EPSILON >= Math.round(cost * MICROTOKENS_PER_TOKEN)
		return {
			allowed,
			remaining,
			resetAt: safeRateLimitDeadline(deadlineBase, Math.max(0, Math.ceil(tokensNeeded / rate)), 'token-bucket reset'),
			...(!allowed ? {
				retryAt: safeRateLimitDeadline(deadlineBase, Math.ceil(admissionTokensNeeded / rate), 'token-bucket retry')
			} : {})
		}
	}

	async function checkAndConsume(key: string, limit: number, windowMs: number, cost: number): Promise<RateLimitEngineResult> {
		const now = readRateLimitClock(clock, 'token-bucket consume')
		maybeCleanup(now, key)
		let state = buckets.get(key)
		assertMemoryKeyCapacity(buckets, key, 'Token-bucket')
		if (!state) {
			state = createInitialState(now, limit, windowMs)
		}
		state = refillTokens(state, now, limit, windowMs)
		const decision = toDecision(state, now, limit, windowMs, cost)
		if (decision.allowed) {
			const remaining = Math.max(0, state.tokens + state.fractionalRemainder - Math.round(cost * MICROTOKENS_PER_TOKEN))
			state.tokens = Math.floor(remaining)
			state.fractionalRemainder = remaining - state.tokens
		}
		const cap = capacity ?? limit
		const rate = refillRate ?? (limit / windowMs)
		const tokens = (state.tokens + state.fractionalRemainder) / MICROTOKENS_PER_TOKEN
		const refillDelay = Math.ceil(Math.max(0, cap - tokens) / rate)
		state.cleanupAt = safeRateLimitDeadline(
			safeRateLimitDeadline(Math.max(now, state.lastRefill), refillDelay, 'token-bucket refill'),
			windowMs, 'token-bucket cleanup'
		)
		buckets.set(key, state)
		return decision.allowed ? toDecision(state, now, limit, windowMs, 0) : decision
	}

	async function peek(key: string, limit: number, windowMs: number, cost: number): Promise<RateLimitEngineResult> {
		const now = readRateLimitClock(clock, 'token-bucket peek')
		const state = refillTokens(buckets.get(key) ?? createInitialState(now, limit, windowMs), now, limit, windowMs)
		return toDecision(state, now, limit, windowMs, cost)
	}

	return {checkAndConsume, peek}
}
