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
	assertPositiveFiniteRateLimitParameters,
	createRedisKey
} from './constants'
import {assertRedisRateLimitResult, runRedisRateLimitScript, snapshotRedisScriptPort, type RedisScriptPort} from './redis-scripts'
export interface FixedWindowEngineOptions {
	redis?: RedisScriptPort | undefined
	clock: Clock
	alignToClock?: boolean | undefined
}
export function createFixedWindowEngine(opts: FixedWindowEngineOptions): RateLimitEngine {
	const {redis: configuredRedis, alignToClock = true} = opts
	const clock = snapshotRateLimitClock(opts.clock, 'fixed-window')
	const redis = configuredRedis ? snapshotRedisScriptPort(configuredRedis, 'Fixed-window') : undefined
	const windows = new Map<string, {count: number; windowStart: number; windowMs: number}>()
	const initializedAt = readRateLimitClock(clock, 'fixed-window initialization')
	let nextCleanupAt = safeRateLimitDeadline(
		initializedAt, CLEANUP_INTERVAL_MS, 'fixed-window cleanup'
	)
	let nextCapacityCleanupAt = initializedAt
	function maybeCleanup(now: number, requestedKey: string): void {
		const capacityCleanup = !windows.has(requestedKey)
		&& windows.size >= MAX_KEYS_THRESHOLD
		&& now >= nextCapacityCleanupAt
		if (now < nextCleanupAt && !capacityCleanup) return
		for (const [key, entry] of windows.entries()) {
			const windowEnd = entry.windowStart + entry.windowMs
			if (windowEnd <= now) {
				windows.delete(key)
			}
		}
		nextCleanupAt = safeRateLimitDeadline(now, CLEANUP_INTERVAL_MS, 'fixed-window cleanup')
		nextCapacityCleanupAt = safeRateLimitDeadline(now, CAPACITY_CLEANUP_RETRY_MS, 'fixed-window capacity cleanup')
	}
	function calculateWindowStart(now: number, windowMs: number): number {
		return Math.floor(now / windowMs) * windowMs
	}
	function resolveWindowStart(
		entry: {windowStart: number} | undefined,
		now: number,
		windowMs: number
	): number {
		if (!entry) {
			return alignToClock ? calculateWindowStart(now, windowMs) : now
		}
		if (now < entry.windowStart) {
			return entry.windowStart
		}
		if (!alignToClock && now < entry.windowStart + windowMs) {
			return entry.windowStart
		}
		return alignToClock ? calculateWindowStart(now, windowMs) : now
	}
	const FIXED_WINDOW_REDIS_SCRIPT = `
	local baseKey = KEYS[1]
	local now = tonumber(ARGV[1])
	local limit = tonumber(ARGV[2])
	local windowMs = tonumber(ARGV[3])
	local cost = tonumber(ARGV[4])
	local requestedWindowStart = tonumber(ARGV[5])
	local alignToClock = ARGV[6] == "1"
	local mode = ARGV[7]
	local maxSafeInteger = tonumber(ARGV[8])
	local cursorKey = baseKey .. ":cursor"
	local rawLatestWindowStart = redis.call("GET", cursorKey)
	local latestWindowStart = tonumber(rawLatestWindowStart)
	if rawLatestWindowStart and not latestWindowStart then
		error("invalid fixed-window cursor state")
	end
	if latestWindowStart and (latestWindowStart < 0 or latestWindowStart > maxSafeInteger or latestWindowStart ~= math.floor(latestWindowStart)) then
		error("invalid fixed-window cursor state")
	end
	local windowStart = alignToClock and requestedWindowStart or now
	if latestWindowStart then
		if requestedWindowStart < latestWindowStart then
			windowStart = latestWindowStart
		elseif not alignToClock and now < latestWindowStart + windowMs then
			windowStart = latestWindowStart
		end
	end
	local resetAt = windowStart + windowMs
	local ttlMs = math.max(1, resetAt - now)
	if windowStart < 0 or resetAt > maxSafeInteger or ttlMs > maxSafeInteger then
		error("unsafe fixed-window deadline")
	end
	local windowStartString = string.format("%.0f", windowStart)
	local key = baseKey .. ":" .. windowStartString
local current = tonumber(redis.call("GET", key) or "0")
if not current or current < 0 or current > maxSafeInteger or current ~= math.floor(current) then
	error("invalid fixed-window counter state")
end
local allowed = (current + cost) <= limit
local nextCount = current
	if mode == "consume" and allowed then
		nextCount = current + cost
		redis.call("SET", key, string.format("%.0f", nextCount), "PX", ttlMs)
		redis.call("SET", cursorKey, windowStartString, "PX", ttlMs)
	elseif mode == "consume" and current > 0 then
		redis.call("PEXPIRE", key, ttlMs)
		-- Keep the rollback cursor and counter TTLs aligned.
		redis.call("PEXPIRE", cursorKey, ttlMs)
	elseif mode == "consume" then
		-- Match the memory engine: the first consume attempt establishes the
		-- non-aligned window even when its cost is rejected.
		redis.call("SET", cursorKey, windowStartString, "PX", ttlMs)
end
local clampedCount = math.min(limit, math.max(0, nextCount))
local remaining = math.min(limit, math.max(0, limit - clampedCount))
-- Redis's embedded cjson uses insufficient default precision for safe-integer
-- epoch values near 2^53. Format integer fields explicitly to preserve them.
return '{"allowed":' .. tostring(allowed) ..
	',"remaining":' .. string.format("%.0f", remaining) ..
	',"resetAt":' .. string.format("%.0f", resetAt) .. '}'
`
	async function peekMemory(
		key: string,
		limit: number,
		windowMs: number,
		cost = 1
	): Promise<RateLimitEngineResult> {
		const now = readRateLimitClock(clock, 'fixed-window peek')
		const entry = windows.get(key)
		const activeWindowStart = resolveWindowStart(entry, now, windowMs)
		const rawCount =
			!entry || entry.windowStart !== activeWindowStart
				? 0
				: entry.count
		const resetAt = safeRateLimitDeadline(activeWindowStart, windowMs, 'fixed-window reset')
		const clampedCount = Math.min(limit, Math.max(0, rawCount))
		const rawRemaining = Math.max(0, limit - clampedCount)
		const remaining = Math.min(limit, rawRemaining) // Clamp to [0, limit]
		const effectiveCost = Math.max(0, cost)
		const allowed = clampedCount + effectiveCost <= limit
		return {
			allowed,
			remaining,
			resetAt
		}
	}
	async function checkAndConsumeMemory(
		key: string,
		limit: number,
		windowMs: number,
		cost: number
	): Promise<RateLimitEngineResult> {
		const now = readRateLimitClock(clock, 'fixed-window consume')
		maybeCleanup(now, key)
		let entry = windows.get(key)
		assertMemoryKeyCapacity(windows, key, 'Fixed-window')
		const activeWindowStart = resolveWindowStart(entry, now, windowMs)
		// Validate the deadline before inserting a new entry so a precision failure
		// cannot leave behind quota state from an operation that was rejected.
		const resetAt = safeRateLimitDeadline(activeWindowStart, windowMs, 'fixed-window reset')
		if (!entry || entry.windowStart !== activeWindowStart) {
			entry = {
				count: 0,
				windowStart: activeWindowStart,
				windowMs
			}
			windows.set(key, entry)
		}
		assertPositiveFiniteCost(cost)
		const nextCount = entry.count + cost
		const allowed = nextCount <= limit
		if (allowed) {
			entry.count = nextCount
		}
		entry.count = Math.min(limit, Math.max(0, entry.count))
		const clampedCount = entry.count
		const rawRemaining = Math.max(0, limit - clampedCount)
		const remaining = Math.min(limit, rawRemaining) // Clamp to [0, limit]
		if (remaining < 0 || remaining > limit) {
			throw new Error(`Fixed-window memory engine invariant violation: remaining=${remaining}, limit=${limit}`)
		}
		if (resetAt < now) {
			throw new Error(`Fixed-window memory engine invariant violation: resetAt=${resetAt} must be >= now=${now}`)
		}
		return {
			allowed,
			remaining,
			resetAt
		}
	}
	async function runRedisFixedWindowScript(
		key: string,
		limit: number,
		windowMs: number,
		cost: number,
		mode: 'consume' | 'peek'
	): Promise<RateLimitEngineResult> {
		if (!redis) {
			throw new Error('Redis port is required for Redis-backed fixed-window engine')
		}
		const now = readRateLimitClock(clock, 'fixed-window Redis evaluation')
		safeRateLimitDeadline(now, windowMs, 'fixed-window Redis reset')
		const windowStart = calculateWindowStart(now, windowMs)
		const baseKey = createRedisKey('fixed-window', key)
		const result = await runRedisRateLimitScript(
			redis,
			FIXED_WINDOW_REDIS_SCRIPT,
			[baseKey],
			[now, limit, windowMs, cost, windowStart, alignToClock ? 1 : 0, mode, Number.MAX_SAFE_INTEGER]
		)
		assertRedisRateLimitResult(result, {engineName: 'Fixed-window', limit, now})
		return result
	}
	return {
		type: redis ? 'redis' : 'memory',
		async checkAndConsume(
			key: string,
			limit: number,
			windowMs: number,
			cost = 1
		): Promise<RateLimitEngineResult> {
			assertPositiveFiniteRateLimitParameters(limit, windowMs)
			assertPositiveFiniteCost(cost)
			assertFixedWindowQuantity(limit, 'Fixed-window limit')
			assertFixedWindowQuantity(cost, 'Fixed-window cost')
			if (redis) {
				return runRedisFixedWindowScript(key, limit, windowMs, cost, 'consume')
			}
			return checkAndConsumeMemory(key, limit, windowMs, cost)
		},
		async peek(
			key: string,
			limit: number,
			windowMs: number,
			cost = 1
		): Promise<RateLimitEngineResult> {
			assertPositiveFiniteRateLimitParameters(limit, windowMs)
			assertNonNegativeFiniteCost(cost)
			assertFixedWindowQuantity(limit, 'Fixed-window limit')
			assertFixedWindowQuantity(cost, 'Fixed-window cost', true)
			if (redis) {
				return runRedisFixedWindowScript(key, limit, windowMs, cost, 'peek')
			}
			return peekMemory(key, limit, windowMs, cost)
		}
	}
}
