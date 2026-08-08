import type {ResiliencePolicyDefinition} from '@ooopsstudio/core/contracts/resilience'
import {BulkheadOverflowError} from '@ooopsstudio/core/contracts/resilience'
import {describe, expect, it, vi} from 'vitest'

import {createManagedResilienceRuntime} from '../../src/resilience/core/managed-runtime'
import {createCustomResilience} from '../../src/resilience/public/custom'
import {createProductionResilience} from '../../src/resilience/public/production'

const clock = {now: () => Date.now()}
const context = {resource: 'provider.test', metadata: {host: 'test'}} as const
const breaker = {failureRatioThreshold: 0.5, failureCountThreshold: 2, timeWindowMs: 1_000, halfOpenAfterMs: 10, halfOpenMaxAttempts: 1} as const
const retry = {classifier: 'http', maxAttempts: 3, maxTotalTimeMs: 1_000, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2, jitter: 'none'} as const

function policy(overrides: Partial<ResiliencePolicyDefinition> = {}): ResiliencePolicyDefinition {
	return {name: 'test', operationKind: 'external.http', timeout: {defaultMs: 500}, retry, circuitBreaker: breaker, ...overrides}
}

describe('managed resilience runtime', () => {
	it('fails closed when breaker result accounting loses its clock', async() => {
		let calls = 0
		const runtime = createProductionResilience({
			clock: {now: () => {
				calls++
				if (calls === 2) throw new Error('clock failed')
				return 0
			}},
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 1, failureRatioThreshold: 1}
			})]
		})
		await expect(runtime.execute(
			{operation: 'clock-accounting', policy: 'test', context},
			async() => { throw new Error('provider failed') }
		)).rejects.toThrow('provider failed')

		const operation = vi.fn(async() => 'must not run')
		await expect(runtime.execute(
			{operation: 'blocked-after-clock-failure', policy: 'test', context},
			operation
		)).rejects.toMatchObject({code: 'RESILIENCE_BREAKER_OPEN'})
		expect(operation).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('rejects reentrant admission while breaker completion is being timestamped', async() => {
		let reenter = false
		let nested!: Promise<unknown>
		const nestedProvider = vi.fn(async() => 'must not run')
		let runtime!: ReturnType<typeof createProductionResilience>
		runtime = createProductionResilience({
			clock: {now: () => {
				if (reenter) {
					reenter = false
					nested = runtime.execute(
						{operation: 'nested-accounting', policy: 'test', context},
						nestedProvider
					)
				}
				return 0
			}},
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 1, failureRatioThreshold: 1}
			})]
		})

		await expect(runtime.execute(
			{operation: 'outer-accounting', policy: 'test', context},
			async() => { reenter = true; throw new Error('provider failed') }
		)).rejects.toThrow('provider failed')
		await expect(nested).rejects.toMatchObject({code: 'RESILIENCE_BREAKER_OPEN'})
		expect(nestedProvider).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('executes through an immutable named policy and returns a frozen status', async() => {
		const runtime = createProductionResilience({clock, policies: [policy()]})
		await expect(runtime.execute({operation: 'provider.read', policy: 'test', context}, async() => 'ok')).resolves.toBe('ok')
		const status = runtime.getStatus()
		expect(status).toMatchObject({state: 'running', activeOperations: 0, queuedOperations: 0})
		expect(Object.isFrozen(status)).toBe(true)
		await runtime.shutdown()
		expect(runtime.getStatus().state).toBe('closed')
		await expect(runtime.shutdown()).resolves.toBeUndefined()
	})

	it('allows a bootstrap definition to replace a built-in policy deterministically', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [{...policy({name: 'db.read', retry: false}), timeout: {defaultMs: 25, maxMs: 25}}]
		})
		await expect(runtime.execute({operation: 'override', policy: 'db.read', context}, async() => 'ok')).resolves.toBe('ok')
		await expect(runtime.execute({operation: 'override', policy: 'db.read', context, timeoutMs: 26}, async() => 'never'))
			.rejects.toMatchObject({code: 'RESILIENCE_INVALID_TIMEOUT'})
		await runtime.shutdown()
	})

	it('rejects unknown policies, unsafe metadata, and timeout expansion before admission', async() => {
		const runtime = createProductionResilience({clock, policies: [policy()]})
		await expect(runtime.execute({operation: 'x', policy: 'missing', context}, async() => 'x')).rejects.toMatchObject({code: 'RESILIENCE_UNKNOWN_POLICY'})
		await expect(runtime.execute({operation: 'x', policy: 'test', context, timeoutMs: 501}, async() => 'x')).rejects.toMatchObject({code: 'RESILIENCE_INVALID_TIMEOUT'})
		await expect(runtime.execute({operation: 'x', policy: 'test', context: {resource: 'x', metadata: {nested: {} as never}}}, async() => 'x')).rejects.toMatchObject({code: 'RESILIENCE_INVALID_REQUEST'})
		await runtime.shutdown()
	})

	it('bounds prototype inspection for hostile provider failures', async() => {
		let prototypeReads = 0
		let failure: object
		failure = new Proxy({}, {getPrototypeOf: () => { prototypeReads++; return failure }})
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})]
		})
		let caught: unknown
		try {
			await runtime.execute({operation: 'hostile-failure', policy: 'test', context}, async() => { throw failure })
		} catch(error) {
			caught = error
		}
		expect(caught).toBe(failure)
		expect(prototypeReads).toBeLessThanOrEqual(32)
		await runtime.shutdown()
	})

	it('enforces retry maxTotalTimeMs as a hard physical-attempt deadline', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({
				timeout: {defaultMs: 500},
				retry: {...retry, maxTotalTimeMs: 20},
				circuitBreaker: false
			})]
		})
		const operation = vi.fn(async(signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(new Error('physical attempt aborted')), {once: true})
		}))

		await expect(runtime.execute(
			{operation: 'retry-hard-deadline', policy: 'test', context},
			operation
		)).rejects.toMatchObject({code: 'RESILIENCE_TIMEOUT', timeoutMs: 20})
		expect(operation).toHaveBeenCalledTimes(1)
		await runtime.shutdown()
	})

	it('rejects hostile request accessors without executing them', async() => {
		const runtime = createProductionResilience({clock, policies: [policy()]})
		const getter = vi.fn(() => 'test')
		const request = Object.defineProperty({}, 'policy', {enumerable: true, get: getter})
		await expect(runtime.execute(request as never, async() => 'never')).rejects.toMatchObject({code: 'RESILIENCE_INVALID_REQUEST'})
		expect(getter).not.toHaveBeenCalled()
		let descriptorReads = 0
		const oversized = new Proxy({a: 1, b: 2, c: 3, d: 4, e: 5, f: 6}, {
			getOwnPropertyDescriptor(target, key) {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		await expect(runtime.execute(oversized as never, async() => 'never'))
			.rejects.toMatchObject({code: 'RESILIENCE_INVALID_REQUEST'})
		expect(descriptorReads).toBe(0)

		let ownKeyReads = 0
		const changingKeys = new Proxy({operation: 'safe', policy: 'test', context}, {
			ownKeys(target) {
				ownKeyReads++
				return ownKeyReads === 1
					? Reflect.ownKeys(target)
					: [...Reflect.ownKeys(target), ...Array.from({length: 10_000}, (_, index) => `extra-${index}`)]
			}
		})
		await expect(runtime.execute(changingKeys, async() => 'ok')).resolves.toBe('ok')
		expect(ownKeyReads).toBe(1)
		await runtime.shutdown()
	})

	it('does not publish an operation when request snapshotting triggers reentrant shutdown', async() => {
		const runtime = createProductionResilience({clock, policies: [policy()]})
		const operation = vi.fn(async() => 'must-not-run')
		let shutdown!: Promise<void>
		let triggered = false
		const request = new Proxy({operation: 'reentrant-admission', policy: 'test', context}, {
			getOwnPropertyDescriptor: (target, key) => {
				if (!triggered) {
					triggered = true
					shutdown = runtime.shutdown()
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		await expect(runtime.execute(request, operation)).rejects.toMatchObject({code: 'RESILIENCE_NOT_RUNNING'})
		await shutdown
		expect(operation).not.toHaveBeenCalled()
		expect(runtime.getStatus()).toMatchObject({state: 'closed', activeOperations: 0, queuedOperations: 0})
	})

	it('rejects proxied policy arrays without invoking iterator or length property reads', () => {
		const propertyRead = vi.fn()
		const policies = new Proxy([policy()], {
			get(target, key, receiver) {
				if (key === 'length' || key === 'entries' || key === Symbol.iterator) propertyRead()
				return Reflect.get(target, key, receiver)
			}
		})
		expect(() => createManagedResilienceRuntime({clock, policies})).toThrow('Invalid policies')

		expect(propertyRead).not.toHaveBeenCalled()
	})

	it('rejects shape-shifting policy proxies before reading their descriptors', () => {
		let nameReads = 0
		const configured = policy({
			name: 'external.http',
			retry: false,
			circuitBreaker: false,
			timeout: {defaultMs: 100}
		})
		const shapeShifting = new Proxy(configured, {
			getOwnPropertyDescriptor(target, key) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
				if (key !== 'name' || !descriptor || !('value' in descriptor)) return descriptor
				nameReads++
				return {...descriptor, value: nameReads === 1 ? 'external.http' : 'redirected-policy'}
			}
		})

		expect(() => createProductionResilience({clock, policies: [shapeShifting]})).toThrow('Invalid policies')
		expect(nameReads).toBe(0)
	})

	it('fails construction before a hostile policy descriptor can mutate direct-factory dependencies', () => {
		const originalNow = vi.fn(() => 10)
		const replacementNow = vi.fn(() => 99)
		const originalHook = vi.fn(() => () => undefined)
		const replacementHook = vi.fn(() => () => undefined)
		const injectedClock = {now: originalNow}
		const lifecycle = {registerShutdownHook: originalHook}
		let mutated = false
		const configuredPolicy = new Proxy(policy({retry: false, circuitBreaker: false}), {
			getOwnPropertyDescriptor(target, key) {
				if (!mutated) {
					mutated = true
					injectedClock.now = replacementNow
					lifecycle.registerShutdownHook = replacementHook
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		expect(() => createProductionResilience({clock: injectedClock, lifecycle, policies: [configuredPolicy]}))
			.toThrow('Invalid policies')
		expect(mutated).toBe(false)
		expect(originalHook).not.toHaveBeenCalled()
		expect(replacementHook).not.toHaveBeenCalled()
		expect(replacementNow).not.toHaveBeenCalled()
	})

	it('captures custom dependencies before fallback registry descriptors can replace them', async() => {
		const originalHook = vi.fn(() => () => undefined)
		const replacementHook = vi.fn(() => () => undefined)
		const lifecycle = {registerShutdownHook: originalHook}
		const strategy = {condition: () => true, handler: () => 'fallback', degradeLevel: 'PARTIAL' as const}
		const fallbacks = new Proxy({cached: [strategy]}, {
			getOwnPropertyDescriptor(target, key) {
				lifecycle.registerShutdownHook = replacementHook
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		const runtime = createCustomResilience({
			clock,
			lifecycle,
			policies: [policy({retry: false, circuitBreaker: false, fallback: 'cached'})],
			fallbacks
		})
		expect(originalHook).toHaveBeenCalledOnce()
		expect(replacementHook).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('captures custom registries without executing accessors', () => {
		const classifierGetter = vi.fn(() => () => ({retryable: false}))
		const classifiers = Object.defineProperty({}, 'hostile', {enumerable: true, get: classifierGetter})
		expect(() => createCustomResilience({clock, policies: [policy({retry: {...retry, classifier: 'hostile'}})], classifiers: classifiers as never})).toThrow('invalid classifiers')
		expect(classifierGetter).not.toHaveBeenCalled()

		const strategyGetter = vi.fn(() => () => true)
		const strategy = Object.defineProperty({handler: () => 'fallback', degradeLevel: 'PARTIAL'}, 'condition', {enumerable: true, get: strategyGetter})
		expect(() => createCustomResilience({clock, policies: [policy({fallback: 'hostile'})], fallbacks: {hostile: [strategy as never]}})).toThrow('invalid')
		expect(strategyGetter).not.toHaveBeenCalled()
	})

	it('bounds hostile prototype traversal while capturing injected capabilities', () => {
		let prototypeReads = 0
		const handler: ProxyHandler<object> = {
			getOwnPropertyDescriptor: () => undefined,
			getPrototypeOf: () => { prototypeReads++; return new Proxy({}, handler) }
		}
		expect(() => createProductionResilience({clock: new Proxy({}, handler) as never, policies: [policy()]})).toThrow(/clock\.now/)
		expect(prototypeReads).toBeLessThanOrEqual(33)
	})

	it('fails construction when lifecycle registration cannot be disposed', () => {
		expect(() => createProductionResilience({
			clock,
			policies: [policy()],
			lifecycle: {registerShutdownHook: () => 'invalid-disposer'} as never
		})).toThrow(/invalid lifecycle disposer/)
	})

	it('does not publish a runtime shut down reentrantly during lifecycle registration', async() => {
		let shutdownAttempt: Promise<void> | undefined
		const dispose = vi.fn()
		const lifecycle = {
			registerShutdownHook: (_group: string, hook: () => Promise<void>) => {
				shutdownAttempt = hook()
				return dispose
			}
		}

		expect(() => createProductionResilience({
			clock,
			policies: [policy()],
			lifecycle: lifecycle as never
		})).toThrow(/lifecycle shutdown during bootstrap/u)
		expect(shutdownAttempt).toBeDefined()
		await expect(shutdownAttempt).resolves.toBeUndefined()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('rejects explicitly malformed critical bootstrap dependencies', () => {
		expect(() => createProductionResilience({
			clock: null as never,
			policies: [policy()]
		})).toThrow(/clock\.now/u)
		expect(() => createProductionResilience({
			clock,
			policies: [policy()],
			lifecycle: {} as never
		})).toThrow(/Invalid port/u)
		expect(() => createProductionResilience({
			clock,
			policies: [policy()],
			logger: {} as never
		})).toThrow(/Invalid port/u)
		expect(() => createProductionResilience({
			clock,
			policies: [policy()],
			errors: {} as never
		})).toThrow(/Invalid port/u)
		expect(() => createProductionResilience({
			clock,
			policies: [policy()],
			tracer: {} as never
		})).toThrow(/Invalid port/u)
		expect(() => createProductionResilience({
			clock,
			policies: [policy()],
			metrics: {},
			performance: {}
		})).not.toThrow()
		expect(() => createCustomResilience({
			clock,
			policies: [policy()],
			classifiers: null as never
		})).toThrow(/invalid classifiers/u)
		expect(() => createCustomResilience({
			clock,
			policies: [policy()],
			fallbacks: null as never
		})).toThrow(/fallback registry cannot be inspected safely/u)
	})

	it('coalesces physical work and gives followers isolated frozen projections', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({coalescing: {maxKeys: 10, ttlMs: 1_000}})]})
		let resolve!: (value: {nested: {value: number}}) => void
		const operation = vi.fn(async() => await new Promise<{nested: {value: number}}>((done) => { resolve = done }))
		const request = {operation: 'coalesced', policy: 'test', context, coalescingKey: 'same'} as const
		const first = runtime.execute(request, operation)
		const second = runtime.execute(request, operation)
		await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1))
		resolve({nested: {value: 1}})
		const [a, b] = await Promise.all([first, second])
		expect(a).not.toBe(b)
		expect(Object.isFrozen(a)).toBe(true)
		expect(Object.isFrozen(a.nested)).toBe(true)
		await runtime.shutdown()
	})

	it('never coalesces different operations that reuse the same caller key', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({coalescing: {maxKeys: 10, ttlMs: 1_000}})]})
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const firstCallback = vi.fn(async() => { await gate; return {operation: 'first'} })
		const secondCallback = vi.fn(async() => ({operation: 'second'}))
		const common = {policy: 'test', context, coalescingKey: 'reused'} as const
		const first = runtime.execute({...common, operation: 'provider.first'}, firstCallback)
		await vi.waitFor(() => expect(firstCallback).toHaveBeenCalledTimes(1))
		const second = runtime.execute({...common, operation: 'provider.second'}, secondCallback)

		await expect(second).resolves.toEqual({operation: 'second'})
		expect(secondCallback).toHaveBeenCalledTimes(1)
		release()
		await expect(first).resolves.toEqual({operation: 'first'})
		await runtime.shutdown()
	})

	it('rejects hostile or oversized coalesced results without invoking accessors or recursing', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({coalescing: {maxKeys: 10, ttlMs: 1_000}})]})
		const request = {operation: 'coalesced', policy: 'test', context, coalescingKey: 'unsafe'} as const
		const getter = vi.fn(() => 'secret')
		const hostile = Object.defineProperty({}, 'value', {enumerable: true, get: getter})
		await expect(runtime.execute(request, async() => hostile)).rejects.toMatchObject({code: 'RESILIENCE_COALESCED_RESULT_UNSAFE'})
		expect(getter).not.toHaveBeenCalled()

		let deep: Record<string, unknown> = {}
		for (let index = 0; index < 100; index++) deep = {nested: deep}
		await expect(runtime.execute({...request, coalescingKey: 'deep'}, async() => deep)).rejects.toMatchObject({code: 'RESILIENCE_COALESCED_RESULT_UNSAFE'})
		const shared = {value: 1}
		let aliasTail: Record<string, unknown> = {alias: shared}
		for (let index = 0; index < 31; index++) aliasTail = {nested: aliasTail}
		await expect(runtime.execute(
			{...request, coalescingKey: 'deep-alias'},
			async() => ({shared, deep: aliasTail})
		)).rejects.toMatchObject({code: 'RESILIENCE_COALESCED_RESULT_UNSAFE'})
		await expect(runtime.execute({...request, coalescingKey: 'large'}, async() => ({value: 'x'.repeat(1_048_577)}))).rejects.toMatchObject({code: 'RESILIENCE_COALESCED_RESULT_UNSAFE'})
		await expect(runtime.execute({...request, coalescingKey: 'capability'}, async() => () => 'shared capability')).rejects.toMatchObject({code: 'RESILIENCE_COALESCED_RESULT_UNSAFE'})
		const amplifiedArrays = Array.from({length: 101}, () => new Array(100))
		await expect(runtime.execute({...request, coalescingKey: 'aggregate-slots'}, async() => amplifiedArrays))
			.rejects.toMatchObject({code: 'RESILIENCE_COALESCED_RESULT_UNSAFE'})
		const oversized = Object.fromEntries(
			Array.from({length: 10_001}, (_, index) => [`field-${index}`, index])
		)
		let descriptorReads = 0
		const oversizedProxy = new Proxy(oversized, {
			getOwnPropertyDescriptor(target, key) {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		await expect(runtime.execute(
			{...request, coalescingKey: 'oversized-container'},
			async() => oversizedProxy
		)).rejects.toMatchObject({code: 'RESILIENCE_COALESCED_RESULT_UNSAFE'})
		expect(descriptorReads).toBe(0)
		let ownKeyReads = 0
		const changingKeys = new Proxy({safe: 1}, {
			ownKeys() {
				ownKeyReads++
				return ownKeyReads === 1
					? ['safe']
					: ['safe', ...Array.from({length: 10_001}, (_, index) => `amplified-${index}`)]
			}
		})
		await expect(runtime.execute(
			{...request, coalescingKey: 'changing-own-keys'},
			async() => changingKeys
		)).resolves.toEqual({safe: 1})
		expect(ownKeyReads).toBe(1)
		await runtime.shutdown()
	})

	it('preserves bounded cycles while isolating and freezing coalesced projections', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({coalescing: {maxKeys: 10, ttlMs: 1_000}})]})
		const cyclic: {self?: unknown} = {}
		cyclic.self = cyclic
		const result = await runtime.execute({operation: 'cycle', policy: 'test', context, coalescingKey: 'cycle'}, async() => cyclic)
		expect(result).not.toBe(cyclic)
		expect(result.self).toBe(result)
		expect(Object.isFrozen(result)).toBe(true)
		await runtime.shutdown()
	})

	it('copies __proto__ as inert coalesced data without changing the projection prototype', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({coalescing: {maxKeys: 10, ttlMs: 1_000}})]})
		const source = Object.defineProperty({}, '__proto__', {value: {polluted: true}, enumerable: true})
		const result = await runtime.execute({operation: 'prototype', policy: 'test', context, coalescingKey: 'prototype'}, async() => source) as Record<string, unknown>
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
		expect(Object.hasOwn(result, '__proto__')).toBe(true)
		expect(result.__proto__).toEqual({polluted: true})
		await runtime.shutdown()
	})

	it('isolates coalescing capacity by policy and resource partition', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({coalescing: {maxKeys: 1, ttlMs: 1_000}})]})
		let releaseA!: () => void
		let releaseB!: () => void
		const first = runtime.execute(
			{operation: 'a', policy: 'test', context: {resource: 'provider.a'}, coalescingKey: 'key'},
			async() => await new Promise<string>((resolve) => { releaseA = () => resolve('a') })
		)
		const second = runtime.execute(
			{operation: 'b', policy: 'test', context: {resource: 'provider.b'}, coalescingKey: 'key'},
			async() => await new Promise<string>((resolve) => { releaseB = () => resolve('b') })
		)
		await vi.waitFor(() => {
			expect(typeof releaseA).toBe('function')
			expect(typeof releaseB).toBe('function')
		})
		releaseA(); releaseB()
		await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b'])
		await runtime.shutdown()
	})

	it('rechecks per-partition coalescing capacity after a reentrant claim clock', async() => {
		let reads = 0
		let reentered = false
		let nested: Promise<string> | undefined
		let runtime!: ReturnType<typeof createProductionResilience>
		let releaseNested!: () => void
		const reentrantClock = {now: () => {
			if (++reads === 2 && !reentered) {
				reentered = true
				nested = runtime.execute(
					{operation: 'nested-claim', policy: 'test', context, coalescingKey: 'nested'},
					async() => await new Promise<string>((resolve) => { releaseNested = () => resolve('nested') })
				)
			}
			return 100
		}}
		runtime = createProductionResilience({
			clock: reentrantClock,
			policies: [policy({retry: false, circuitBreaker: false, coalescing: {maxKeys: 1, ttlMs: 1_000}})]
		})
		const outerProvider = vi.fn(async() => 'must-not-run')
		await expect(runtime.execute(
			{operation: 'outer-claim', policy: 'test', context, coalescingKey: 'outer'},
			outerProvider
		)).rejects.toMatchObject({code: 'RESILIENCE_COALESCING_CAPACITY'})
		expect(outerProvider).not.toHaveBeenCalled()
		await vi.waitFor(() => expect(typeof releaseNested).toBe('function'))
		releaseNested()
		await expect(nested).resolves.toBe('nested')
		await runtime.shutdown()
	})

	it('never shares coalesced results or breaker state across tenant identities', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, coalescing: {maxKeys: 10, ttlMs: 1_000}, circuitBreaker: {...breaker, failureCountThreshold: 1}})]
		})
		const tenantA = {resource: 'provider.shared', tenantId: 'tenant-a'} as const
		const tenantB = {resource: 'provider.shared', tenantId: 'tenant-b'} as const
		let releaseA!: () => void
		const first = runtime.execute(
			{operation: 'tenant-a', policy: 'test', context: tenantA, coalescingKey: 'same'},
			async() => await new Promise<string>((resolve) => { releaseA = () => resolve('a') })
		)
		await vi.waitFor(() => expect(typeof releaseA).toBe('function'))
		await expect(runtime.execute(
			{operation: 'tenant-b', policy: 'test', context: tenantB, coalescingKey: 'same'},
			async() => 'b'
		)).resolves.toBe('b')
		releaseA()
		await expect(first).resolves.toBe('a')

		await expect(runtime.execute(
			{operation: 'open-a', policy: 'test', context: tenantA},
			async() => { throw new Error('tenant-a failure') }
		)).rejects.toThrow('tenant-a failure')
		await expect(runtime.execute(
			{operation: 'healthy-b', policy: 'test', context: tenantB},
			async() => 'tenant-b healthy'
		)).resolves.toBe('tenant-b healthy')
		await runtime.shutdown()
	})

	it('bounds followers attached to one coalesced owner', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({coalescing: {maxKeys: 10, ttlMs: 1_000}})]})
		let release!: () => void
		const request = {operation: 'followers', policy: 'test', context, coalescingKey: 'same'} as const
		const owner = runtime.execute(request, async() => await new Promise<string>((resolve) => { release = () => resolve('ok') }))
		await vi.waitFor(() => expect(typeof release).toBe('function'))
		const followers = Array.from({length: 64}, () => runtime.execute(request, async() => 'must not run'))
		await vi.waitFor(() => expect(runtime.getStatus().activeOperations).toBe(65))
		await expect(runtime.execute(request, async() => 'must not run')).rejects.toMatchObject({code: 'RESILIENCE_COALESCING_CAPACITY'})
		release()
		await expect(Promise.all([owner, ...followers])).resolves.toEqual(Array.from({length: 65}, () => 'ok'))
		await runtime.shutdown()
	})

	it('rejects managed coalescing ownership cycles without waiting for timeout', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({
				timeout: {defaultMs: 2_147_483_647},
				retry: false,
				circuitBreaker: false,
				coalescing: {maxKeys: 10, ttlMs: 2_147_483_647}
			})]
		})
		const request = {
			operation: 'managed-cycle', policy: 'test', context, coalescingKey: 'same'
		} as const
		const duplicate = vi.fn(async() => 'must-not-run')

		await expect(runtime.execute(request, async() => {
			return await runtime.execute(request, duplicate)
		})).rejects.toMatchObject({code: 'RESILIENCE_CYCLE'})
		expect(duplicate).not.toHaveBeenCalled()
		await vi.waitFor(() => expect(runtime.getStatus().activeOperations).toBe(0))
		await expect(runtime.execute(request, async() => 'recovered')).resolves.toBe('recovered')

		const secondKey = {...request, coalescingKey: 'second'} as const
		await expect(runtime.execute(request, async() => {
			return await runtime.execute(secondKey, async() => {
				return await runtime.execute(request, duplicate)
			})
		})).rejects.toMatchObject({code: 'RESILIENCE_CYCLE'})
		expect(duplicate).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('reports only the final unresolved failure and not a recovered retry', async() => {
		const report = vi.fn()
		const addEvent = vi.fn()
		const runtime = createProductionResilience({
			clock,
			policies: [policy()],
			errors: {report},
			tracer: {startSpan: () => ({addEvent, setStatus: () => undefined, recordException: () => undefined, end: () => undefined})} as never
		})
		let attempts = 0
		await expect(runtime.execute({operation: 'retry', policy: 'test', context}, async() => {
			attempts++
			if (attempts === 1) throw Object.assign(new Error('temporary'), {status: 429, retryAfter: '0.001'})
			return 'ok'
		})).resolves.toBe('ok')
		expect(report).not.toHaveBeenCalled()
		expect(addEvent).toHaveBeenCalledWith('resilience.retry', {attempt: 1, delayMs: 1})
		await expect(runtime.execute({operation: 'failure', policy: 'test', context}, async() => { throw Object.assign(new Error('down'), {status: 429, retryAfter: '0.001'}) })).rejects.toMatchObject({name: 'RetryExhaustedError'})
		expect(report).toHaveBeenCalledTimes(1)
		await runtime.shutdown()
	})

	it('observes rejected async diagnostics without leaking unhandled rejections', async() => {
		const observed = new Set<string>()
		const rejected = (name: string) => {
			observed.add(name)
			return Promise.reject(new Error(`${name} failed`))
		}
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})],
			logger: {warn: async() => { observed.add('warn'); throw new Error('warn failed') }} as never,
			errors: {report: () => rejected('report')} as never,
			metrics: {
				increment: () => rejected('increment'),
				record: () => rejected('record')
			} as never,
			tracer: {startSpan: () => ({
				recordException: () => rejected('recordException'),
				setStatus: () => rejected('setStatus'),
				end: () => rejected('end')
			})} as never,
			performance: {measureAsync: async() => { throw new Error('measurement failed') }}
		})

		await expect(runtime.execute(
			{operation: 'async-diagnostics', policy: 'test', context},
			async() => { throw new Error('primary') }
		)).rejects.toThrow('primary')
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(observed).toEqual(new Set([
			'end', 'increment', 'record', 'recordException', 'report', 'setStatus', 'warn'
		]))
		await runtime.shutdown()
	})

	it('does not evaluate accessor-backed promise methods returned by diagnostics', async() => {
		const catchGetter = vi.fn(() => () => undefined)
		const then = vi.fn()
		const hostile = Object.defineProperties({}, {
			catch: {get: catchGetter},
			then: {value: then}
		})
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})],
			metrics: {increment: () => hostile, record: () => hostile} as never
		})
		await expect(runtime.execute(
			{operation: 'hostile-diagnostic-return', policy: 'test', context},
			async() => 'ok'
		)).resolves.toBe('ok')
		expect(catchGetter).not.toHaveBeenCalled()
		expect(then).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('fences synchronous observer reentrancy without suppressing nested work', async() => {
		let runtime!: ReturnType<typeof createProductionResilience>
		let nested: Promise<string> | undefined
		const nestedOperation = vi.fn(async() => 'nested')
		const startSpan = vi.fn(() => {
			nested ??= runtime.execute(
				{operation: 'nested-observer', policy: 'test', context},
				nestedOperation
			)
			return {addEvent() {}, recordException() {}, setStatus() {}, end() {}}
		})
		runtime = createProductionResilience({
			clock, policies: [policy({retry: false, circuitBreaker: false})],
			tracer: {startSpan} as never
		})
		await expect(runtime.execute(
			{operation: 'outer-observer', policy: 'test', context},
			async() => 'outer'
		)).resolves.toBe('outer')
		await expect(nested).resolves.toBe('nested')
		expect(startSpan).toHaveBeenCalledOnce()
		expect(nestedOperation).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('never retries an HTTP failure with ambiguous completion under the built-in classifier', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({circuitBreaker: false})]})
		const operation = vi.fn(async() => { throw Object.assign(new Error('ambiguous'), {status: 503}) })
		await expect(runtime.execute({operation: 'ambiguous-http', policy: 'test', context}, operation)).rejects.toThrow('ambiguous')
		expect(operation).toHaveBeenCalledTimes(1)
		expect(runtime.getStatus().retriedTotal).toBe(0)
		await runtime.shutdown()
	})

	it('does not evaluate or export hostile error identity fields to the error bridge', async() => {
		const report = vi.fn()
		const nameGetter = vi.fn(() => 'secret-kind')
		const codeGetter = vi.fn(() => 'SECRET_CODE')
		const hostile = Object.defineProperties({}, {
			name: {enumerable: true, get: nameGetter},
			code: {enumerable: true, get: codeGetter}
		})
		const runtime = createProductionResilience({clock, policies: [policy({retry: false, circuitBreaker: false})], errors: {report}})
		await expect(runtime.execute({operation: 'hostile-error', policy: 'test', context}, async() => { throw hostile })).rejects.toBe(hostile)
		expect(nameGetter).not.toHaveBeenCalled()
		expect(codeGetter).not.toHaveBeenCalled()
		expect(report).toHaveBeenCalledWith(
			{kind: 'ResilienceError', code: 'RESILIENCE_FAILURE', message: 'Resilience operation failed'},
			{service: 'resilience', operation: 'hostile-error', resource: expect.stringMatching(/^fp_[0-9a-f]{16}$/)}
		)
		await runtime.shutdown()
	})

	it('keeps shutdown draining until abort-ignoring physical work settles', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({retry: false})]})
		let resolve!: () => void
		const operation = runtime.execute({operation: 'slow', policy: 'test', context}, async() => await new Promise<string>((done) => { resolve = () => done('late') }))
		void operation.catch(() => undefined)
		await vi.waitFor(() => expect(typeof resolve).toBe('function'))
		let shutdownSettled = false
		const shutdown = runtime.shutdown().finally(() => { shutdownSettled = true })
		await new Promise((done) => setTimeout(done, 10))
		expect(runtime.getStatus().state).toBe('draining')
		expect(shutdownSettled).toBe(false)
		resolve()
		await operation.catch(() => undefined)
		await shutdown
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('publishes accepted ownership before a tracing callback can reenter shutdown', async() => {
		let runtime!: ReturnType<typeof createProductionResilience>
		let shutdown: Promise<void> | undefined
		let shutdownSettled = false
		const startSpan = vi.fn(() => {
			shutdown = runtime.shutdown().then(() => { shutdownSettled = true })
			return {addEvent: () => undefined, setStatus: () => undefined, recordException: () => undefined, end: () => undefined}
		})
		runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})],
			tracer: {startSpan} as never
		})

		const execution = runtime.execute(
			{operation: 'reentrant-tracing-shutdown', policy: 'test', context},
			async() => 'must-not-run'
		)
		await Promise.resolve()
		expect(shutdownSettled).toBe(false)
		await expect(execution).rejects.toMatchObject({name: 'AbortError'})
		await expect(shutdown).resolves.toBeUndefined()
		expect(startSpan).toHaveBeenCalledOnce()
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('publishes accepted ownership before the first metrics callback can reenter shutdown', async() => {
		let runtime!: ReturnType<typeof createProductionResilience>
		let shutdown: Promise<void> | undefined
		let shutdownSettled = false
		let reentered = false
		const record = vi.fn(() => {
			if (reentered) return
			reentered = true
			shutdown = runtime.shutdown().then(() => { shutdownSettled = true })
		})
		runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})],
			metrics: {record, increment: () => undefined} as never
		})

		const execution = runtime.execute(
			{operation: 'reentrant-metrics-shutdown', policy: 'test', context},
			async() => 'must-not-run'
		)
		await Promise.resolve()
		expect(shutdownSettled).toBe(false)
		await expect(execution).rejects.toMatchObject({name: 'AbortError'})
		await expect(shutdown).resolves.toBeUndefined()
		expect(record).toHaveBeenCalled()
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('does not start physical work after immediate shutdown aborts admission', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({retry: false})]})
		const operation = vi.fn(async() => 'must not run')
		const result = runtime.execute({operation: 'cancel-before-start', policy: 'test', context}, operation)
		const shutdown = runtime.shutdown()
		await expect(result).rejects.toMatchObject({name: 'AbortError'})
		await shutdown
		expect(operation).not.toHaveBeenCalled()
	})

	it('releases each bulkhead permit after only its own physical work settles', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, bulkhead: {maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 50}})]
		})
		let releaseSlow!: () => void
		const slow = runtime.execute(
			{operation: 'slow-a', policy: 'test', context: {resource: 'provider.a'}},
			async() => await new Promise<string>((resolve) => { releaseSlow = () => resolve('slow') })
		)
		await vi.waitFor(() => expect(runtime.getStatus().activeOperations).toBe(1))
		await expect(runtime.execute({operation: 'fast-b', policy: 'test', context: {resource: 'provider.b'}}, async() => 'first')).resolves.toBe('first')
		await expect(runtime.execute({operation: 'fast-b-2', policy: 'test', context: {resource: 'provider.b'}}, async() => 'second')).resolves.toBe('second')
		releaseSlow()
		await expect(slow).resolves.toBe('slow')
		await runtime.shutdown()
	})

	it('revalidates the breaker before a queued bulkhead waiter reaches the provider', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 1, failureRatioThreshold: 1},
				bulkhead: {maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 200}
			})]
		})
		let failOwner!: () => void
		const owner = runtime.execute(
			{operation: 'breaker-owner', policy: 'test', context},
			async() => await new Promise<never>((_resolve, reject) => {
				failOwner = () => reject(new Error('provider down'))
			})
		)
		await vi.waitFor(() => expect(typeof failOwner).toBe('function'))
		const staleProvider = vi.fn(async() => 'must not run')
		const queued = runtime.execute(
			{operation: 'breaker-queued', policy: 'test', context},
			staleProvider
		)
		await vi.waitFor(() => expect(runtime.getStatus().queuedOperations).toBe(1))

		failOwner()
		await expect(owner).rejects.toThrow('provider down')
		await expect(queued).rejects.toMatchObject({code: 'RESILIENCE_BREAKER_OPEN'})
		expect(staleProvider).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('does not reset a nested half-open probe admitted by a reentrant clock callback', async() => {
		let now = 0
		let armed = false
		let clockReads = 0
		let reentered = false
		let nested: Promise<string> | undefined
		let runtime!: ReturnType<typeof createProductionResilience>
		let releaseNested!: () => void
		const reentrantClock = {now: () => {
			if (armed && ++clockReads === 2 && !reentered) {
				reentered = true
				nested = runtime.execute(
					{operation: 'nested-half-open', policy: 'test', context},
					async() => await new Promise<string>((resolve) => { releaseNested = () => resolve('recovered') })
				)
			}
			return now
		}}
		runtime = createProductionResilience({
			clock: reentrantClock,
			policies: [policy({
				retry: false,
				circuitBreaker: {
					...breaker,
					failureCountThreshold: 1,
					failureRatioThreshold: 1,
					halfOpenAfterMs: 10,
					halfOpenMaxAttempts: 1
				}
			})]
		})
		const request = {operation: 'outer-half-open', policy: 'test', context} as const
		await expect(runtime.execute(request, async() => { throw new Error('open') })).rejects.toThrow('open')
		now = 11
		armed = true
		const outerProvider = vi.fn(async() => 'must-not-run')
		await expect(runtime.execute(request, outerProvider)).rejects.toMatchObject({code: 'RESILIENCE_BREAKER_OPEN'})
		expect(outerProvider).not.toHaveBeenCalled()
		await vi.waitFor(() => expect(typeof releaseNested).toBe('function'))
		releaseNested()
		await expect(nested).resolves.toBe('recovered')
		await runtime.shutdown()
	})

	it('fences late half-open completions by breaker generation', async() => {
		let now = 0
		const runtime = createProductionResilience({
			clock: {now: () => now},
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 1, halfOpenAfterMs: 10, halfOpenMaxAttempts: 2}
			})]
		})
		const request = {operation: 'breaker', policy: 'test', context} as const
		await expect(runtime.execute(request, async() => { throw new Error('open') })).rejects.toThrow('open')
		now = 11
		let failProbe!: () => void
		let passProbe!: () => void
		const failed = runtime.execute(request, async() => await new Promise<string>((_resolve, reject) => { failProbe = () => reject(new Error('probe failed')) }))
		const passed = runtime.execute(request, async() => await new Promise<string>((resolve) => { passProbe = () => resolve('late success') }))
		await vi.waitFor(() => {
			expect(runtime.getStatus().activeOperations).toBe(2)
			expect(typeof failProbe).toBe('function')
			expect(typeof passProbe).toBe('function')
		})
		failProbe()
		await expect(failed).rejects.toThrow('probe failed')
		passProbe()
		await expect(passed).resolves.toBe('late success')
		await expect(runtime.execute(request, async() => 'must not run')).rejects.toMatchObject({code: 'RESILIENCE_BREAKER_OPEN'})
		await runtime.shutdown()
	})

	it('fails the managed breaker closed when its clock fails during a half-open failure', async() => {
		let now = 0
		let clockFails = false
		const runtime = createProductionResilience({
			clock: {now: () => { if (clockFails) throw new Error('clock failed'); return now }},
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 1, halfOpenAfterMs: 10, halfOpenMaxAttempts: 1}
			})]
		})
		const request = {operation: 'clock-failed-probe', policy: 'test', context} as const
		await expect(runtime.execute(request, async() => { throw new Error('open') })).rejects.toThrow('open')
		now = 11
		await expect(runtime.execute(request, async() => {
			clockFails = true
			throw new Error('probe failed')
		})).rejects.toThrow('probe failed')
		clockFails = false
		await expect(runtime.execute(request, async() => 'must not run'))
			.rejects.toMatchObject({code: 'RESILIENCE_BREAKER_OPEN'})
		await runtime.shutdown()
	})

	it('returns a half-open probe slot when bulkhead admission fails', async() => {
		let now = 0
		const runtime = createProductionResilience({
			clock: {now: () => now},
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 1, halfOpenAfterMs: 10, halfOpenMaxAttempts: 2},
				bulkhead: {maxConcurrent: 1, maxQueueSize: 0, queueTimeoutMs: 50}
			})]
		})
		const request = {operation: 'probe', policy: 'test', context} as const
		await expect(runtime.execute(request, async() => { throw new Error('open') })).rejects.toThrow('open')
		now = 11
		let releaseFirst!: () => void
		const first = runtime.execute(request, async() => await new Promise<string>((resolve) => { releaseFirst = () => resolve('first') }))
		await vi.waitFor(() => expect(typeof releaseFirst).toBe('function'))
		await expect(runtime.execute(request, async() => 'overflow')).rejects.toMatchObject({code: 'RESILIENCE_BULKHEAD_OVERFLOW'})
		releaseFirst()
		await expect(first).resolves.toBe('first')
		await new Promise((resolve) => setTimeout(resolve, 0))
		let releaseSecond!: () => void
		const second = runtime.execute(request, async() => await new Promise<string>((resolve) => { releaseSecond = () => resolve('second') }))
		await vi.waitFor(() => expect(typeof releaseSecond).toBe('function'))
		await expect(runtime.execute(request, async() => 'overflow-again')).rejects.toMatchObject({code: 'RESILIENCE_BULKHEAD_OVERFLOW'})
		releaseSecond()
		await expect(second).resolves.toBe('second')
		await runtime.shutdown()
	})

	it('rejects policy values that overflow Node timers or internal capacities', () => {
		expect(() => createProductionResilience({clock, policies: [policy({timeout: {defaultMs: 2_147_483_648}})]})).toThrow(/invalid policy/)
		expect(() => createProductionResilience({clock, policies: [policy({retry: {...retry, maxAttempts: 101}})]})).toThrow(/invalid policy/)
		expect(() => createProductionResilience({clock, policies: [policy({circuitBreaker: {...breaker, failureCountThreshold: 257}})]})).toThrow(/invalid policy/)
		expect(() => createProductionResilience({clock, policies: [policy({circuitBreaker: {...breaker, failureRatioThreshold: Number.NaN}})]})).toThrow(/invalid policy/)
		expect(() => createProductionResilience({clock, policies: [policy({bulkhead: {maxConcurrent: 1, maxQueueSize: 10_001, queueTimeoutMs: 10}})]})).toThrow(/invalid policy/)
	})

	it('rejects built-in retry classifiers from an incompatible operation kind', () => {
		expect(() => createProductionResilience({
			clock,
			policies: [{
				...policy({operationKind: 'db.write'}),
				retry: {...retry, classifier: 'db-read'}
			}]
		})).toThrow(/invalid policy/u)
	})

	it('bounds global logical admission even when a policy has no bulkhead', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({timeout: {defaultMs: 5_000}, retry: false, circuitBreaker: false})]})
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const request = {operation: 'admission', policy: 'test', context} as const
		const operations = Array.from({length: 2_048}, () => runtime.execute(request, async() => { await gate; return 'ok' }))
		expect(runtime.getStatus().activeOperations).toBe(2_048)
		await expect(runtime.execute(request, async() => 'must not run')).rejects.toMatchObject({code: 'RESILIENCE_ADMISSION_CAPACITY'})
		release()
		await expect(Promise.all(operations)).resolves.toHaveLength(2_048)
		await expect(runtime.execute(request, async() => 'recovered')).resolves.toBe('recovered')
		await runtime.shutdown()
	})

	it('rechecks global admission after a reentrant clock callback publishes nested work', async() => {
		let armed = false
		let reentered = false
		let nested: Promise<string> | undefined
		let runtime!: ReturnType<typeof createProductionResilience>
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const reentrantClock = {now: () => {
			if (armed && !reentered) {
				reentered = true
				nested = runtime.execute(
					{operation: 'nested-capacity', policy: 'test', context},
					async() => { await gate; return 'nested' }
				)
			}
			return Date.now()
		}}
		runtime = createProductionResilience({
			clock: reentrantClock,
			policies: [policy({timeout: {defaultMs: 5_000}, retry: false, circuitBreaker: false})]
		})
		const request = {operation: 'capacity-owner', policy: 'test', context} as const
		const owners = Array.from(
			{length: 2_047},
			() => runtime.execute(request, async() => { await gate; return 'owner' })
		)
		armed = true
		const outer = vi.fn(async() => 'must-not-run')
		await expect(runtime.execute(request, outer)).rejects.toMatchObject({code: 'RESILIENCE_ADMISSION_CAPACITY'})
		expect(outer).not.toHaveBeenCalled()
		expect(runtime.getStatus().activeOperations).toBe(2_048)

		release()
		await expect(Promise.all([...owners, nested!])).resolves.toHaveLength(2_048)
		await runtime.shutdown()
	})

	it('evicts inactive closed partitions instead of permanently poisoning state capacity', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: {...breaker, failureCountThreshold: 10}})]
		})
		for (let index = 0; index < 2_048; index++) {
			await runtime.execute(
				{operation: 'partition-fill', policy: 'test', context: {resource: `provider.${index}`}},
				async() => 'ok'
			)
		}
		await expect(runtime.execute(
			{operation: 'partition-after-capacity', policy: 'test', context: {resource: 'provider.after-capacity'}},
			async() => 'still-available'
		)).resolves.toBe('still-available')
		await runtime.shutdown()
	}, 10_000)

	it('fails closed when partition eviction clock callbacks reenter state mutation', async() => {
		let now = 0
		let armed = false
		let outerClockReads = 0
		let reentered = false
		let nested: Promise<string> | undefined
		let runtime!: ReturnType<typeof createProductionResilience>
		const nestedProvider = vi.fn(async() => 'must-not-run')
		const reentrantClock = {now: () => {
			if (armed && ++outerClockReads === 2 && !reentered) {
				reentered = true
				nested = runtime.execute(
					{operation: 'nested-partition', policy: 'test', context: {resource: 'provider.nested'}},
					nestedProvider
				)
			}
			return now
		}}
		runtime = createProductionResilience({
			clock: reentrantClock,
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 2, failureRatioThreshold: 1, timeWindowMs: 10}
			})]
		})
		for (let index = 0; index < 2_048; index++) {
			await expect(runtime.execute(
				{operation: 'retain-partition', policy: 'test', context: {resource: `provider.retained.${index}`}},
				async() => { throw new Error('provider failure') }
			)).rejects.toThrow('provider failure')
		}

		now = 11
		armed = true
		await expect(runtime.execute(
			{operation: 'outer-partition', policy: 'test', context: {resource: 'provider.outer'}},
			async() => 'outer'
		)).resolves.toBe('outer')
		await expect(nested).rejects.toMatchObject({code: 'RESILIENCE_STATE_CAPACITY'})
		expect(nestedProvider).not.toHaveBeenCalled()
		await runtime.shutdown()
	}, 20_000)

	it('does not evict live CLOSED failure windows to bypass breaker accounting', async() => {
		let now = 0
		const runtime = createProductionResilience({
			clock: {now: () => now},
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 2, failureRatioThreshold: 1, timeWindowMs: 100}
			})]
		})
		for (let index = 0; index < 2_048; index++) {
			await expect(runtime.execute(
				{operation: 'protected-failure', policy: 'test', context: {resource: `provider.failed.${index}`}},
				async() => { throw new Error('transient failure') }
			)).rejects.toThrow('transient failure')
		}
		const replacement = vi.fn(async() => 'must-not-run')
		await expect(runtime.execute(
			{operation: 'capacity-bypass', policy: 'test', context: {resource: 'provider.replacement'}},
			replacement
		)).rejects.toMatchObject({code: 'RESILIENCE_STATE_CAPACITY'})
		expect(replacement).not.toHaveBeenCalled()

		now = 101
		await expect(runtime.execute(
			{operation: 'after-window', policy: 'test', context: {resource: 'provider.replacement'}},
			async() => 'available'
		)).resolves.toBe('available')
		await runtime.shutdown()
	}, 15_000)

	it('does not let a custom fallback bypass fail-closed state capacity', async() => {
		const fallback = vi.fn(() => 'degraded')
		const runtime = createCustomResilience({
			clock,
			policies: [policy({
				retry: false,
				circuitBreaker: {
					...breaker,
					failureCountThreshold: 2,
					failureRatioThreshold: 1,
					timeWindowMs: 60_000
				},
				fallback: 'generic'
			})],
			fallbacks: {
				generic: [{condition: () => true, handler: fallback, degradeLevel: 'PARTIAL'}]
			}
		})
		for (let index = 0; index < 2_048; index++) {
			await expect(runtime.execute(
				{operation: 'protected-fallback', policy: 'test', context: {resource: `fallback.${index}`}},
				async() => { throw new Error('provider failure') }
			)).resolves.toBe('degraded')
		}
		fallback.mockClear()
		const physical = vi.fn(async() => 'must not run')

		await expect(runtime.execute(
			{operation: 'capacity-fallback-bypass', policy: 'test', context: {resource: 'fallback.overflow'}},
			physical
		)).rejects.toMatchObject({code: 'RESILIENCE_STATE_CAPACITY'})
		expect(physical).not.toHaveBeenCalled()
		expect(fallback).not.toHaveBeenCalled()
		await runtime.shutdown()
	}, 15_000)

	it('keeps retry-budget capacity authoritative over generic fallbacks', async() => {
		const fallback = vi.fn(() => 'degraded')
		const runtime = createCustomResilience({
			clock,
			policies: [policy({
				retry: {
					...retry,
					classifier: 'retryable-zero-delay',
					maxAttempts: 2,
					budget: {maxRetries: 1, windowMs: 60_000}
				},
				circuitBreaker: false,
				fallback: 'generic'
			})],
			classifiers: {
				['retryable-zero-delay']: () => ({retryable: true, delayMs: 0})
			},
			fallbacks: {
				generic: [{condition: () => true, handler: fallback, degradeLevel: 'PARTIAL'}]
			}
		})
		for (let index = 0; index < 2_048; index++) {
			await expect(runtime.execute(
				{operation: 'budget-fallback', policy: 'test', context: {resource: `budget-fallback.${index}`}},
				async() => { throw new Error('retryable') }
			)).resolves.toBe('degraded')
		}
		fallback.mockClear()
		const physical = vi.fn(async() => { throw new Error('retryable') })

		await expect(runtime.execute(
			{operation: 'budget-capacity-fallback', policy: 'test', context: {resource: 'budget-fallback.overflow'}},
			physical
		)).rejects.toMatchObject({code: 'RESILIENCE_STATE_CAPACITY'})
		expect(physical).toHaveBeenCalledTimes(1)
		expect(fallback).not.toHaveBeenCalled()
		await runtime.shutdown()
	}, 15_000)

	it('does not reset live retry budgets through isolation-key churn', async() => {
		let now = 0
		const budgetedRetry = {...retry, maxAttempts: 2, budget: {maxRetries: 1, windowMs: 100}}
		const runtime = createProductionResilience({
			clock: {now: () => now},
			policies: [policy({retry: budgetedRetry, circuitBreaker: false})]
		})
		for (let index = 0; index < 2_048; index++) {
			let attempts = 0
			await expect(runtime.execute(
				{operation: 'consume-budget', policy: 'test', context: {resource: `provider.budget.${index}`}},
				async() => {
					if (attempts++ === 0) throw Object.assign(new Error('connect'), {code: 'ECONNREFUSED'})
					return 'retried'
				}
			)).resolves.toBe('retried')
		}
		const replacement = vi.fn(async() => { throw Object.assign(new Error('connect'), {code: 'ECONNREFUSED'}) })
		await expect(runtime.execute(
			{operation: 'budget-bypass', policy: 'test', context: {resource: 'provider.budget.replacement'}},
			replacement
		)).rejects.toMatchObject({code: 'RESILIENCE_STATE_CAPACITY'})
		expect(replacement).toHaveBeenCalledTimes(1)

		now = 101
		let recoveredAttempts = 0
		await expect(runtime.execute(
			{operation: 'after-budget-window', policy: 'test', context: {resource: 'provider.budget.replacement'}},
			async() => {
				if (recoveredAttempts++ === 0) throw Object.assign(new Error('connect'), {code: 'ECONNREFUSED'})
				return 'available'
			}
		)).resolves.toBe('available')
		await runtime.shutdown()
	}, 20_000)

	it('keeps expired OPEN and partial HALF_OPEN recovery authoritative at capacity', async() => {
		let now = 0
		const runtime = createProductionResilience({
			clock: {now: () => now},
			policies: [policy({
				retry: false,
				circuitBreaker: {
					...breaker,
					failureCountThreshold: 1,
					failureRatioThreshold: 1,
					halfOpenAfterMs: 10,
					halfOpenMaxAttempts: 2
				}
			})]
		})
		for (let index = 0; index < 2_048; index++) {
			await expect(runtime.execute(
				{operation: 'open-partition', policy: 'test', context: {resource: `provider.open.${index}`}},
				async() => { throw new Error('provider unavailable') }
			)).rejects.toThrow('provider unavailable')
		}
		now = 11
		const replacement = vi.fn(async() => 'must-not-run')
		await expect(runtime.execute(
			{operation: 'after-open-capacity', policy: 'test', context: {resource: 'provider.new'}},
			replacement
		)).rejects.toMatchObject({code: 'RESILIENCE_STATE_CAPACITY'})
		expect(replacement).not.toHaveBeenCalled()

		const probeRequest = {
			operation: 'half-open-probe',
			policy: 'test',
			context: {resource: 'provider.open.0'}
		} as const
		await expect(runtime.execute(probeRequest, async() => 'first')).resolves.toBe('first')
		await expect(runtime.execute(
			{operation: 'during-partial-recovery', policy: 'test', context: {resource: 'provider.new'}},
			replacement
		)).rejects.toMatchObject({code: 'RESILIENCE_STATE_CAPACITY'})
		expect(replacement).not.toHaveBeenCalled()

		await expect(runtime.execute(probeRequest, async() => 'second')).resolves.toBe('second')
		await expect(runtime.execute(
			{operation: 'after-recovery', policy: 'test', context: {resource: 'provider.new'}},
			async() => 'available'
		)).resolves.toBe('available')
		await runtime.shutdown()
	}, 15_000)

	it('keeps admission owned by timeout-ignoring physical work until settlement', async() => {
		const runtime = createProductionResilience({clock, policies: [policy({timeout: {defaultMs: 10}, retry: false, circuitBreaker: false})]})
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const request = {operation: 'orphan-capacity', policy: 'test', context} as const
		const operations = Array.from({length: 2_048}, () => runtime.execute(request, async() => { await gate; return 'late' }).catch((error: unknown) => error))
		await vi.waitFor(() => expect(runtime.getStatus().activeOperations).toBe(0), {timeout: 5_000})
		await expect(runtime.execute(request, async() => 'must not run')).rejects.toMatchObject({code: 'RESILIENCE_ADMISSION_CAPACITY'})
		release()
		await Promise.all(operations)
		await vi.waitFor(async() => await expect(runtime.execute(request, async() => 'recovered')).resolves.toBe('recovered'))
		await runtime.shutdown()
	}, 10_000)

	it('retains a coalescing claim until timeout-ignoring owner work physically settles', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({timeout: {defaultMs: 10}, retry: false, circuitBreaker: false, coalescing: {maxKeys: 10, ttlMs: 1_000}})]
		})
		let release!: () => void
		const request = {operation: 'late-owner', policy: 'test', context, coalescingKey: 'same'} as const
		const ownerOperation = vi.fn(async() => await new Promise<string>((resolve) => { release = () => resolve('late') }))
		await expect(runtime.execute(request, ownerOperation)).rejects.toMatchObject({code: 'RESILIENCE_TIMEOUT'})
		const duplicate = vi.fn(async() => 'must not run')
		await expect(runtime.execute(request, duplicate)).rejects.toMatchObject({code: 'RESILIENCE_TIMEOUT'})
		expect(duplicate).not.toHaveBeenCalled()
		release()
		await vi.waitFor(async() => await expect(runtime.execute(request, async() => 'after-settlement')).resolves.toBe('after-settlement'))
		await runtime.shutdown()
	})

	it('fences retained performance callbacks and isolates a hanging bridge', async() => {
		let retained!: () => Promise<string>
		const operation = vi.fn(async() => 'authoritative')
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})],
			performance: {measureAsync: (_name, fn) => { retained = fn as () => Promise<string>; return Promise.resolve('bridge-value') }} as never
		})
		await expect(runtime.execute({operation: 'measured', policy: 'test', context}, operation)).resolves.toBe('authoritative')
		await expect(retained()).rejects.toMatchObject({code: 'RESILIENCE_NOT_RUNNING'})
		expect(operation).toHaveBeenCalledTimes(1)
		await runtime.shutdown()

		let retainedHanging!: () => Promise<string>
		const hanging = createProductionResilience({
			clock,
			policies: [policy({timeout: {defaultMs: 10}, retry: false, circuitBreaker: false})],
			performance: {measureAsync: (_name, fn) => { retainedHanging = fn as () => Promise<string>; return new Promise(() => undefined) }} as never
		})
		const stillRuns = vi.fn(async() => 'still-runs')
		await expect(hanging.execute({operation: 'hanging-measure', policy: 'test', context}, stillRuns)).resolves.toBe('still-runs')
		await expect(retainedHanging()).rejects.toMatchObject({code: 'RESILIENCE_NOT_RUNNING'})
		expect(stillRuns).toHaveBeenCalledTimes(1)
		await hanging.shutdown()
	})

	it('contains clock failures before admission and inside asynchronous timer callbacks', async() => {
		const failedAtAdmission = createProductionResilience({
			clock: {now: () => { throw new Error('clock unavailable') }},
			policies: [policy({retry: false, circuitBreaker: false})]
		})
		await expect(failedAtAdmission.execute({operation: 'clock-start', policy: 'test', context}, async() => 'never')).rejects.toThrow('clock unavailable')
		expect(failedAtAdmission.getStatus()).toMatchObject({activeOperations: 0, queuedOperations: 0})
		await failedAtAdmission.shutdown()

		let timeoutReads = 0
		const timeoutRuntime = createProductionResilience({
			clock: {now: () => { if (timeoutReads++ === 0) return 100; throw new Error('clock unavailable') }},
			policies: [policy({timeout: {defaultMs: 10}, retry: false, circuitBreaker: false})]
		})
		await expect(timeoutRuntime.execute(
			{operation: 'clock-timeout', policy: 'test', context},
			async(signal) => await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}))
		)).rejects.toMatchObject({code: 'RESILIENCE_TIMEOUT', timestamp: 110})

		let release!: () => void
		let bulkheadReads = 0
		const bulkheadRuntime = createProductionResilience({
			clock: {now: () => { if (bulkheadReads++ < 2) return 100; throw new Error('clock unavailable') }},
			policies: [policy({
				timeout: {defaultMs: 500}, retry: false, circuitBreaker: false,
				bulkhead: {maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 5}
			})]
		})
		const first = bulkheadRuntime.execute(
			{operation: 'occupy', policy: 'test', context},
			async() => await new Promise<string>((resolve) => { release = () => resolve('done') })
		)
		await vi.waitFor(() => expect(typeof release).toBe('function'))
		await expect(bulkheadRuntime.execute({operation: 'queued', policy: 'test', context}, async() => 'never'))
			.rejects.toMatchObject({code: 'RESILIENCE_BULKHEAD_OVERFLOW'})
		release()
		await first
		await timeoutRuntime.shutdown()
		await bulkheadRuntime.shutdown()
	})

	it('rejects clock magnitudes that could bypass bounded breaker deadlines', async() => {
		const operation = vi.fn(async() => 'must not run')
		const runtime = createProductionResilience({
			clock: {now: () => Number.MAX_VALUE},
			policies: [policy()]
		})

		await expect(runtime.execute(
			{operation: 'unsafe-clock-domain', policy: 'test', context},
			operation
		)).rejects.toThrow('invalid clock')
		expect(operation).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('rolls back admission and queue accounting when timer scheduling fails', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})]
		})
		const timerFailure = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
			throw new Error('timer scheduling failed')
		})
		await expect(runtime.execute(
			{operation: 'timer-admission', policy: 'test', context},
			async() => 'never'
		)).rejects.toThrow('timer scheduling failed')
		expect(runtime.getStatus()).toMatchObject({activeOperations: 0, queuedOperations: 0})
		timerFailure.mockRestore()
		await expect(runtime.execute(
			{operation: 'timer-recovered', policy: 'test', context},
			async() => 'ok'
		)).resolves.toBe('ok')
		await runtime.shutdown()

		let release!: () => void
		let started!: () => void
		const queuedRuntime = createProductionResilience({
			clock,
			policies: [policy({
				retry: false,
				circuitBreaker: false,
				bulkhead: {maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 1_000}
			})]
		})
		const owner = queuedRuntime.execute(
			{operation: 'timer-owner', policy: 'test', context},
			async() => await new Promise<string>((resolve) => { started = () => undefined; release = () => resolve('owner') })
		)
		await vi.waitFor(() => expect(typeof started).toBe('function'))
		const nativeSetTimeout = globalThis.setTimeout
		let timerCalls = 0
		const queueTimerFailure = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...arguments_: Parameters<typeof setTimeout>) => {
			if (++timerCalls === 2) throw new Error('queue timer scheduling failed')
			return nativeSetTimeout(...arguments_)
		}) as typeof setTimeout)
		await expect(queuedRuntime.execute(
			{operation: 'timer-waiter', policy: 'test', context},
			async() => 'never'
		)).rejects.toThrow('queue timer scheduling failed')
		expect(queuedRuntime.getStatus().queuedOperations).toBe(0)
		queueTimerFailure.mockRestore()
		release()
		await expect(owner).resolves.toBe('owner')
		await expect(queuedRuntime.execute(
			{operation: 'timer-next', policy: 'test', context},
			async() => 'next'
		)).resolves.toBe('next')
		await queuedRuntime.shutdown()
	})

	it('does not strand a managed waiter when the queue timer fires synchronously', async() => {
		let release!: () => void
		const runtime = createProductionResilience({
			clock,
			policies: [policy({
				retry: false,
				circuitBreaker: false,
				bulkhead: {maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 1_000}
			})]
		})
		const owner = runtime.execute(
			{operation: 'synchronous-timer-owner', policy: 'test', context},
			async() => await new Promise<string>((resolve) => { release = () => resolve('owner') })
		)
		await vi.waitFor(() => expect(typeof release).toBe('function'))

		const nativeSetTimeout = globalThis.setTimeout
		let timerCalls = 0
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...arguments_: Parameters<typeof setTimeout>) => {
			if (++timerCalls === 2) {
				Reflect.apply(arguments_[0], undefined, [])
				return 0 as unknown as ReturnType<typeof setTimeout>
			}
			return nativeSetTimeout(...arguments_)
		}) as typeof setTimeout)
		await expect(runtime.execute(
			{operation: 'synchronous-timer-waiter', policy: 'test', context},
			async() => 'never'
		)).rejects.toMatchObject({code: 'RESILIENCE_BULKHEAD_OVERFLOW'})
		expect(runtime.getStatus().queuedOperations).toBe(0)
		timer.mockRestore()

		release()
		await expect(owner).resolves.toBe('owner')
		await expect(runtime.execute(
			{operation: 'after-synchronous-timer', policy: 'test', context},
			async() => 'next'
		)).resolves.toBe('next')
		await runtime.shutdown()
	})

	it('keeps settlement and shutdown retryability when timer cleanup throws', async() => {
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})]
		})
		const nativeClearTimeout = globalThis.clearTimeout
		const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
			nativeClearTimeout(timer)
			throw new Error('timer cleanup failed')
		})
		await expect(runtime.execute(
			{operation: 'cleanup-failure', policy: 'test', context},
			async() => 'ok'
		)).resolves.toBe('ok')
		await vi.waitFor(() => expect(runtime.getStatus().activeOperations).toBe(0))
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		clear.mockRestore()
	})

	it('does not start a coalesced owner before all claim metadata is captured', async() => {
		let reads = 0
		const runtime = createProductionResilience({
			clock: {now: () => {
				if (reads++ === 0) return 100
				throw new Error('claim clock unavailable')
			}},
			policies: [policy({retry: false, circuitBreaker: false, coalescing: {maxKeys: 10, ttlMs: 1_000}})]
		})
		const physical = vi.fn(async() => 'side effect')

		await expect(runtime.execute(
			{operation: 'coalesced-claim', policy: 'test', context, coalescingKey: 'same'},
			physical
		)).rejects.toThrow('claim clock unavailable')
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(physical).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('joins reentrant shutdown calls before dispatching operation abort listeners', async() => {
		let release!: () => void
		let reentrantShutdown: Promise<void> | undefined
		const dispose = vi.fn(() => { throw new Error('disposer failed') })
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})],
			lifecycle: {registerShutdownHook: () => dispose} as never
		})
		const operation = runtime.execute(
			{operation: 'reentrant-shutdown', policy: 'test', context},
			async(signal) => {
				signal.addEventListener('abort', () => { reentrantShutdown = runtime.shutdown() }, {once: true})
				return await new Promise<string>((resolve) => { release = () => resolve('late') })
			}
		)
		const operationFailure = expect(operation).rejects.toMatchObject({name: 'AbortError'})
		await vi.waitFor(() => expect(typeof release).toBe('function'))
		const primaryShutdown = runtime.shutdown()
		await vi.waitFor(() => expect(reentrantShutdown).toBeDefined())
		const reentrantFailure = expect(reentrantShutdown!).rejects.toThrow('disposer failed')
		release()

		await operationFailure
		await expect(primaryShutdown).rejects.toThrow('disposer failed')
		await reentrantFailure
		expect(dispose).toHaveBeenCalledTimes(1)
	})

	it('publishes the shared shutdown attempt before timer scheduling can reenter', async() => {
		const runtime = createProductionResilience({clock, policies: [policy()]})
		const nativeSetTimeout = globalThis.setTimeout
		let reentrantShutdown: Promise<void> | undefined
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(((...arguments_: Parameters<typeof setTimeout>) => {
			reentrantShutdown = runtime.shutdown()
			return nativeSetTimeout(...arguments_)
		}) as typeof setTimeout)

		const primary = runtime.shutdown()
		await expect(primary).resolves.toBeUndefined()
		await expect(reentrantShutdown).resolves.toBeUndefined()
		expect(runtime.getStatus().state).toBe('closed')
		timer.mockRestore()
	})

	it('breaks lifecycle disposer self-await cycles without weakening concurrent shutdown joining', async() => {
		let runtime!: ReturnType<typeof createProductionResilience>
		const disposer = vi.fn(async() => await runtime.shutdown())
		runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})],
			lifecycle: {registerShutdownHook: () => disposer} as never
		})
		await Promise.all([runtime.shutdown(), runtime.shutdown()])
		expect(disposer).toHaveBeenCalledOnce()
		expect(runtime.getStatus()).toMatchObject({state: 'closed'})
	})

	it('does not execute custom thenable methods returned by lifecycle disposal', async() => {
		const then = vi.fn()
		const runtime = createProductionResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false})],
			lifecycle: {registerShutdownHook: () => () => ({then})} as never
		})
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		expect(then).not.toHaveBeenCalled()
		expect(runtime.getStatus()).toMatchObject({state: 'closed'})
	})

	it('keeps the shutdown bound authoritative across a backward wall-clock jump', async() => {
		vi.useFakeTimers()
		const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
		try {
			const runtime = createProductionResilience({
				clock,
				policies: [policy({retry: false, circuitBreaker: false})],
				lifecycle: {
					registerShutdownHook: () => async() => await new Promise(() => undefined)
				} as never
			})
			let started!: () => void
			const operation = runtime.execute(
				{operation: 'wall-clock-rollback', policy: 'test', context},
				async(signal) => await new Promise<string>((_resolve, reject) => {
					started = () => undefined
					signal.addEventListener('abort', () => {
						wallClock.mockReturnValue(-1_000_000_000)
						reject(new Error('aborted'))
					}, {once: true})
				})
			)
			await vi.waitFor(() => expect(typeof started).toBe('function'))
			const operationFailure = expect(operation).rejects.toMatchObject({name: 'AbortError'})
			const shutdown = runtime.shutdown()
			const shutdownFailure = expect(shutdown).rejects.toThrow('Resilience shutdown timed out')
			await vi.advanceTimersByTimeAsync(10_000)
			await operationFailure
			await shutdownFailure
			expect(runtime.getStatus()).toMatchObject({
				state: 'draining', lastFailureCode: 'RESILIENCE_FINALIZATION_FAILURE'
			})
		} finally {
			wallClock.mockRestore()
			vi.useRealTimers()
		}
	})

	it('keeps fallback custom-only and does not close the breaker on fallback success', async() => {
		const runtime = createCustomResilience({
			clock,
			policies: [policy({retry: false, fallback: 'cached'})],
			fallbacks: {cached: [{condition: () => true, handler: () => 'fallback', degradeLevel: 'PARTIAL'}]}
		})
		await expect(runtime.execute({operation: 'fallback', policy: 'test', context}, async() => { throw new Error('primary') })).resolves.toBe('fallback')
		await runtime.shutdown()
	})

	it('serves declared fallbacks when breaker or bulkhead admission rejects the primary', async() => {
		const breakerRuntime = createCustomResilience({
			clock: {now: () => 0},
			policies: [policy({
				retry: false,
				circuitBreaker: {...breaker, failureCountThreshold: 1, failureRatioThreshold: 1, halfOpenAfterMs: 100},
				fallback: 'cached'
			})],
			fallbacks: {cached: [{condition: () => true, handler: () => 'cached', degradeLevel: 'PARTIAL'}]}
		})
		const request = {operation: 'breaker-fallback', policy: 'test', context} as const
		await expect(breakerRuntime.execute(request, async() => { throw new Error('provider down') })).resolves.toBe('cached')
		const blockedPrimary = vi.fn(async() => 'must not run')
		await expect(breakerRuntime.execute(request, blockedPrimary)).resolves.toBe('cached')
		expect(blockedPrimary).not.toHaveBeenCalled()
		await breakerRuntime.shutdown()

		const bulkheadRuntime = createCustomResilience({
			clock,
			policies: [policy({
				retry: false, circuitBreaker: false,
				bulkhead: {maxConcurrent: 1, maxQueueSize: 0, queueTimeoutMs: 10}, fallback: 'overflow'
			})],
			fallbacks: {overflow: [{condition: (error) => error instanceof BulkheadOverflowError, handler: () => 'degraded', degradeLevel: 'PARTIAL'}]}
		})
		let release!: () => void
		const active = bulkheadRuntime.execute(request, async() => await new Promise<string>((resolve) => { release = () => resolve('primary') }))
		await vi.waitFor(() => expect(typeof release).toBe('function'))
		const overflowPrimary = vi.fn(async() => 'must not run')
		await expect(bulkheadRuntime.execute(request, overflowPrimary)).resolves.toBe('degraded')
		expect(overflowPrimary).not.toHaveBeenCalled()
		release()
		await active
		await bulkheadRuntime.shutdown()
	})

	it('requires fallback conditions to return the boolean true synchronously', async() => {
		const handler = vi.fn(() => 'must not run')
		const runtime = createCustomResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false, fallback: 'invalid-condition'})],
			fallbacks: {['invalid-condition']: [{condition: (() => Promise.resolve(true)) as never, handler, degradeLevel: 'PARTIAL'}]}
		})
		await expect(runtime.execute(
			{operation: 'fallback-condition', policy: 'test', context},
			async() => { throw new Error('primary') }
		)).rejects.toThrow('primary')
		expect(handler).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('continues to the next matching custom fallback when an earlier handler fails', async() => {
		const first = vi.fn(async() => { throw new Error('first fallback failed') })
		const second = vi.fn(async() => 'secondary recovery')
		const runtime = createCustomResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false, fallback: 'chain'})],
			fallbacks: {chain: [
				{condition: () => true, handler: first, degradeLevel: 'PARTIAL'},
				{condition: () => true, handler: second, degradeLevel: 'OFFLINE'}
			]}
		})

		await expect(runtime.execute(
			{operation: 'fallback-chain', policy: 'test', context},
			async() => { throw new Error('primary') }
		)).resolves.toBe('secondary recovery')
		expect(first).toHaveBeenCalledOnce()
		expect(second).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('preserves authoritative cancellation while fallback physical work settles', async() => {
		let release!: () => void
		const handler = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve('late fallback') }))
		const runtime = createCustomResilience({
			clock,
			policies: [policy({retry: false, circuitBreaker: false, fallback: 'slow-fallback'})],
			fallbacks: {['slow-fallback']: [{condition: () => true, handler, degradeLevel: 'PARTIAL'}]}
		})
		const operation = runtime.execute(
			{operation: 'cancel-fallback', policy: 'test', context},
			async() => { throw new Error('primary') }
		)
		await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
		const shutdown = runtime.shutdown()
		await expect(operation).rejects.toMatchObject({name: 'AbortError', code: 'ABORT_ERR'})
		release()
		await shutdown
	})

	it('sanitizes primary and fallback failures in the aggregate error', async() => {
		const runtime = createCustomResilience({
			clock,
			policies: [policy({retry: false, fallback: 'failed'})],
			fallbacks: {failed: [{condition: () => true, handler: () => { throw new Error('fallback-secret') }, degradeLevel: 'OFFLINE'}]}
		})
		const error = await runtime.execute({operation: 'fallback', policy: 'test', context}, async() => {
			throw new Error('primary-secret')
		}).catch((failure: unknown) => failure)
		expect(error).toBeInstanceOf(AggregateError)
		expect(JSON.stringify(error)).not.toContain('secret')
		expect((error as AggregateError).cause).toMatchObject({message: 'Resilience primary operation failed'})
		await runtime.shutdown()
	})

	it('emits exactly the six bounded resilience self-metric families', async() => {
		const names = new Set<string>()
		let cleanupAttempts = 0
		const runtime = createProductionResilience({
			clock,
			policies: [policy({circuitBreaker: {...breaker, failureCountThreshold: 1}})],
			metrics: {
				increment: (name) => { names.add(name) },
				record: (name) => { names.add(name) }
			},
			lifecycle: {
				getStatus: () => ({state: 'running', health: 'healthy', activeHooks: 0, failedChecks: 0}),
				registerFlushHook: () => () => undefined,
				registerHealthCheck: () => () => undefined,
				recordDegradation: () => undefined,
				clearDegradation: () => undefined,
				registerShutdownHook: () => async() => { if (++cleanupAttempts === 1) throw new Error('cleanup failed') }
			}
		})
		await expect(runtime.execute({operation: 'failure', policy: 'test', context}, async() => {
			throw Object.assign(new Error('down'), {status: 429, retryAfter: '0.001'})
		})).rejects.toBeDefined()
		await expect(runtime.execute({operation: 'rejected', policy: 'test', context}, async() => 'never')).rejects.toMatchObject({code: 'RESILIENCE_BREAKER_OPEN'})
		await expect(runtime.shutdown()).rejects.toThrow('cleanup failed')
		await runtime.shutdown()
		expect([...names].sort()).toEqual([
			'_resilience_active_operations',
			'_resilience_executions_total',
			'_resilience_finalization_failures_total',
			'_resilience_queued_operations',
			'_resilience_rejections_total',
			'_resilience_retries_total'
		])
	})
})
