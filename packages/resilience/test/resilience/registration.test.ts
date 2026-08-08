
import {createContainer} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerResilience} from '../../src/resilience'
import type {ManagedResilience} from '../../src/resilience/public/types'

describe('resilience registration', () => {
	it('dynamically registers and lifecycle-shuts down one managed runtime', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, {now: () => Date.now()})
		let shutdownHook: (() => Promise<void>) | undefined
		container.bind(TOK.Lifecycle, {registerShutdownHook: (_group: string, hook: () => Promise<void>) => { shutdownHook = hook; return () => undefined }})
		await registerResilience(container, {preset: 'production'})
		const runtime = container.get<ManagedResilience>(TOK.Resilience)
		expect(runtime.getStatus().state).toBe('running')
		await shutdownHook?.()
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('rejects duplicate and accessor registration boundaries', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, {now: () => 0})
		await registerResilience(container, {preset: 'development'})
		await expect(registerResilience(container, {preset: 'development'})).rejects.toThrow(/already registered/u)
		const other = createContainer(); other.bind(TOK.Clock, {now: () => 0})
		const hostile = Object.defineProperty({}, 'preset', {enumerable: true, get: () => 'production'})
		await expect(registerResilience(other, hostile as never)).rejects.toThrow(/unexpected/u)

		const nestedGetter = vi.fn(() => [])
		const nested = Object.defineProperty({}, 'policies', {enumerable: true, get: nestedGetter})
		await expect(registerResilience(other, {preset: 'production', options: nested as never}))
			.rejects.toThrow(/Unsafe resilience preset options/u)
		expect(nestedGetter).not.toHaveBeenCalled()
	})

	it('does not execute thenable methods returned by synchronous container capabilities', async() => {
		const then = vi.fn()
		const hostile = {then}
		const container = {
			has: () => hostile,
			get: () => ({now: () => 0}),
			tryGet: () => undefined,
			bind: () => undefined,
			unbind: () => true
		}
		await expect(registerResilience(container as never, {preset: 'development'}))
			.rejects.toThrow(/must return a boolean/u)
		expect(then).not.toHaveBeenCalled()
	})

	it('does not assimilate custom thenables returned by container mutations', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
		const then = vi.fn()
		const container = {
			has: (token: symbol) => values.has(token),
			get: (token: symbol) => values.get(token),
			tryGet: (token: symbol) => values.get(token),
			bind: (token: symbol, value: unknown) => { values.set(token, value); return {then} },
			unbind: (token: symbol) => { values.delete(token); return {then} }
		}
		await registerResilience(container as never, {preset: 'development', options: {policies: [{
			name: 'captured-port-policy', operationKind: 'external.http', timeout: {defaultMs: 100},
			retry: false, circuitBreaker: false
		}]}})
		expect(then).not.toHaveBeenCalled()
		await (values.get(TOK.Resilience) as ManagedResilience).shutdown()
	})

	it('rejects wide registration data without materializing descriptor maps', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, {now: () => 0})
		const wide = Object.fromEntries(Array.from({length: 20_000}, (_, index) => [`field${index}`, index]))
		const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors')
		await expect(registerResilience(container, wide as never)).rejects.toThrow(/unexpected/u)
		expect(descriptors.mock.calls.some(([value]) => value === wide)).toBe(false)
		descriptors.mockRestore()
	})

	it('snapshots nested policy data before the dynamic import hop', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, {now: () => 0})
		const configuredPolicy = {
			name: 'snapshot-policy',
			operationKind: 'external.http' as const,
			timeout: {defaultMs: 100},
			retry: false as const,
			circuitBreaker: false as const
		}
		const policies = [configuredPolicy]

		const registration = registerResilience(container, {preset: 'production', options: {policies}})
		configuredPolicy.name = 'mutated-policy'
		configuredPolicy.timeout.defaultMs = 1
		policies.splice(0)
		await registration

		const runtime = container.get<ManagedResilience>(TOK.Resilience)
		await expect(runtime.execute({
			operation: 'snapshot', policy: 'snapshot-policy', context: {resource: 'registration'}
		}, async() => 'stable')).resolves.toBe('stable')
		await runtime.shutdown()
	})

	it('snapshots policies before invoking reentrant container capabilities', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
		const configuredPolicy = {
			name: 'registration-boundary', operationKind: 'external.http' as const,
			timeout: {defaultMs: 100}, retry: false as const, circuitBreaker: false as const
		}
		const options = {preset: 'production' as const, options: {policies: [configuredPolicy]}}
		let mutated = false
		const container = {
			has: (token: symbol) => {
				if (token === TOK.Resilience && !mutated) {
					mutated = true
					configuredPolicy.name = 'redirected-policy'
				}
				return values.has(token)
			},
			get: (token: symbol) => values.get(token),
			tryGet: (token: symbol) => values.get(token),
			bind: (token: symbol, value: unknown) => { values.set(token, value) },
			unbind: (token: symbol) => values.delete(token)
		}

		await registerResilience(container as never, options)
		const runtime = values.get(TOK.Resilience) as ManagedResilience
		await expect(runtime.execute({
			operation: 'snapshot', policy: 'registration-boundary', context: {resource: 'registration'}
		}, async() => 'stable')).resolves.toBe('stable')
		await runtime.shutdown()
	})

	it('captures injected clock and lifecycle methods before later lookups can replace them', async() => {
		const originalNow = vi.fn(() => 7)
		const replacementNow = vi.fn(() => 99)
		const originalHook = vi.fn(() => () => undefined)
		const replacementHook = vi.fn(() => () => undefined)
		const clock = {now: originalNow}
		const lifecycle = {registerShutdownHook: originalHook}
		const values = new Map<symbol, unknown>([[TOK.Clock, clock], [TOK.Lifecycle, lifecycle]])
		const container = {
			has: (token: symbol) => values.has(token),
			get: (token: symbol) => values.get(token),
			tryGet: (token: symbol) => {
				if (token === TOK.Lifecycle) clock.now = replacementNow
				if (token === TOK.Performance) lifecycle.registerShutdownHook = replacementHook
				return values.get(token)
			},
			bind: (token: symbol, value: unknown) => { values.set(token, value) },
			unbind: (token: symbol) => values.delete(token)
		}

		await registerResilience(container as never, {preset: 'development'})
		expect(originalHook).toHaveBeenCalledOnce()
		expect(replacementHook).not.toHaveBeenCalled()
		const runtime = values.get(TOK.Resilience) as ManagedResilience
		await expect(runtime.execute({
			operation: 'captured-clock', policy: 'external.http', context: {resource: 'registration'}
		}, async() => 'stable')).resolves.toBe('stable')
		expect(replacementNow).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('preserves shared fallback identity so registration rejects duplicate execution', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, {now: () => 0})
		const strategy = {condition: () => true, handler: () => 'fallback', degradeLevel: 'PARTIAL' as const}

		await expect(registerResilience(container, {
			preset: 'custom',
			options: {
				policies: [{
					name: 'duplicate-fallback', operationKind: 'external.http',
					timeout: {defaultMs: 100}, retry: false, circuitBreaker: false,
					fallback: 'duplicate'
				}],
				fallbacks: {duplicate: [strategy, strategy]}
			}
		})).rejects.toThrow(/Duplicate fallback strategy/u)
		expect(container.has(TOK.Resilience)).toBe(false)
	})

	it('does not replace malformed injected clock or lifecycle dependencies with defaults', async() => {
		const invalidClock = createContainer()
		invalidClock.bind(TOK.Clock, null as never)
		await expect(registerResilience(invalidClock, {preset: 'production'})).rejects.toThrow(/clock\.now/u)
		expect(invalidClock.has(TOK.Resilience)).toBe(false)

		const invalidLifecycle = createContainer()
		invalidLifecycle.bind(TOK.Clock, {now: () => 0})
		invalidLifecycle.bind(TOK.Lifecycle, {} as never)
		await expect(registerResilience(invalidLifecycle, {preset: 'production'}))
			.rejects.toThrow(/Invalid port/u)
		expect(invalidLifecycle.has(TOK.Resilience)).toBe(false)

		const invalidErrors = createContainer()
		invalidErrors.bind(TOK.Clock, {now: () => 0})
		invalidErrors.bind(TOK.Errors, {} as never)
		await expect(registerResilience(invalidErrors, {preset: 'production'}))
			.rejects.toThrow(/Invalid port/u)
		expect(invalidErrors.has(TOK.Resilience)).toBe(false)
	})

	it('atomically removes a binding when bind mutates before throwing', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
		const dispose = vi.fn()
		values.set(TOK.Lifecycle, {registerShutdownHook: () => dispose})
		const container = {
			has: (token: symbol) => token === TOK.Resilience ? false : values.has(token),
			get: (token: symbol) => values.get(token),
			tryGet: (token: symbol) => values.get(token),
			unbind: (token: symbol) => values.delete(token),
			bind: async(token: symbol, value: unknown) => {
				values.set(token, value)
				if (token === TOK.Resilience) throw new Error('bind failed after mutation')
			}
		}

		await expect(registerResilience(container as never, {preset: 'development'}))
			.rejects.toThrow('bind failed after mutation')
		expect(values.has(TOK.Resilience)).toBe(false)
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('does not remove a concurrent foreign binding when an async bind fails', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
		let rejectBind!: (error: unknown) => void
		const foreign = Object.freeze({owner: 'other-registration'})
		const container = {
			has: (token: symbol) => values.has(token),
			get: (token: symbol) => values.get(token),
			tryGet: (token: symbol) => values.get(token),
			unbind: (token: symbol) => values.delete(token),
			bind: (token: symbol, value: unknown) => token === TOK.Resilience
				? new Promise<void>((_resolve, reject) => { rejectBind = reject })
				: values.set(token, value)
		}

		const registration = registerResilience(container as never, {preset: 'development'})
		await vi.waitFor(() => expect(typeof rejectBind).toBe('function'))
		values.set(TOK.Resilience, foreign)
		rejectBind(new Error('late bind failure'))

		await expect(registration).rejects.toThrow('late bind failure')
		expect(values.get(TOK.Resilience)).toBe(foreign)
	})

	it('does not remove a foreign binding installed reentrantly before bind throws', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
		const foreign = Object.freeze({owner: 'reentrant-registration'})
		const unbind = vi.fn((token: symbol) => values.delete(token))
		const container = {
			has: (token: symbol) => values.has(token),
			get: (token: symbol) => values.get(token),
			tryGet: (token: symbol) => values.get(token),
			unbind,
			bind: (token: symbol, value: unknown) => {
				if (token === TOK.Resilience) {
					values.set(token, foreign)
					throw new Error('bind failed after foreign registration')
				}
				values.set(token, value)
			}
		}

		await expect(registerResilience(container as never, {preset: 'development'}))
			.rejects.toThrow('bind failed after foreign registration')
		expect(values.get(TOK.Resilience)).toBe(foreign)
		expect(unbind).not.toHaveBeenCalled()
	})

	it('does not unbind when container presence has no observable binding identity', async() => {
		let bound = false
		const unbind = vi.fn(() => { bound = false; return true })
		const container = {
			has: (token: symbol) => token === TOK.Resilience ? bound : token === TOK.Clock,
			get: (token: symbol) => token === TOK.Clock ? {now: () => 0} : undefined,
			tryGet: (token: symbol) => token === TOK.Clock ? {now: () => 0} : undefined,
			bind: (token: symbol) => { if (token === TOK.Resilience) bound = true },
			unbind
		}

		await expect(registerResilience(container as never, {preset: 'development'}))
			.rejects.toThrow('container binding failed')
		expect(unbind).not.toHaveBeenCalled()
		expect(bound).toBe(true)
	})

	it('removes its exact binding when an async bind installs it before rejecting', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
		const container = {
			has: (token: symbol) => values.has(token),
			get: (token: symbol) => values.get(token),
			tryGet: (token: symbol) => values.get(token),
			bind: async(token: symbol, value: unknown) => {
				await Promise.resolve()
				values.set(token, value)
				throw new Error('late bind failure')
			},
			unbind: (token: symbol) => values.delete(token)
		}

		await expect(registerResilience(container as never, {preset: 'development'})).rejects.toThrow('late bind failure')
		expect(values.has(TOK.Resilience)).toBe(false)
	})

	it('preserves a substituted binding that cannot be proven to be runtime-owned', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, {now: () => 0}]])
		const foreign = Object.freeze({owner: 'container-substitution'})
		const substituted = {
			has: (token: symbol) => values.has(token),
			get: (token: symbol) => values.get(token),
			tryGet: (token: symbol) => values.get(token),
			unbind: (token: symbol) => values.delete(token),
			bind: (token: symbol, value: unknown) => values.set(token, token === TOK.Resilience ? foreign : value)
		}
		await expect(registerResilience(substituted as never, {preset: 'development'}))
			.rejects.toThrow('container binding failed')
		expect(values.get(TOK.Resilience)).toBe(foreign)
	})
})
