import type {Clock} from '@ooopsstudio/core/contracts/clock'

import type {RateLimitEngineResult} from '../../types/engine'
import {readRateLimitClock, safeRateLimitDeadline} from '../time'

import {MICROTOKENS_PER_TOKEN, createRedisKey} from './constants'
import {assertRedisRateLimitResult, runRedisRateLimitScript, type RedisScriptPort} from './redis-scripts'

const REDIS_TOKEN_BUCKET_SCRIPT = `
local stateKey = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local capacity = tonumber(ARGV[5])
local refillRate = tonumber(ARGV[6])
local microtokensPerToken = tonumber(ARGV[7])
local shouldConsume = ARGV[8] == '1'
local maxSafeInteger = tonumber(ARGV[9])
local precisionEpsilon = 0.000001
local function decode_state(raw)
  if not raw then
    local capMicro = math.floor((capacity * microtokensPerToken) + 0.5)
    return {tokens = capMicro, fractionalRemainder = 0, lastRefill = now}
  end
  return cjson.decode(raw)
end
local state = decode_state(redis.call('GET', stateKey))
local capMicro = math.floor((capacity * microtokensPerToken) + 0.5)
local decodedTokens = tonumber(state.tokens)
if not decodedTokens or decodedTokens < 0 or decodedTokens > capMicro or decodedTokens ~= math.floor(decodedTokens) then
  error('invalid token-bucket token state')
end
state.tokens = decodedTokens
local decodedLastRefill = tonumber(state.lastRefill)
if not decodedLastRefill or decodedLastRefill < 0 or decodedLastRefill > maxSafeInteger or decodedLastRefill ~= math.floor(decodedLastRefill) then
  error('invalid token-bucket refill state')
end
state.lastRefill = decodedLastRefill
local storedRemainder = state.fractionalRemainder or 0
if type(storedRemainder) ~= 'number' or storedRemainder < 0 or storedRemainder >= 1 then
  error('invalid token-bucket fractional state')
end
local elapsed = now - state.lastRefill
if elapsed < 0 then elapsed = 0 end
local maxElapsed = capacity / refillRate
if elapsed > maxElapsed then elapsed = maxElapsed end
-- Multiply elapsed time before converting to microtokens so very slow valid
-- refill rates retain enough precision to accumulate over a full window.
local total = state.tokens + storedRemainder + (refillRate * elapsed * microtokensPerToken)
if total < 0 then total = 0 end
if total > capMicro then total = capMicro end
local refreshedTokens = math.floor(total)
local refreshedRemainder = total - refreshedTokens
local costMicro = math.floor((cost * microtokensPerToken) + 0.5)
local available = refreshedTokens + refreshedRemainder
local allowed = available + precisionEpsilon >= costMicro
if shouldConsume and allowed then
  local remaining = math.max(0, available - costMicro)
  refreshedTokens = math.floor(remaining)
  refreshedRemainder = remaining - refreshedTokens
end
local tokensFloat = (refreshedTokens + refreshedRemainder) / microtokensPerToken
-- Public results use whole-token remaining values. Floor the configured limit
-- too, otherwise a fractional limit plus larger burst capacity can be rounded
-- above the policy limit by string.format below.
local remaining = math.min(math.floor(limit), math.max(0, math.floor(tokensFloat)))
local target = math.min(limit, capacity)
local deadlineBase = math.max(state.lastRefill, now)
local precisionEpsilonTokens = precisionEpsilon / microtokensPerToken
-- Use the admission precision boundary for deadlines as well, so the reported
-- time is the first millisecond at which this script can actually admit.
local resetAt = deadlineBase + math.max(0, math.ceil(math.max(0, target - tokensFloat - precisionEpsilonTokens) / refillRate))
local retryAt = deadlineBase + math.max(0, math.ceil(math.max(0, cost - tokensFloat - precisionEpsilonTokens) / refillRate))
local rollbackGap = math.max(0, deadlineBase - now)
local ttl = math.max(windowMs, rollbackGap + math.ceil(math.max(0, capacity - tokensFloat) / refillRate) + windowMs)
if resetAt > maxSafeInteger or retryAt > maxSafeInteger or ttl > maxSafeInteger then
  error('unsafe token-bucket deadline')
end
if shouldConsume then
	  -- Store the timestamp as an exact decimal string; cjson's default numeric
	  -- precision cannot preserve every JavaScript safe integer.
	  redis.call('SET', stateKey, cjson.encode({tokens = string.format("%.0f", refreshedTokens), fractionalRemainder = refreshedRemainder, lastRefill = string.format("%.0f", deadlineBase)}), 'PX', ttl)
end
local result = '{"allowed":' .. tostring(allowed) ..
	',"remaining":' .. string.format("%.0f", remaining) ..
	',"resetAt":' .. string.format("%.0f", resetAt)
if not allowed then result = result .. ',"retryAt":' .. string.format("%.0f", retryAt) end
return result .. '}'
`

export function createRedisTokenBucket(options: {
	redis: RedisScriptPort
	clock: Clock
	capacity?: number
	refillRate?: number
}) {
	const {redis, clock, capacity, refillRate} = options
	async function run(key: string, limit: number, windowMs: number, cost: number, shouldConsume: boolean): Promise<RateLimitEngineResult> {
		const cap = capacity ?? limit
		const rate = refillRate ?? (limit / windowMs)
		const now = readRateLimitClock(clock, 'token-bucket Redis evaluation')
		safeRateLimitDeadline(now, windowMs, 'token-bucket Redis window')
		const refillAt = safeRateLimitDeadline(now, Math.ceil(cap / rate), 'token-bucket Redis refill')
		safeRateLimitDeadline(refillAt, windowMs, 'token-bucket Redis expiry')
		const result = await runRedisRateLimitScript(
			redis,
			REDIS_TOKEN_BUCKET_SCRIPT,
			[createRedisKey('token-bucket', key)],
			[now, limit, windowMs, cost, cap, rate, MICROTOKENS_PER_TOKEN, shouldConsume ? 1 : 0, Number.MAX_SAFE_INTEGER]
		)
		assertRedisRateLimitResult(result, {engineName: 'Token-bucket', limit, now})
		return result
	}
	return {
		checkAndConsume: async(key: string, limit: number, windowMs: number, cost: number) => await run(key, limit, windowMs, cost, true),
		peek: async(key: string, limit: number, windowMs: number, cost: number) => await run(key, limit, windowMs, Math.max(0, cost), false)
	}
}
