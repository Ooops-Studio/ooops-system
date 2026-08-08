import {createContainer, type Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerLogging} from '../src'

const clock = {now: () => 1_000}

describe('logging registration ownership', () => {
	it('rejects missing, unknown, accessor, and unexpected registration fields', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		await expect(registerLogging(container, undefined as never)).rejects.toThrow('options are required')
		await expect(registerLogging(container, {preset: 'unknown'} as never)).rejects.toThrow('Unknown logging preset')
		await expect(registerLogging(container, {preset: 'development', extra: true} as never))
			.rejects.toThrow('invalid or unexpected fields')
		await expect(registerLogging(container, {preset: 'development', traceCorrelation: 'yes'} as never))
			.rejects.toThrow('invalid or unexpected fields')
		const getter = vi.fn(() => 'development')
		const hostile = Object.defineProperty({}, 'preset', {enumerable: true, get: getter})
		await expect(registerLogging(container, hostile as never)).rejects.toThrow('invalid or unexpected fields')
		expect(getter).not.toHaveBeenCalled()
	})

	it('requires reversible bindings and refuses duplicate registration', async() => {
		const base = createContainer()
		base.bind(TOK.Clock, clock)
		const irreversible = {...base, unbind: undefined} as Container
		await expect(registerLogging(irreversible, {preset: 'development'}))
			.rejects.toThrow('reversible container bindings')

		await registerLogging(base, {preset: 'development'})
		await expect(registerLogging(base, {preset: 'development'})).rejects.toThrow('already registered')
		await base.get<{shutdown(): Promise<void>}>(TOK.Logging).shutdown()
	})

	it('removes a partial binding and destroys its sink when bind throws', async() => {
		const base = createContainer()
		base.bind(TOK.Clock, clock)
		const close = vi.fn(async() => undefined)
		const sink = {write: vi.fn(), flush: vi.fn(async() => undefined), close}
		const container: Container = {
			...base,
			bind(token, value) {
				base.bind(token, value)
				if (token === TOK.Logging) throw new Error('bind failed')
			}
		}

		await expect(registerLogging(container, {
			preset: 'custom',
			options: {destinations: {stdout: false, remote: {provider: 'custom', sink}}}
		})).rejects.toThrow('bind failed')

		expect(base.has(TOK.Logging)).toBe(false)
		expect(close).toHaveBeenCalledOnce()
	})

	it('aggregates bind and cleanup failures without leaving its binding', async() => {
		const base = createContainer()
		base.bind(TOK.Clock, clock)
		const sink = {
			write: vi.fn(), flush: vi.fn(async() => undefined),
			close: vi.fn(async() => { throw new Error('close failed') })
		}
		const container: Container = {
			...base,
			bind(token, value) {
				base.bind(token, value)
				if (token === TOK.Logging) throw new Error('bind failed')
			}
		}

		const failure = await registerLogging(container, {
			preset: 'custom', options: {destinations: {stdout: false, remote: {provider: 'custom', sink}}}
		}).catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(AggregateError)
		expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
			expect.objectContaining({message: 'bind failed'}),
			expect.anything()
		]))
		expect(base.has(TOK.Logging)).toBe(false)
	})

	it('rejects a container that silently discards the binding', async() => {
		const base = createContainer()
		base.bind(TOK.Clock, clock)
		const container: Container = {
			...base,
			bind(token, value) {
				if (token !== TOK.Logging) base.bind(token, value)
			}
		}
		await expect(registerLogging(container, {preset: 'development'}))
			.rejects.toThrow('did not retain')
		expect(base.has(TOK.Logging)).toBe(false)
	})

	it('removes its completed binding when ownership verification is unavailable', async() => {
		const base = createContainer()
		base.bind(TOK.Clock, clock)
		const close = vi.fn(async() => undefined)
		const sink = {write: vi.fn(), flush: vi.fn(async() => undefined), close}
		const container: Container = {
			...base,
			tryGet(token) {
				if (token === TOK.Logging) throw new Error('ownership read unavailable')
				return base.tryGet(token)
			}
		}

		await expect(registerLogging(container, {
			preset: 'custom',
			options: {destinations: {stdout: false, remote: {provider: 'custom', sink}}}
		})).rejects.toThrow('ownership read unavailable')

		expect(base.has(TOK.Logging)).toBe(false)
		expect(close).toHaveBeenCalledOnce()
	})
})
