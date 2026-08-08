import type {Clock} from '@ooopsstudio/core/contracts/clock'

import type {RateLimitEngine, RateLimitEngineResult} from '../../types/engine'
import {readRateLimitClock, safeRateLimitDeadline, snapshotRateLimitClock} from '../time'

import {
	CAPACITY_CLEANUP_RETRY_MS,
	CLEANUP_INTERVAL_MS,
	MAX_KEYS_THRESHOLD,
	assertFixedWindowQuantity,
	assertMemoryKeyCapacity,
	assertNonNegativeFiniteCost,
	assertPositiveFiniteCost,
	assertPositiveFiniteRateLimitParameters
} from './constants'

interface WindowState {count: number; start: number; windowMs: number}

/** Aligned fixed-window engine used by memory-only preset paths. */
export function createMemoryFixedWindowEngine(sourceClock: Clock): RateLimitEngine {
	const clock = snapshotRateLimitClock(sourceClock, 'fixed-window')
	const windows = new Map<string, WindowState>()
	const initializedAt = readRateLimitClock(clock, 'fixed-window initialization')
	let nextCleanupAt = safeRateLimitDeadline(initializedAt, CLEANUP_INTERVAL_MS, 'fixed-window cleanup')
	let nextCapacityCleanupAt = initializedAt
	const cleanup = (now: number, key: string): void => {
		const atCapacity = !windows.has(key) && windows.size >= MAX_KEYS_THRESHOLD && now >= nextCapacityCleanupAt
		if (now < nextCleanupAt && !atCapacity) return
		for (const [candidate, state] of windows) if (state.start + state.windowMs <= now) windows.delete(candidate)
		nextCleanupAt = safeRateLimitDeadline(now, CLEANUP_INTERVAL_MS, 'fixed-window cleanup')
		nextCapacityCleanupAt = safeRateLimitDeadline(now, CAPACITY_CLEANUP_RETRY_MS, 'fixed-window capacity cleanup')
	}
	const resolveWindowStart = (current: WindowState | undefined, now: number, windowMs: number): number => {
		if (current && now < current.start + current.windowMs) return current.start
		return Math.floor(now / windowMs) * windowMs
	}
	const evaluate = (key: string, limit: number, windowMs: number, cost: number, consume: boolean): RateLimitEngineResult => {
		assertPositiveFiniteRateLimitParameters(limit, windowMs)
		assertFixedWindowQuantity(limit, 'Fixed-window limit')
		if (consume) assertPositiveFiniteCost(cost)
		else assertNonNegativeFiniteCost(cost)
		assertFixedWindowQuantity(cost, 'Fixed-window cost', !consume)
		const now = readRateLimitClock(clock, 'fixed-window evaluation')
		if (consume) cleanup(now, key)
		const current = windows.get(key)
		const start = resolveWindowStart(current, now, windowMs)
		const count = current?.start === start ? current.count : 0
		const allowed = count + cost <= limit
		const next = consume && allowed ? count + cost : count
		const resetAt = safeRateLimitDeadline(start, windowMs, 'fixed-window reset')
		if (consume) {
			assertMemoryKeyCapacity(windows, key, 'Fixed-window')
			windows.set(key, {count: next, start, windowMs})
		}
		return {
			allowed,
			remaining: Math.max(0, limit - next),
			resetAt
		}
	}
	return {
		type: 'memory',
		checkAndConsume: async(key, limit, windowMs, cost = 1) => evaluate(key, limit, windowMs, cost, true),
		peek: async(key, limit, windowMs, cost = 1) => evaluate(key, limit, windowMs, cost, false)
	}
}
