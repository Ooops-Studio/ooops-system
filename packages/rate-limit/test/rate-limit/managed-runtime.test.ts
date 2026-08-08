import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {MAX_SAFE_MICROTOKEN_AMOUNT} from '../../src/rate-limit/constants'
import {MAX_KEYS_THRESHOLD} from '../../src/rate-limit/core/engines/constants'
import {createCustomRateLimit} from '../../src/rate-limit/public/custom'
import {createDevelopmentRateLimit} from '../../src/rate-limit/public/development'
import {createProductionRateLimit} from '../../src/rate-limit/public/production'
import type {RateLimitRedisPort} from '../../src/rate-limit/public/types'

const keyed = (overrides: Record<string, unknown> = {}) => ({
	name: 'api.user', partition: 'keyed' as const, limit: 2, windowMs: 1_000, ...overrides
})

function redisWith(evaluate: RateLimitRedisPort['eval']): RateLimitRedisPort {
	return {eval: evaluate} as RateLimitRedisPort
}

describe('simplified managed rate limit', () => {
	it('uses immutable named bootstrap policies and returns frozen decisions', async() => {
		const clock = createFixedClock(1_000)
		const policy = keyed()
		const policies = [policy]
		const runtime = createDevelopmentRateLimit({clock, policies})
		policy.limit = 500
		policies.push(keyed({name: 'late'}))

		const first = await runtime.check({policy: 'api.user', key: 'user-1'})
		const second = await runtime.check({policy: 'api.user', key: 'user-1'})
		const blocked = await runtime.check({policy: 'api.user', key: 'user-1'})
		expect(first).toMatchObject({allowed: true, policy: 'api.user', limit: 2, remaining: 1})
		expect(second).toMatchObject({allowed: true, remaining: 0})
		expect(blocked).toMatchObject({allowed: false, reason: 'limit_exceeded'})
		expect(Object.isFrozen(blocked)).toBe(true)
		expect(Object.isFrozen(runtime.getStatus())).toBe(true)
		await expect(runtime.check({policy: 'late', key: 'user-1'})).rejects.toThrow('Unknown')
	})

	it('supports global, token-bucket, integer cost and shadow policies', async() => {
		const clock = createFixedClock(0)
		const runtime = createCustomRateLimit({
			clock,
			policies: [
				{name: 'global', partition: 'global', limit: 1, windowMs: 1_000},
				{name: 'burst', partition: 'keyed', algorithm: 'token-bucket', limit: 2, capacity: 3, windowMs: 1_000, maxCost: 2},
				{name: 'shadow', partition: 'keyed', limit: 1, windowMs: 1_000, mode: 'shadow'}
			]
		})
		expect((await runtime.check({policy: 'global'})).allowed).toBe(true)
		await expect(runtime.check({policy: 'global', key: 'forbidden'})).rejects.toThrow('does not accept')
		expect(await runtime.check({policy: 'burst', key: 'a', cost: 2})).toMatchObject({allowed: true, remaining: 1})
		expect(await runtime.check({policy: 'burst', key: 'a', cost: 2})).toMatchObject({allowed: false})
		await runtime.check({policy: 'shadow', key: 'a'})
		expect(await runtime.check({policy: 'shadow', key: 'a'})).toMatchObject({allowed: true, reason: 'shadow'})
		await expect(runtime.check({policy: 'burst', key: 'a', cost: 0.5})).rejects.toThrow('cost')
	})

	it('preserves exact keyed partition identities after validation', async() => {
		const runtime = createDevelopmentRateLimit({
			clock: createFixedClock(0),
			policies: [keyed({limit: 1})]
		})
		expect(await runtime.check({policy: 'api.user', key: 'victim'})).toMatchObject({allowed: true})
		expect(await runtime.check({policy: 'api.user', key: 'victim '})).toMatchObject({allowed: true})
		await expect(runtime.check({policy: 'api.user', key: '   '})).rejects.toThrow('valid key')
	})

	it('preserves development fixed-window quota across wall-clock rollback', async() => {
		const clock = createFixedClock(100_000)
		const runtime = createDevelopmentRateLimit({
			clock,
			policies: [keyed({limit: 1})]
		})
		expect(await runtime.check({policy: 'api.user', key: 'rollback'})).toMatchObject({
			allowed: true, remaining: 0, resetAt: 101_000
		})
		clock.set(1_000)
		expect(await runtime.check({policy: 'api.user', key: 'rollback'})).toMatchObject({
			allowed: false, remaining: 0, resetAt: 101_000
		})
		clock.set(101_000)
		expect(await runtime.check({policy: 'api.user', key: 'rollback'})).toMatchObject({allowed: true})
	})

	it('does not retain development fixed-window state after an unsafe deadline', async() => {
		const initial = Number.MAX_SAFE_INTEGER - 60_000
		const clock = createFixedClock(initial)
		const runtime = createDevelopmentRateLimit({
			clock,
			policies: [keyed({limit: 1, windowMs: 2})]
		})
		clock.set(Number.MAX_SAFE_INTEGER - 1)
		await expect(runtime.check({policy: 'api.user', key: 'deadline'})).rejects.toThrow('deadline')
		clock.set(initial)
		await expect(runtime.check({policy: 'api.user', key: 'deadline'})).resolves.toMatchObject({
			allowed: true, remaining: 0
		})
	})

	it('rejects token-bucket policies that cannot preserve quota precision', () => {
		expect(() => createDevelopmentRateLimit({
			clock: createFixedClock(0),
			policies: [{
				name: 'unsafe', partition: 'keyed', algorithm: 'token-bucket',
				limit: MAX_SAFE_MICROTOKEN_AMOUNT + 1, windowMs: 1_000
			}]
		})).toThrow('numeric precision')
	})

	it('rejects token-bucket policies with unrepresentable refill durations', () => {
		expect(() => createDevelopmentRateLimit({
			clock: createFixedClock(0),
			policies: [{
				name: 'unsafe-duration', partition: 'keyed', algorithm: 'token-bucket',
				limit: 1, capacity: MAX_SAFE_MICROTOKEN_AMOUNT, windowMs: Number.MAX_SAFE_INTEGER
			}]
		})).toThrow('numeric precision')
	})

	it('runs checkMany sequentially without preview or rollback claims', async() => {
		const runtime = createDevelopmentRateLimit({
			clock: createFixedClock(0),
			policies: [keyed({name: 'first', limit: 2}), keyed({name: 'second', limit: 1})]
		})
		await runtime.check({policy: 'second', key: 'same'})
		const result = await runtime.checkMany([
			{policy: 'first', key: 'same'},
			{policy: 'second', key: 'same'},
			{policy: 'first', key: 'never-runs'}
		])
		expect(result).toMatchObject({allowed: false, blockedBy: 'second'})
		expect(result.decisions).toHaveLength(2)
		expect(Object.isFrozen(result)).toBe(true)
		expect(Object.isFrozen(result.decisions)).toBe(true)
		expect(await runtime.check({policy: 'first', key: 'same'})).toMatchObject({allowed: true, remaining: 0})
	})

	it('rejects accessors without executing them', async() => {
		const getter = vi.fn(() => 'api.user')
		const runtime = createDevelopmentRateLimit({policies: [keyed()]})
		const request = Object.defineProperty({key: 'a'}, 'policy', {enumerable: true, get: getter})
		await expect(runtime.check(request as never)).rejects.toThrow('accessor-backed')
		expect(getter).not.toHaveBeenCalled()
		const policyGetter = vi.fn(() => 'hostile')
		const policy = Object.defineProperty({partition: 'keyed', limit: 1, windowMs: 1_000}, 'name', {enumerable: true, get: policyGetter})
		expect(() => createDevelopmentRateLimit({policies: [policy as never]})).toThrow('accessor-backed')
		expect(policyGetter).not.toHaveBeenCalled()
	})

	it('rejects proxy-backed public inputs without invoking their traps', async() => {
		const requestTrap = vi.fn(() => Object.prototype)
		const optionTrap = vi.fn(() => Object.prototype)
		const policyTrap = vi.fn(() => Object.prototype)
		const policyArrayTrap = vi.fn(() => undefined)
		const batchArrayTrap = vi.fn(() => undefined)
		const clockTrap = vi.fn(() => Object.prototype)
		const redisTrap = vi.fn(() => Object.prototype)
		const lifecycleTrap = vi.fn(() => Object.prototype)
		const runtime = createDevelopmentRateLimit({policies: [keyed()]})

		await expect(runtime.check(new Proxy({policy: 'api.user', key: 'a'}, {getPrototypeOf: requestTrap}) as never))
			.rejects.toThrow('plain object')
		expect(() => createDevelopmentRateLimit(new Proxy({}, {getPrototypeOf: optionTrap}) as never)).toThrow('plain object')
		expect(() => createDevelopmentRateLimit({
			policies: [new Proxy(keyed(), {getPrototypeOf: policyTrap}) as never]
		})).toThrow('plain object')
		expect(() => createDevelopmentRateLimit({
			policies: new Proxy([keyed()], {get: policyArrayTrap, getOwnPropertyDescriptor: policyArrayTrap})
		})).toThrow('policies')
		await expect(runtime.checkMany(new Proxy([
			{policy: 'api.user', key: 'a'}
		], {get: batchArrayTrap, getOwnPropertyDescriptor: batchArrayTrap}))).rejects.toThrow('array')
		expect(() => createDevelopmentRateLimit({
			clock: new Proxy(createFixedClock(0), {getPrototypeOf: clockTrap}), policies: [keyed()]
		})).toThrow('clock')
		expect(() => createProductionRateLimit({
			redis: new Proxy(redisWith(async() => undefined), {getPrototypeOf: redisTrap}),
			namespace: 'proxy', policies: [keyed()], onBackendError: 'block'
		})).toThrow('Redis port')
		expect(() => createDevelopmentRateLimit({
			lifecycle: new Proxy({registerShutdownHook: vi.fn()}, {getPrototypeOf: lifecycleTrap}) as never,
			policies: [keyed()]
		})).toThrow('lifecycle')
		for (const trap of [
			requestTrap, optionTrap, policyTrap, policyArrayTrap, batchArrayTrap,
			clockTrap, redisTrap, lifecycleTrap
		]) {
			expect(trap).not.toHaveBeenCalled()
		}
		await runtime.shutdown()
	})

	it('observes and rejects an invalid asynchronous lifecycle disposer', async() => {
		const rejected = Promise.reject(new Error('invalid disposer'))
		try {
			expect(() => createDevelopmentRateLimit({
				policies: [keyed()],
				lifecycle: {registerShutdownHook: () => rejected} as never
			})).toThrow('disposer function')
		} finally {
			await rejected.catch(() => undefined)
		}
	})

	it('ignores synchronous lifecycle hook re-entry during registration', async() => {
		let registeredHook!: () => Promise<void>
		const disposer = vi.fn()
		const runtime = createDevelopmentRateLimit({
			policies: [keyed()],
			lifecycle: {
				registerShutdownHook: vi.fn((_group, hook) => {
					registeredHook = hook
					void hook()
					return disposer
				})
			} as never
		})
		await Promise.resolve()
		expect(runtime.getStatus().state).toBe('running')
		await registeredHook()
		expect(runtime.getStatus().state).toBe('closed')
		expect(disposer).toHaveBeenCalledOnce()
	})

	it('contains a rejected Promise returned by lifecycle disposal', async() => {
		const rejected = Promise.reject(new Error('dispose failed'))
		const runtime = createDevelopmentRateLimit({
			policies: [keyed()],
			lifecycle: {registerShutdownHook: () => (() => rejected)} as never
		})
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		await rejected.catch(() => undefined)
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('bounds Redis hangs, retains physical ownership, and retries shutdown', async() => {
		let resolveEval!: (value: unknown) => void
		const pending = new Promise<unknown>((resolve) => { resolveEval = resolve })
		const runtime = createProductionRateLimit({
			redis: redisWith(async() => await pending),
			namespace: 'test',
			policies: [keyed()],
			onBackendError: 'block',
			operationTimeoutMs: 5,
			shutdownTimeoutMs: 5,
			clock: createFixedClock(1_000)
		})
		await expect(runtime.check({policy: 'api.user', key: 'a'})).resolves.toMatchObject({
			allowed: false, reason: 'backend_unavailable'
		})
		expect(runtime.getStatus()).toMatchObject({state: 'running', backendState: 'unhealthy', activeOperations: 1})
		await expect(runtime.shutdown()).rejects.toThrow('timed out')
		expect(runtime.getStatus()).toMatchObject({state: 'draining', activeOperations: 1, lastFailureCode: 'RATE_LIMIT_SHUTDOWN_FAILURE'})
		await expect(runtime.check({policy: 'api.user', key: 'b'})).rejects.toThrow('DRAINING')
		resolveEval(JSON.stringify({allowed: true, remaining: 1, resetAt: 2_000}))
		await pending
		await runtime.shutdown()
		expect(runtime.getStatus()).toMatchObject({state: 'closed', backendState: 'closed', activeOperations: 0})
	})

	it('fails open when the bounded memory key store is exhausted', async() => {
		const runtime = createDevelopmentRateLimit({
			clock: createFixedClock(0),
			policies: [keyed({limit: 1, windowMs: 120_000})]
		})
		for (let index = 0; index < MAX_KEYS_THRESHOLD; index++) {
			await runtime.check({policy: 'api.user', key: `key:${index}`})
		}

		await expect(runtime.check({policy: 'api.user', key: 'overflow'})).resolves.toMatchObject({
			allowed: true,
			reason: 'backend_unavailable'
		})
		expect(runtime.getStatus()).toMatchObject({backendState: 'unhealthy', backendFailuresTotal: 1})
	})

	it('applies backend policy instead of throwing at pending-operation capacity', async() => {
		const never = new Promise<unknown>(() => undefined)
		const runtime = createProductionRateLimit({
			redis: redisWith(async() => await never),
			namespace: 'pending-capacity',
			policies: [keyed()],
			onBackendError: 'block',
			operationTimeoutMs: 1,
			clock: createFixedClock(1_000)
		})
		const pending = Array.from({length: 1_024}, async(_, index) =>
			await runtime.check({policy: 'api.user', key: `key:${index}`}))

		await expect(runtime.check({policy: 'api.user', key: 'overflow'})).resolves.toMatchObject({
			allowed: false,
			reason: 'backend_unavailable'
		})
		expect(runtime.getStatus()).toMatchObject({activeOperations: 1_024, backendState: 'unhealthy'})
		await Promise.all(pending)
	})

	it('reserves pending capacity before a reentrant clock can start nested Redis work', async() => {
		let runtime!: ReturnType<typeof createProductionRateLimit>
		let armed = false
		let dispatched = false
		let releaseEval!: (value: unknown) => void
		const physical = new Promise<unknown>((resolve) => { releaseEval = resolve })
		const nested: Array<Promise<unknown>> = []
		const evaluate = vi.fn(async() => await physical)
		const clock = {
			now: () => {
				if (armed && !dispatched) {
					dispatched = true
					for (let index = 0; index < 1_100; index++) {
						nested.push(runtime.check({policy: 'api.user', key: `nested:${index}`}))
					}
				}
				return 1_000
			}
		}
		runtime = createProductionRateLimit({
			redis: redisWith(evaluate),
			namespace: 'reentrant-capacity',
			policies: [keyed()],
			onBackendError: 'block',
			operationTimeoutMs: 1,
			clock
		})
		armed = true
		const outer = runtime.check({policy: 'api.user', key: 'outer'})
		await outer
		await Promise.all(nested)
		expect(evaluate).toHaveBeenCalledTimes(1_024)
		expect(runtime.getStatus().activeOperations).toBe(1_024)
		releaseEval(JSON.stringify({allowed: true, remaining: 1, resetAt: 2_000}))
		await physical
		await runtime.shutdown()
	})

	it('applies immutable fail-open and fail-closed backend policies', async() => {
		const redis = redisWith(async() => { throw new Error('secret backend text') })
		const common = {redis, namespace: 'test', policies: [keyed()], clock: createFixedClock(1_000)}
		const open = createProductionRateLimit({...common, onBackendError: 'allow'})
		const closed = createProductionRateLimit({...common, namespace: 'test-closed', onBackendError: 'block'})
		expect(await open.check({policy: 'api.user', key: 'a'})).toMatchObject({allowed: true, reason: 'backend_unavailable'})
		expect(await closed.check({policy: 'api.user', key: 'a'})).toMatchObject({allowed: false, reason: 'backend_unavailable'})
		expect(JSON.stringify(open.getStatus())).not.toContain('secret backend text')
	})

	it('keeps valid Redis decisions when the response crosses their deadline', async() => {
		const clock = createFixedClock(1_999)
		const runtime = createProductionRateLimit({
			redis: redisWith(async() => {
				clock.advanceBy(2)
				return JSON.stringify({allowed: true, remaining: 0, resetAt: 2_000})
			}),
			namespace: 'deadline-crossing',
			policies: [keyed({limit: 1})],
			onBackendError: 'block',
			clock
		})

		await expect(runtime.check({policy: 'api.user', key: 'a'})).resolves.toMatchObject({
			allowed: true,
			remaining: 0,
			resetAt: 2_000,
			reason: 'allowed'
		})
	})

	it('clamps retry delay after a valid Redis rejection arrives late', async() => {
		const clock = createFixedClock(1_999)
		const runtime = createProductionRateLimit({
			redis: redisWith(async() => {
				clock.advanceBy(2)
				return JSON.stringify({allowed: false, remaining: 0, resetAt: 2_000, retryAt: 2_000})
			}),
			namespace: 'late-rejection',
			policies: [keyed({limit: 1})],
			onBackendError: 'block',
			clock
		})

		await expect(runtime.check({policy: 'api.user', key: 'a'})).resolves.toMatchObject({
			allowed: false,
			resetAt: 2_000,
			retryAfterMs: 0,
			reason: 'limit_exceeded'
		})
	})

	it('keeps awaited operation timers referenced', async() => {
		let resolveEval!: (value: unknown) => void
		const pending = new Promise<unknown>((resolve) => { resolveEval = resolve })
		const references: boolean[] = []
		const nativeSetTimeout = globalThis.setTimeout
		const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) => {
			const timer = nativeSetTimeout(callback, delay, ...args)
			references.push(timer.hasRef())
			return timer
		}) as typeof setTimeout)
		try {
			const runtime = createProductionRateLimit({
				redis: redisWith(async() => await pending), namespace: 'referenced',
				policies: [keyed()], onBackendError: 'allow', operationTimeoutMs: 5,
				clock: createFixedClock(1_000)
			})
			await runtime.check({policy: 'api.user', key: 'a'})
			expect(references.length).toBeGreaterThan(0)
			expect(references.every(Boolean)).toBe(true)
			resolveEval(JSON.stringify({allowed: true, remaining: 1, resetAt: 2_000}))
			await pending
			await runtime.shutdown()
		} finally { timerSpy.mockRestore() }
	})
})
