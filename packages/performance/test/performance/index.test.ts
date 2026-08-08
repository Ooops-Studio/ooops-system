import {createContainer} from '@ooopsstudio/core/runtime/container'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerPerformance} from '../../src/performance'

const container = () => {
	const value = createContainer()
	value.bind(TOK.Clock, createFixedClock(100))
	return value
}

describe('registerPerformance', () => {
	it('validates the container, registration shape, and dependency lookups', async() => {
		await expect(registerPerformance(null as never, {preset: 'production'})).rejects.toThrow('valid container')
		const descriptorTrap = vi.fn(() => { throw new Error('must not inspect') })
		const proxyContainer = new Proxy({}, {getOwnPropertyDescriptor: descriptorTrap})
		await expect(registerPerformance(proxyContainer as never, {preset: 'production'}))
			.rejects.toThrow('reversible container')
		expect(descriptorTrap).not.toHaveBeenCalled()
		const inheritedTrap = vi.fn(() => { throw new Error('must not inspect') })
		const inheritedProxyContainer = Object.create(new Proxy({}, {getOwnPropertyDescriptor: inheritedTrap}))
		await expect(registerPerformance(inheritedProxyContainer as never, {preset: 'production'}))
			.rejects.toThrow('reversible container')
		expect(inheritedTrap).not.toHaveBeenCalled()
		const asyncHas = {
			has: () => Promise.reject(new Error('async has')),
			get: () => createFixedClock(1), tryGet: () => undefined,
			bind: vi.fn(), unbind: vi.fn(() => true)
		}
		await expect(registerPerformance(asyncHas as never, {preset: 'production'}))
			.rejects.toThrow('performance_container_lookup_failed')
		await Promise.resolve()
		const lookupFailure = {
			has: () => { throw new Error('secret lookup detail') },
			get: () => createFixedClock(1), tryGet: () => undefined,
			bind: vi.fn(), unbind: vi.fn()
		}
		await expect(registerPerformance(lookupFailure as never, {preset: 'production'}))
			.rejects.toThrow('performance_container_lookup_failed')

		const missingClock = {
			has: () => false, get: () => undefined, tryGet: () => undefined,
			bind: vi.fn(), unbind: vi.fn()
		}
		await expect(registerPerformance(missingClock as never, {preset: 'production'}))
			.rejects.toThrow('performance_invalid_clock')

		const dependencyFailure = {
			has: () => false, get: () => createFixedClock(1),
			tryGet: (token: symbol) => {
				if (token === TOK.Performance) return undefined
				throw new Error('secret dependency detail')
			},
			bind: vi.fn(), unbind: vi.fn()
		}
		await expect(registerPerformance(dependencyFailure as never, {preset: 'production'}))
			.rejects.toThrow('performance_dependency_resolution_failed')

		const value = container()
		await expect(registerPerformance(value, {preset: 'custom'} as never)).rejects.toThrow('custom registration options')
		await expect(registerPerformance(value, {preset: 'production', extra: true} as never)).rejects.toThrow('stable plain data fields')
		const symbolic = {[Symbol('hidden')]: true, preset: 'production'}
		await expect(registerPerformance(value, symbolic as never)).rejects.toThrow('stable plain data fields')
	})
	it('rejects unknown presets without binding a handler', async() => {
		const value = container()
		await expect(registerPerformance(value, {preset: 'invalid'} as never)).rejects.toThrow('Unknown performance preset')
		const hostilePreset = {toString: () => { throw new Error('must not be coerced') }}
		await expect(registerPerformance(value, {preset: hostilePreset} as never)).rejects.toThrow('Unknown performance preset')
		expect(value.has(TOK.Performance)).toBe(false)
	})

	it('rejects oversized registration keys before policy lookup', async() => {
		const oversizedKey = 'x'.repeat(1_048_577)
		const setHas = vi.spyOn(Set.prototype, 'has')
		try {
			await expect(registerPerformance(container(), {
				preset: 'production', [oversizedKey]: true
			} as never)).rejects.toThrow('stable plain data fields')
			expect(setHas.mock.calls.some(([value]) => value === oversizedKey)).toBe(false)
		} finally {
			setHas.mockRestore()
		}
	})

	it('registers development and production', async() => {
		const development = container()
		await registerPerformance(development, {preset: 'development'})
		expect(development.has(TOK.Performance)).toBe(true)
		await development.get(TOK.Performance).shutdown?.()
		const production = container()
		await registerPerformance(production, {preset: 'production'})
		expect(production.has(TOK.Performance)).toBe(true)
		await production.get(TOK.Performance).shutdown?.()
	})

	it('requires custom options and registers custom budgets', async() => {
		const value = container()
		await registerPerformance(value, {preset: 'custom', options: {budgets: [{name: 'request', target: 10, window: 100}]}})
		expect(value.get(TOK.Performance).getBudgetStatus?.('request')).toBeDefined()
		await value.get(TOK.Performance).shutdown?.()
	})

	it('resolves every optional observability dependency from the container', async() => {
		const value = container()
		value.bind(TOK.Logging, {level: 'info', trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn()} as never)
		value.bind(TOK.Errors, {report: vi.fn()})
		value.bind(TOK.Metrics, {increment: vi.fn()} as never)
		value.bind(TOK.Tracing, {getActiveSpan: vi.fn(), currentTraceId: vi.fn(), inSpan: vi.fn()} as never)
		value.bind(TOK.Lifecycle, {registerShutdownHook: vi.fn()} as never)
		await registerPerformance(value, {preset: 'production'})
		expect(value.has(TOK.Performance)).toBe(true)
		await value.get(TOK.Performance).shutdown?.()
	})

	it('does not resolve the custom-only metrics dependency for lean presets', async() => {
		let retained: unknown
		const value = {
			has: (token: symbol) => token === TOK.Performance && retained !== undefined,
			get: () => createFixedClock(100),
			tryGet: (token: symbol) => {
				if (token === TOK.Performance) return retained
				if (token === TOK.Metrics) throw new Error('metrics lookup must not run')
				return undefined
			},
			bind: (_token: symbol, handler: unknown) => { retained = handler },
			unbind: () => { retained = undefined; return true }
		}

		await expect(registerPerformance(value as never, {preset: 'production'})).resolves.toBeUndefined()
		await (retained as {shutdown?: () => Promise<void>}).shutdown?.()
	})

	it('rejects removed preset options instead of silently ignoring them', async() => {
		const value = container()
		await expect(registerPerformance(value, {
			preset: 'production', options: {metrics: {record: vi.fn()}} as never
		})).rejects.toThrow('stable plain data fields')
		expect(value.has(TOK.Performance)).toBe(false)
	})

	it('rejects concurrent and duplicate registrations', async() => {
		const value = container()
		const first = registerPerformance(value, {preset: 'production'})
		await expect(registerPerformance(value, {preset: 'production'})).rejects.toThrow('already_registered')
		await first
		await expect(registerPerformance(value, {preset: 'production'})).rejects.toThrow('already_registered')
		await value.get(TOK.Performance).shutdown?.()
	})

	it('fences re-entrant registration before invoking container callbacks', async() => {
		const base = container()
		const configuration = {preset: 'production' as const}
		let nested: Promise<void> | undefined
		let reentered = false
		const value = {
			...base,
			has: (token: symbol) => {
				if (!reentered) {
					reentered = true
					nested = registerPerformance(value, configuration)
					void nested.catch(() => undefined)
				}
				return base.has(token)
			}
		}

		await registerPerformance(value, configuration)
		await expect(nested).rejects.toThrow('performance_already_registered')
		expect(base.has(TOK.Performance)).toBe(true)
		await base.get(TOK.Performance).shutdown?.()
	})

	it('cleans up a newly created handler when container binding fails', async() => {
		const shutdown = vi.fn(async() => {})
		const clock = createFixedClock(100)
		const failing = {
			has: () => false,
			get: () => clock,
			tryGet: () => undefined,
			bind: () => { throw new Error('bind failed') },
			unbind: () => false
		}
		await expect(registerPerformance(failing as never, {
			preset: 'custom',
			options: {
				budgets: [{name: 'request', target: 10, window: 100}],
				destinations: [{name: 'cleanup', exporter: {export: vi.fn(), shutdown}}],
				delivery: {flushIntervalMs: 0}
			}
		})).rejects.toThrow('bind failed')
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('rolls back a binding that is retained before bind throws', async() => {
		const clock = createFixedClock(100)
		let retained: unknown
		const value = {
			has: (token: symbol) => token === TOK.Performance && retained !== undefined,
			get: () => clock,
			tryGet: (token: symbol) => token === TOK.Performance ? retained : undefined,
			bind: (_token: symbol, handler: unknown) => {
				retained = handler
				throw new Error('late bind failure')
			},
			unbind: () => {
				retained = undefined
				return true
			}
		}
		await expect(registerPerformance(value as never, {preset: 'production'}))
			.rejects.toThrow('late bind failure')
		expect(retained).toBeUndefined()
	})

	it('does not remove a foreign binding exposed by a failed bind race', async() => {
		const clock = createFixedClock(100)
		const foreign = {record: vi.fn()}
		let retained: unknown
		const unbind = vi.fn(() => { retained = undefined; return true })
		const value = {
			has: () => false,
			get: () => clock,
			tryGet: (token: symbol) => token === TOK.Performance ? retained : undefined,
			bind: () => {
				retained = foreign
				throw new Error('concurrent binding won')
			},
			unbind
		}

		await expect(registerPerformance(value as never, {preset: 'production'}))
			.rejects.toThrow('concurrent binding won')
		expect(retained).toBe(foreign)
		expect(unbind).not.toHaveBeenCalled()
	})

	it('rolls back even when post-bind inspection throws', async() => {
		const clock = createFixedClock(100)
		let retained: unknown
		let failInspection = false
		const value = {
			has: (token: symbol) => {
				if (failInspection) throw new Error('post-bind inspection failed')
				return token === TOK.Performance && retained !== undefined
			},
			get: () => clock,
			tryGet: (token: symbol) => token === TOK.Performance ? retained : undefined,
			bind: (_token: symbol, handler: unknown) => {
				retained = handler
				failInspection = true
			},
			unbind: () => {
				retained = undefined
				failInspection = false
				return true
			}
		}

		await expect(registerPerformance(value as never, {preset: 'production'}))
			.rejects.toThrow('post-bind inspection failed')
		expect(retained).toBeUndefined()
	})

	it('does not overwrite a binding exposed only through tryGet', async() => {
		const existing = {record: vi.fn()}
		const value = {
			has: () => false,
			get: () => createFixedClock(100),
			tryGet: (token: symbol) => token === TOK.Performance ? existing : undefined,
			bind: vi.fn(),
			unbind: vi.fn()
		}

		await expect(registerPerformance(value as never, {preset: 'production'}))
			.rejects.toThrow('already_registered')
		expect(value.bind).not.toHaveBeenCalled()
	})

	it('rejects accessor-backed registration data and non-reversible containers', async() => {
		const value = container()
		const accessor = Object.defineProperty({}, 'preset', {
			enumerable: true,
			get: () => 'production'
		})
		await expect(registerPerformance(value, accessor as never)).rejects.toThrow('stable plain data fields')
		await expect(registerPerformance({
			has: () => false,
			get: () => createFixedClock(1),
			tryGet: () => undefined,
			bind: vi.fn()
		} as never, {preset: 'production'})).rejects.toThrow('reversible container')
	})
})
