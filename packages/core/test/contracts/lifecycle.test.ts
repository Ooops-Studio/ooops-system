import {describe, expect, it, vi} from 'vitest'

import {
	LifecycleError,
	LifecycleShutdownTimeoutError,
	LifecycleStartupError
} from '../../src/contracts/lifecycle'

describe('lifecycle runtime errors', () => {
	it('does not coerce hostile messages or execute option accessors', () => {
		const coerce = vi.fn(() => 'hostile')
		const cause = vi.fn(() => new Error('hidden'))
		const options = Object.defineProperty({}, 'cause', {get: cause})

		const error = new LifecycleError({[Symbol.toPrimitive]: coerce} as never, options)

		expect(error.message).toBe('Lifecycle operation failed')
		expect(error).not.toHaveProperty('cause')
		expect(coerce).not.toHaveBeenCalled()
		expect(cause).not.toHaveBeenCalled()
	})

	it('rejects proxied options before inspection traps', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const options = new Proxy({state: 'running' as const}, {getOwnPropertyDescriptor})

		const error = new LifecycleError('failure', options)

		expect(error.state).toBeUndefined()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})

	it('contains rejected native promise causes and validates state fields', async() => {
		const cause = Promise.reject(new Error('lifecycle rejected'))
		const error = new LifecycleStartupError('failure', {
			cause, state: 'running', health: 'degraded'
		})

		expect(error).toMatchObject({name: 'LifecycleStartupError', cause, state: 'running', health: 'degraded'})
		expect(new LifecycleShutdownTimeoutError('timeout').name).toBe('LifecycleShutdownTimeoutError')
		expect(new LifecycleError('failure', {state: 'invalid' as never, health: 'invalid' as never}))
			.not.toMatchObject({state: 'invalid', health: 'invalid'})
		await Promise.resolve()
	})

	it('contains rejected promises supplied as messages and options', async() => {
		const message = Promise.reject(new Error('message rejected'))
		const options = Promise.reject(new Error('options rejected'))
		expect(new LifecycleError(message as never).message).toBe('Lifecycle operation failed')
		expect(new LifecycleError('failure', options as never)).not.toHaveProperty('cause')
		await Promise.resolve()
	})

	it('contains nested option failures after descriptor inspection is rewired', async() => {
		const defineProperty = Object.defineProperty
		const descriptor = Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor')!
		const cause = Promise.reject(new Error('cause rejected'))
		let error: LifecycleError | undefined
		let thrown: unknown
		try {
			defineProperty(Object, 'getOwnPropertyDescriptor', {
				configurable: true, value: () => { throw new Error('poisoned descriptor') }
			})
			try { error = new LifecycleError('failure', {cause, state: 'running'}) }
			catch(failure) { thrown = failure }
		} finally { defineProperty(Object, 'getOwnPropertyDescriptor', descriptor) }

		expect(thrown).toBeUndefined()
		expect(error).toMatchObject({cause, state: 'running'})
		await Promise.resolve()
	})
})
