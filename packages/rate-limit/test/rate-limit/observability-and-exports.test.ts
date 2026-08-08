import {readFileSync} from 'node:fs'

import {createContainer} from '@ooopsstudio/core/runtime/container'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {decisionTo429ResponseMeta, decisionToHeaders} from '../../src/rate-limit/http'
import {registerRateLimit} from '../../src/rate-limit/index'
import {createDevelopmentRateLimit} from '../../src/rate-limit/public/development'
import {
	attachRateLimitObservability,
	type RateLimitObservabilityEvent
} from '../../src/rate-limit/public/observability'

describe('rate-limit observability and exports', () => {
	it('emits bounded raw events and isolates observers', async() => {
		const runtime = createDevelopmentRateLimit({
			clock: createFixedClock(0),
			policies: [{name: 'dynamic-looking-but-bootstrap', partition: 'keyed', limit: 1, windowMs: 1_000}]
		})
		const events: RateLimitObservabilityEvent[] = []
		const dispose = attachRateLimitObservability(runtime, (event) => {
			events.push(event)
			if (event.kind === 'active_operations') throw new Error('isolated')
		})
		await runtime.check({policy: 'dynamic-looking-but-bootstrap', key: 'secret-user'})
		await runtime.check({policy: 'dynamic-looking-but-bootstrap', key: 'secret-user'})
		expect(events.some(({kind}) => kind === 'check')).toBe(true)
		expect(events.some(({kind}) => kind === 'rejection')).toBe(true)
		expect(events.some(({kind}) => kind === 'active_operations')).toBe(true)
		expect(JSON.stringify(events)).not.toContain('dynamic-looking')
		expect(JSON.stringify(events)).not.toContain('secret-user')
		expect(() => attachRateLimitObservability(runtime, vi.fn())).toThrow('already attached')
		dispose()
		dispose()
		expect(() => attachRateLimitObservability(runtime, vi.fn())).not.toThrow()
	})

	it('contains observer re-entry and rejected async observers', async() => {
		const runtime = createDevelopmentRateLimit({
			clock: createFixedClock(0),
			policies: [{name: 'api', partition: 'global', limit: 10, windowMs: 1_000}]
		})
		let depth = 0
		let maximumDepth = 0
		let triggered = false
		const rejected = Promise.reject(new Error('observer failed'))
		const listener = vi.fn(() => {
			depth += 1
			maximumDepth = Math.max(maximumDepth, depth)
			if (!triggered) {
				triggered = true
				void runtime.check({policy: 'api'})
			}
			depth -= 1
			return rejected
		})
		const dispose = attachRateLimitObservability(runtime, listener as never)
		try {
			await runtime.check({policy: 'api'})
			await rejected.catch(() => undefined)
			await Promise.resolve()
			expect(maximumDepth).toBe(1)
			expect(listener).toHaveBeenCalled()
		} finally {
			dispose()
			await runtime.shutdown()
		}
	})

	it('recovers a replacement observer after the previous listener times out', async() => {
		vi.useFakeTimers()
		try {
			const runtime = createDevelopmentRateLimit({
				clock: createFixedClock(0),
				policies: [{name: 'api', partition: 'global', limit: 10, windowMs: 1_000}]
			})
			const stalled = vi.fn(() => new Promise<void>(() => undefined))
			const disposeStalled = attachRateLimitObservability(runtime, stalled as never)
			await runtime.check({policy: 'api'})
			expect(stalled).toHaveBeenCalledOnce()
			await vi.advanceTimersByTimeAsync(5_000)
			disposeStalled()

			const recovered = vi.fn()
			const disposeRecovered = attachRateLimitObservability(runtime, recovered)
			await runtime.check({policy: 'api'})
			expect(recovered).toHaveBeenCalled()
			disposeRecovered()
			await runtime.shutdown()
		} finally {
			vi.useRealTimers()
		}
	})

	it('projects frozen HTTP metadata directly from a decision', async() => {
		const runtime = createDevelopmentRateLimit({
			clock: createFixedClock(1_000),
			policies: [{name: 'api', partition: 'global', limit: 1, windowMs: 1_000}]
		})
		await runtime.check({policy: 'api'})
		const blocked = await runtime.check({policy: 'api'})
		expect(decisionToHeaders(blocked, 1_000)).toMatchObject({
			'RateLimit-Limit': '1', 'RateLimit-Reset': '1', 'Retry-After': '1'
		})
		const metadata = decisionTo429ResponseMeta(blocked, 1_000)
		expect(metadata).toMatchObject({status: 429, reason: 'rate_limit_exceeded', policy: 'api'})
		expect(Object.isFrozen(metadata)).toBe(true)
		expect(() => decisionToHeaders(blocked, Number.NaN)).toThrow('time values')
		const getPrototypeOf = vi.fn(() => Object.prototype)
		expect(() => decisionToHeaders(new Proxy(blocked, {getPrototypeOf}) as never, 1_000)).toThrow('plain object')
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('registers lazily and rolls back managed runtimes', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(0))
		await registerRateLimit(container, {
			preset: 'development',
			options: {policies: [{name: 'api', partition: 'global', limit: 1, windowMs: 1_000}]}
		})
		expect(container.get(TOK.RateLimit)).toMatchObject({check: expect.any(Function), shutdown: expect.any(Function)})
		const source = readFileSync(new URL('../../src/rate-limit/index.ts', import.meta.url), 'utf8')
		expect(source).not.toMatch(/^import (?!type).*\.\/public\/(development|production|custom)/mu)
		expect(source).toContain("await import('./public/development')")
	})

	it('awaits managed shutdown during registration rollback', async() => {
		const disposeLifecycle = vi.fn()
		const lifecycle = {
			registerShutdownHook: vi.fn(() => disposeLifecycle)
		}
		const container = {
			has: vi.fn(() => false),
			get: vi.fn(() => createFixedClock(0)),
			tryGet: vi.fn((token: symbol) => token === TOK.Lifecycle ? lifecycle : undefined),
			bind: vi.fn(() => { throw new Error('bind failed') }),
			unbind: vi.fn(() => true)
		}
		await expect(registerRateLimit(container as never, {
			preset: 'development',
			options: {policies: [{name: 'api', partition: 'global', limit: 1, windowMs: 1_000}]}
		})).rejects.toThrow('bind failed')
		expect(disposeLifecycle).toHaveBeenCalledOnce()
	})

	it('rejects concurrent registration before asynchronous preset loading', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(0))
		const configuration = {
			preset: 'development' as const,
			options: {policies: [{name: 'api', partition: 'global' as const, limit: 1, windowMs: 1_000}]}
		}
		const first = registerRateLimit(container, configuration)
		await expect(registerRateLimit(container, configuration)).rejects.toThrow('ALREADY_REGISTERED')
		await first
	})

	it('rolls back a substituted container binding', async() => {
		let retained: unknown
		const unbind = vi.fn(() => { retained = undefined; return true })
		const container = {
			has: vi.fn(() => retained !== undefined),
			get: vi.fn(() => createFixedClock(0)),
			tryGet: vi.fn((token: symbol) => token === TOK.RateLimit ? retained : undefined),
			bind: vi.fn(() => { retained = Object.freeze({substituted: true}) }),
			unbind
		}
		await expect(registerRateLimit(container as never, {
			preset: 'development',
			options: {policies: [{name: 'api', partition: 'global', limit: 1, windowMs: 1_000}]}
		})).rejects.toThrow('did not retain')
		expect(unbind).toHaveBeenCalledWith(TOK.RateLimit)
		expect(retained).toBeUndefined()
	})

	it('removes patterns and legacy public contracts from package exports', () => {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {exports: Record<string, unknown>}
		expect(manifest.exports).not.toHaveProperty('./patterns')
		expect(manifest.exports).toHaveProperty('./http')
		expect(manifest.exports).toHaveProperty('./observability')
		const core = readFileSync(new URL('../../../core/src/contracts/rate-limit.ts', import.meta.url), 'utf8')
		for (const removed of ['RateLimitRule', 'RateLimitContext', 'FixedWindowOptions', 'TokenBucketOptions', 'RateLimitCompositeDecision']) {
			expect(core).not.toContain(`interface ${removed}`)
		}
	})
})
