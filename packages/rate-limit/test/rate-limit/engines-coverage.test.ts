import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createRedisKey, MAX_KEYS_THRESHOLD} from '../../src/rate-limit/core/engines/constants'
import {createFixedWindowEngine} from '../../src/rate-limit/core/engines/fixed-window'
import {createMemoryFixedWindowEngine} from '../../src/rate-limit/core/engines/fixed-window-memory'
import {runRedisRateLimitScript} from '../../src/rate-limit/core/engines/redis-scripts'
import {createTokenBucketEngine} from '../../src/rate-limit/core/engines/token-bucket'
import type {RateLimitRedisPort} from '../../src/rate-limit/public/types'

function redisWith(result: unknown): RateLimitRedisPort {
	return {
		ttlUnit: 'ms',
		del: vi.fn(async() => undefined),
		eval: vi.fn(async() => typeof result === 'string' ? result : JSON.stringify(result))
	}
}

describe('rate-limit engines', () => {
	it('creates Redis Cluster-safe namespaced keys', () => {
		expect(createRedisKey('fixed-window', 'rl:key', 'cursor')).toBe('rl:fixed-window:{rl:key}:cursor')
		expect(createRedisKey('fixed-window', 'rl:tenant:policy:key')).not.toBe(
			createRedisKey('fixed-window', 'tenant:policy:key')
		)
		expect(createRedisKey('fixed-window', 'raw{unsafe}')).toBe('rl:fixed-window:{raw%7Bunsafe%7D}')
		expect(createRedisKey('fixed-window', 'raw%7Bunsafe%7D')).toBe('rl:fixed-window:{raw%257Bunsafe%257D}')
		expect(createRedisKey('fixed-window', 'raw{unsafe}')).not.toBe(
			createRedisKey('fixed-window', 'raw%7Bunsafe%7D')
		)
	})

	it('runs fixed windows in memory with consume, peek, rollover, and non-aligned windows', async() => {
		const clock = createFixedClock(1_000)
		const engine = createFixedWindowEngine({clock})
		expect(await engine.peek('key', 2, 1_000)).toMatchObject({allowed: true, remaining: 2, resetAt: 2_000})
		expect(await engine.checkAndConsume('key', 2, 1_000, 2)).toMatchObject({allowed: true, remaining: 0})
		expect(await engine.checkAndConsume('key', 2, 1_000)).toMatchObject({allowed: false, remaining: 0})
		clock.advanceBy(1_000)
		expect(await engine.checkAndConsume('key', 2, 1_000)).toMatchObject({allowed: true, remaining: 1, resetAt: 3_000})
		const unaligned = createFixedWindowEngine({clock, alignToClock: false})
		expect((await unaligned.checkAndConsume('other', 1, 1_000)).resetAt).toBe(3_000)
		clock.advanceBy(100)
		expect((await unaligned.peek('other', 1, 1_000)).resetAt).toBe(3_000)
		await expect(engine.checkAndConsume('bad', 0, 1_000)).rejects.toThrow('limit')
		await expect(engine.checkAndConsume('bad', 1, 1_000, 0)).rejects.toThrow('cost')
		const cleanupClock = createFixedClock(0)
		const cleanup = createFixedWindowEngine({clock: cleanupClock})
		await cleanup.checkAndConsume('stale', 1, 1_000)
		cleanupClock.advanceBy(61_000)
		await cleanup.checkAndConsume('fresh', 1, 1_000)
		let now = 1_000
		const reverseClock = {now: () => now}
		const reverse = createFixedWindowEngine({clock: reverseClock})
		await reverse.checkAndConsume('key', 1, 1_000)
		now = 500
		expect((await reverse.peek('key', 1, 1_000)).resetAt).toBe(2_000)
	})

	it('keeps development fixed-window peek free of cleanup side effects', async() => {
		const clock = createFixedClock(0)
		const engine = createMemoryFixedWindowEngine(clock)
		await engine.checkAndConsume('stale', 1, 1_000)
		clock.advanceBy(61_000)
		const iterator = vi.spyOn(Map.prototype, Symbol.iterator)
		try {
			await expect(engine.peek('fresh', 1, 1_000)).resolves.toMatchObject({
				allowed: true, remaining: 1
			})
			expect(iterator).not.toHaveBeenCalled()
		} finally { iterator.mockRestore() }
	})

	it('runs fixed windows through Redis and validates Redis capabilities', async() => {
		const clock = createFixedClock(1_000)
		const redis = redisWith({allowed: true, remaining: 1, resetAt: 2_000})
		const engine = createFixedWindowEngine({clock, redis})
		expect(await engine.checkAndConsume('key', 2, 1_000)).toMatchObject({allowed: true, remaining: 1})
		expect(redis.eval).toHaveBeenCalled()
		const redisKeys = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[]
		expect(redisKeys[0]).toMatch(/^rl:fixed-window:\{.+\}$/)
		const script = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
		expect(script).toContain('the first consume attempt establishes the')
		expect(script).toContain('redis.call("SET", cursorKey, windowStartString, "PX", ttlMs)')
		expect(script).toContain('redis.call("PEXPIRE", cursorKey, ttlMs)')
		expect(script).toContain('string.format("%.0f", resetAt)')
		expect(script).toContain('invalid fixed-window cursor state')
		expect(script).toContain('invalid fixed-window counter state')
		expect((redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toContain(Number.MAX_SAFE_INTEGER)
		expect(() => createFixedWindowEngine({clock, redis: {} as RateLimitRedisPort})).toThrow('eval')
		const invalid = redisWith({allowed: true, remaining: -1, resetAt: 2_000})
		await expect(createFixedWindowEngine({clock, redis: invalid}).checkAndConsume('key', 2, 1_000)).rejects.toThrow('remaining')
		const expired = redisWith({allowed: true, remaining: 1, resetAt: 0})
		await expect(createFixedWindowEngine({clock, redis: expired}).checkAndConsume('key', 2, 1_000)).rejects.toThrow('resetAt')
	})

	it('runs token buckets in memory with refill, peek, and validation', async() => {
		const clock = createFixedClock(1_000)
		const engine = createTokenBucketEngine({clock, capacity: 2, refillRate: 0.001})
		expect(await engine.checkAndConsume('key', 2, 1_000, 2)).toMatchObject({allowed: true, remaining: 0})
		expect(await engine.checkAndConsume('key', 2, 1_000)).toMatchObject({allowed: false, remaining: 0})
		clock.advanceBy(1_000)
		expect(await engine.peek('key', 2, 1_000, 1)).toMatchObject({allowed: true, remaining: 1})
		expect(await engine.checkAndConsume('key', 2, 1_000)).toMatchObject({allowed: true, remaining: 0})
		expect(() => createTokenBucketEngine({clock, capacity: 0})).toThrow('capacity')
		expect(() => createTokenBucketEngine({clock, capacity: 0.0000001})).toThrow('one microtoken')
		expect(() => createTokenBucketEngine({clock, capacity: 0.0000014})).toThrow('six decimal places')
		expect(() => createTokenBucketEngine({clock, refillRate: 0})).toThrow('refillRate')
		expect(() => createTokenBucketEngine({clock, capacity: 1, refillRate: Number.MIN_VALUE})).toThrow('refill duration')
		await expect(engine.peek('key', 2, 1_000, -1)).rejects.toThrow('cost')
		await expect(engine.checkAndConsume('tiny', 2, 1_000, 0.0000001)).rejects.toThrow('one microtoken')
		await expect(engine.checkAndConsume('rounded', 2, 1_000, 0.0000014)).rejects.toThrow('six decimal places')
	})

	it('allows slow token-bucket refill rates to accumulate fractional microtokens', async() => {
		const clock = createFixedClock(0)
		const engine = createTokenBucketEngine({clock, capacity: 1, refillRate: 1 / 3_600_000})
		expect(await engine.checkAndConsume('slow', 1, 3_600_000)).toMatchObject({allowed: true, remaining: 0, resetAt: 3_600_000})
		clock.advanceBy(3_600_000)
		expect(await engine.checkAndConsume('slow', 1, 3_600_000)).toMatchObject({allowed: true, remaining: 0, resetAt: 7_200_000})
	})

	it('preserves token-bucket reset and state across wall-clock rollback', async() => {
		const clock = createFixedClock(100_000)
		const engine = createTokenBucketEngine({clock, capacity: 1, refillRate: 0.001})
		expect(await engine.checkAndConsume('rollback', 1, 1_000)).toMatchObject({allowed: true, remaining: 0})
		clock.set(0)
		expect(await engine.peek('rollback', 1, 1_000)).toMatchObject({allowed: false, resetAt: 101_000})
		expect(await engine.checkAndConsume('rollback', 1, 1_000)).toMatchObject({allowed: false, resetAt: 101_000})
		clock.set(60_000)
		await engine.checkAndConsume('cleanup-trigger', 1, 1_000)
		expect(await engine.checkAndConsume('rollback', 1, 1_000)).toMatchObject({allowed: false, resetAt: 101_000})
		clock.set(101_000)
		expect(await engine.checkAndConsume('rollback', 1, 1_000)).toMatchObject({allowed: true})
	})

	it('preserves fixed-window state across wall-clock rollback while the window is retained', async() => {
		const clock = createFixedClock(100_000)
		const aligned = createFixedWindowEngine({clock})
		expect(await aligned.checkAndConsume('rollback', 1, 1_000)).toMatchObject({allowed: true, resetAt: 101_000})
		clock.set(1_000)
		expect(await aligned.peek('rollback', 1, 1_000)).toMatchObject({allowed: false, resetAt: 101_000})
		expect(await aligned.checkAndConsume('rollback', 1, 1_000)).toMatchObject({allowed: false, resetAt: 101_000})
		clock.set(101_000)
		expect(await aligned.checkAndConsume('rollback', 1, 1_000)).toMatchObject({allowed: true})
	})

	it('does not let short-window cleanup erase active state owned by longer-window rules', async() => {
		const fixedClock = createFixedClock(0)
		const fixed = createFixedWindowEngine({clock: fixedClock})
		await fixed.checkAndConsume('long', 1, 120_000)
		fixedClock.advanceBy(61_000)
		await fixed.checkAndConsume('short', 1, 1_000)
		expect(await fixed.checkAndConsume('long', 1, 120_000)).toMatchObject({allowed: false, remaining: 0})

		const bucketClock = createFixedClock(0)
		const bucket = createTokenBucketEngine({clock: bucketClock})
		await bucket.checkAndConsume('long', 1, 120_000)
		bucketClock.advanceBy(61_000)
		await bucket.checkAndConsume('short', 1, 1_000)
		expect(await bucket.checkAndConsume('long', 1, 120_000)).toMatchObject({allowed: false, remaining: 0})
	})

	it('bounds active memory keys without evicting existing quotas', async() => {
		const clock = createFixedClock(0)
		const fixed = createFixedWindowEngine({clock})
		for (let index = 0; index < MAX_KEYS_THRESHOLD; index++) {
			await fixed.checkAndConsume(`fixed:${index}`, 1, 120_000)
		}
		const entries = vi.spyOn(Map.prototype, 'entries')
		expect(await fixed.checkAndConsume('fixed:0', 1, 120_000)).toMatchObject({allowed: false})
		expect(entries).not.toHaveBeenCalled()
		entries.mockRestore()
		await expect(fixed.checkAndConsume('fixed:overflow', 1, 120_000)).rejects.toThrow('maximum active-key capacity')
		const overflowEntries = vi.spyOn(Map.prototype, 'entries')
		await expect(fixed.checkAndConsume('fixed:overflow-2', 1, 120_000)).rejects.toThrow('maximum active-key capacity')
		await expect(fixed.checkAndConsume('fixed:overflow-3', 1, 120_000)).rejects.toThrow('maximum active-key capacity')
		expect(overflowEntries).not.toHaveBeenCalled()
		overflowEntries.mockRestore()

		const bucket = createTokenBucketEngine({clock})
		for (let index = 0; index < MAX_KEYS_THRESHOLD; index++) {
			await bucket.checkAndConsume(`bucket:${index}`, 1, 120_000)
		}
		const iterator = vi.spyOn(Map.prototype, Symbol.iterator)
		expect(await bucket.checkAndConsume('bucket:0', 1, 120_000)).toMatchObject({allowed: false})
		expect(iterator).not.toHaveBeenCalled()
		iterator.mockRestore()
		await expect(bucket.checkAndConsume('bucket:overflow', 1, 120_000)).rejects.toThrow('maximum active-key capacity')
		const overflowIterator = vi.spyOn(Map.prototype, Symbol.iterator)
		await expect(bucket.checkAndConsume('bucket:overflow-2', 1, 120_000)).rejects.toThrow('maximum active-key capacity')
		await expect(bucket.checkAndConsume('bucket:overflow-3', 1, 120_000)).rejects.toThrow('maximum active-key capacity')
		expect(overflowIterator).not.toHaveBeenCalled()
		overflowIterator.mockRestore()
	})

	it('reclaims expired entries at the exact memory-key bound', async() => {
		const fixedClock = createFixedClock(0)
		const fixed = createFixedWindowEngine({clock: fixedClock})
		for (let index = 0; index < MAX_KEYS_THRESHOLD; index++) {
			await fixed.checkAndConsume(`fixed-expiring:${index}`, 1, 1)
		}
		fixedClock.advanceBy(1)
		await expect(fixed.checkAndConsume('fixed:new', 1, 1)).resolves.toMatchObject({allowed: true})

		const bucketClock = createFixedClock(0)
		const bucket = createTokenBucketEngine({clock: bucketClock})
		for (let index = 0; index < MAX_KEYS_THRESHOLD; index++) {
			await bucket.checkAndConsume(`bucket-expiring:${index}`, 1, 1)
		}
		bucketClock.advanceBy(2)
		await expect(bucket.checkAndConsume('bucket:new', 1, 1)).resolves.toMatchObject({allowed: true})
	})

	it('runs token buckets through Redis and rejects incomplete ports', async() => {
		const clock = createFixedClock(1_000)
		const redis = redisWith({allowed: true, remaining: 1, resetAt: 2_000})
		const engine = createTokenBucketEngine({clock, redis, capacity: 2, refillRate: 0.01})
		expect(await engine.checkAndConsume('key', 2, 1_000)).toMatchObject({allowed: true, remaining: 1})
		expect(await engine.peek('key', 2, 1_000)).toMatchObject({allowed: true})
		const script = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
		const redisKeys = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[]
		expect(redisKeys[0]).toMatch(/^rl:token-bucket:\{.+\}$/)
		expect(script).toContain('local precisionEpsilon = 0.000001')
		expect(script).toContain('local maxElapsed = capacity / refillRate')
		expect(script).toContain('local deadlineBase = math.max(state.lastRefill, now)')
		expect(script).toContain('local rollbackGap = math.max(0, deadlineBase - now)')
		expect(script).toContain('invalid token-bucket fractional state')
		expect(script).toContain('unsafe token-bucket deadline')
		expect((redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toContain(Number.MAX_SAFE_INTEGER)
		expect(() => createTokenBucketEngine({clock, redis: {} as RateLimitRedisPort})).toThrow('eval')
		expect(() => createTokenBucketEngine({clock, redis: {eval: vi.fn()} as RateLimitRedisPort})).not.toThrow()
		await expect(createTokenBucketEngine({
			clock, redis: redisWith({allowed: true, remaining: 3, resetAt: 2_000})
		}).checkAndConsume('key', 2, 1_000)).rejects.toThrow('remaining')
		await expect(createTokenBucketEngine({
			clock, redis: redisWith({allowed: true, remaining: 1, resetAt: 0})
		}).peek('key', 2, 1_000)).rejects.toThrow('resetAt')
		await expect(createTokenBucketEngine({
			clock, redis: redisWith({allowed: false, remaining: 0, resetAt: 2_000, retryAt: 1_500})
		}).peek('key', 2, 1_000)).resolves.toMatchObject({retryAt: 1_500})
		await expect(createTokenBucketEngine({
			clock, redis: redisWith({allowed: false, remaining: 0, resetAt: 2_000, retryAt: 999})
		}).peek('key', 2, 1_000)).rejects.toThrow('retryAt')
	})

	it('parses Redis script results and covers capability validation branches', async() => {
		const valid = {allowed: true, remaining: 1, resetAt: 2_000}
		await expect(runRedisRateLimitScript(redisWith(valid), 'return 1', ['key'], [1])).resolves.toEqual(valid)
		await expect(runRedisRateLimitScript(redisWith(JSON.stringify(valid)), 'return 1', ['key'], [1])).resolves.toEqual(valid)
		await expect(runRedisRateLimitScript(redisWith({allowed: true}), 'return 1', ['key'], [1])).rejects.toThrow('invalid')
		await expect(runRedisRateLimitScript({eval: vi.fn(async() => ({allowed: true, remaining: 1, resetAt: 2_000}))} as RateLimitRedisPort, 'return 1', [], [])).resolves.toMatchObject({allowed: true})
		await expect(runRedisRateLimitScript({eval: vi.fn(async() => null)} as RateLimitRedisPort, 'return 1', [], [])).rejects.toThrow('invalid')
		await expect(runRedisRateLimitScript({} as RateLimitRedisPort, 'return 1', [], [])).rejects.toThrow('eval')
		await expect(runRedisRateLimitScript(redisWith('not-json'), 'return 1', [], [])).rejects.toThrow()
		await expect(runRedisRateLimitScript(redisWith('x'.repeat(4_097)), 'return 1', [], [])).rejects.toThrow('oversized')
		await expect(runRedisRateLimitScript({
			eval: vi.fn(async() => Object.assign(new Date(), valid))
		} as never, 'return 1', [], [])).rejects.toThrow('invalid')
		await expect(runRedisRateLimitScript(redisWith({
			...valid, unexpected: 'field'
		}), 'return 1', [], [])).rejects.toThrow('invalid')
		await expect(runRedisRateLimitScript(redisWith({
			...valid, remaining: 0.5
		}), 'return 1', [], [])).rejects.toThrow('invalid')
		let getterReads = 0
		const accessorResult = Object.defineProperties({}, {
			allowed: {enumerable: true, get: () => { getterReads++; return true }},
			remaining: {enumerable: true, value: 1},
			resetAt: {enumerable: true, value: 2_000}
		})
		await expect(runRedisRateLimitScript({
			eval: vi.fn(async() => accessorResult)
		} as never, 'return 1', [], [])).rejects.toThrow('invalid')
		expect(getterReads).toBe(0)
		await expect(createFixedWindowEngine({
			clock: createFixedClock(1_000),
			redis: redisWith({allowed: true, remaining: 1, resetAt: 1_000.5})
		}).peek('key', 2, 1_000)).rejects.toThrow('invalid')

	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid engine clock output %s',
		(now) => {
			const clock = {now: () => now}
			expect(() => createFixedWindowEngine({clock})).toThrow('clock')
			expect(() => createTokenBucketEngine({clock})).toThrow('clock')
		}
	)

	it('rejects an engine clock that becomes invalid after initialization', async() => {
		let now = 1_000
		const clock = {now: () => now}
		const fixed = createFixedWindowEngine({clock})
		const bucket = createTokenBucketEngine({clock})
		now = Number.NaN
		await expect(fixed.peek('key', 1, 1_000)).rejects.toThrow('clock')
		await expect(bucket.checkAndConsume('key', 1, 1_000)).rejects.toThrow('clock')
	})

	it('rejects accessor-backed direct engine capabilities without invoking them', () => {
		const readNow = vi.fn(() => 1_000)
		const readEval = vi.fn(() => vi.fn())
		const clock = Object.defineProperty({}, 'now', {get: readNow})
		const redis = Object.defineProperty({}, 'eval', {get: readEval})
		expect(() => createFixedWindowEngine({clock: clock as never})).toThrow('clock')
		expect(() => createTokenBucketEngine({clock: clock as never})).toThrow('clock')
		expect(() => createFixedWindowEngine({clock: createFixedClock(0), redis: redis as never})).toThrow('eval')
		expect(() => createTokenBucketEngine({clock: createFixedClock(0), redis: redis as never})).toThrow('eval')
		expect(readNow).not.toHaveBeenCalled()
		expect(readEval).not.toHaveBeenCalled()
	})

	it('does not retain fixed-window state when deadline validation rejects an operation', async() => {
		const initial = Number.MAX_SAFE_INTEGER - 60_000
		let now = initial
		const engine = createFixedWindowEngine({clock: {now: () => now}, alignToClock: false})
		now = Number.MAX_SAFE_INTEGER - 1
		await expect(engine.checkAndConsume('key', 1, 2)).rejects.toThrow('deadline')
		now = initial
		await expect(engine.checkAndConsume('key', 1, 2)).resolves.toMatchObject({
			allowed: true, remaining: 0, resetAt: initial + 2
		})
	})

	it('does not retain token-bucket state when cleanup deadline validation rejects an operation', async() => {
		let now = Number.MAX_SAFE_INTEGER - 60_000
		const engine = createTokenBucketEngine({clock: {now: () => now}})
		now = Number.MAX_SAFE_INTEGER - 1_500
		await expect(engine.checkAndConsume('key', 1, 1_000)).rejects.toThrow('deadline')
		now = 0
		await expect(engine.checkAndConsume('key', 1, 1_000)).resolves.toMatchObject({
			allowed: true, remaining: 0, resetAt: 1_000
		})
	})
})
