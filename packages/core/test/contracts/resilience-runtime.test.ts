import {describe, expect, it, vi} from 'vitest'

import {
	ResilienceConfigurationError,
	ResilienceError,
	RetryExhaustedError,
	TimedOutError
} from '../../src/contracts/resilience-runtime'

const context = {resource: 'database'}

describe('resilience runtime errors', () => {
	it('does not coerce hostile public constructor values', () => {
		const coerce = vi.fn(() => 'hostile')
		const hostile = {[Symbol.toPrimitive]: coerce}

		const error = new ResilienceError(hostile as never, context, hostile as never, hostile as never)
		const timedOut = new TimedOutError(context, hostile as never, hostile as never)
		const configuration = new ResilienceConfigurationError(hostile as never, hostile as never)

		expect(coerce).not.toHaveBeenCalled()
		expect(error).toMatchObject({message: 'Resilience operation failed', code: 'RESILIENCE_FAILURE'})
		expect(Number.isFinite(error.timestamp)).toBe(true)
		expect(timedOut).toMatchObject({message: 'Operation timed out', timeoutMs: 0, code: 'RESILIENCE_TIMEOUT'})
		expect(configuration).toMatchObject({message: 'Invalid resilience configuration', code: 'RESILIENCE_INVALID_CONFIG'})
	})

	it('ignores accessor-backed ErrorOptions without reading the accessor', () => {
		const cause = vi.fn(() => new Error('hostile'))
		const options = Object.defineProperty({}, 'cause', {get: cause})

		const error = new ResilienceError('safe', context, 'SAFE_CODE', 10, options)

		expect(cause).not.toHaveBeenCalled()
		expect(error).not.toHaveProperty('cause')
	})

	it('preserves validated fields and an explicit retry cause', () => {
		const cause = new Error('offline')
		const timeout = new TimedOutError(context, 250, 100)
		const exhausted = new RetryExhaustedError(context, cause, 101)

		expect(timeout).toMatchObject({message: 'Operation timed out after 250ms', timeoutMs: 250, timestamp: 100})
		expect(exhausted).toMatchObject({cause, timestamp: 101, code: 'RESILIENCE_RETRY_EXHAUSTED'})
	})

	it('contains rejected native promises used as causes', async() => {
		const cause = Promise.reject(new Error('retry rejected'))
		const exhausted = new RetryExhaustedError(context, cause, 101)

		expect(exhausted).toMatchObject({cause, code: 'RESILIENCE_RETRY_EXHAUSTED'})
		await Promise.resolve()
	})

	it('contains rejected promises across resilience error fields', async() => {
		const message = Promise.reject(new Error('message rejected'))
		const metadata = Promise.reject(new Error('metadata rejected'))
		const timeout = Promise.reject(new Error('timeout rejected'))
		const configurationCode = Promise.reject(new Error('code rejected'))
		expect(new ResilienceError(message as never, {
			resource: 'database', metadata: {failure: metadata as never}
		}).context.resource).toBe('unknown')
		expect(new TimedOutError(context, timeout as never).timeoutMs).toBe(0)
		expect(new ResilienceConfigurationError(configurationCode as never, 'failure').code)
			.toBe('RESILIENCE_INVALID_CONFIG')
		await Promise.resolve()
	})

	it('bounds text validation after string iteration is rewired', () => {
		const iteratorDescriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!
		const charCodeDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!
		let error: ResilienceError | undefined
		const poison = (): never => { throw new Error('poisoned string intrinsic') }
		try {
			Object.defineProperties(String.prototype, {
				[Symbol.iterator]: {configurable: true, writable: true, value: poison},
				charCodeAt: {configurable: true, writable: true, value: poison}
			})
			error = new ResilienceError('safe', {resource: 'database'}, 'SAFE', 1)
		} finally {
			Object.defineProperty(String.prototype, Symbol.iterator, iteratorDescriptor)
			Object.defineProperty(String.prototype, 'charCodeAt', charCodeDescriptor)
		}

		expect(error).toMatchObject({message: 'safe', code: 'SAFE', context: {resource: 'database'}})
	})

	it('rejects proxied contexts and options before inspection traps', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const getPrototypeOf = vi.fn(() => null)
		const ownKeys = vi.fn(() => ['resource'])
		const hostile = new Proxy({resource: 'unsafe'}, {
			getOwnPropertyDescriptor,
			getPrototypeOf,
			ownKeys
		})

		const error = new ResilienceError('safe', hostile, 'SAFE', 1, hostile)

		expect(error.context).toEqual({resource: 'unknown'})
		expect(error).not.toHaveProperty('cause')
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
		expect(ownKeys).not.toHaveBeenCalled()
	})

	it('does not materialize inert symbol keys while snapshotting context and metadata', () => {
		const metadata = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`metadata-${index}`), index]
		)) as Record<string, string>
		Object.defineProperty(metadata, 'region', {value: 'eu', enumerable: true})
		const richContext = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`context-${index}`), index]
		)) as {resource?: string; metadata?: Record<string, string>}
		Object.defineProperties(richContext, {
			resource: {value: 'database', enumerable: true},
			metadata: {value: metadata, enumerable: true}
		})
		const ownKeys = vi.spyOn(Reflect, 'ownKeys')
		let error: ResilienceError
		try {
			error = new ResilienceError('safe', richContext as never, 'SAFE', 1)
		} finally { ownKeys.mockRestore() }

		expect(ownKeys).not.toHaveBeenCalled()
		expect(error!.context).toEqual({resource: 'database', metadata: {region: 'eu'}})
	})

	it('does not inherit forged identity and survives configuration intrinsics being rewired', () => {
		const defineProperty = Object.defineProperty
		const descriptor = Object.getOwnPropertyDescriptor
		const targets = [
			[Array, 'isArray'], [Math, 'abs'], [Number, 'isFinite'], [Number, 'isSafeInteger'],
			[Object, 'create'], [Object, 'freeze'], [Object, 'getOwnPropertyDescriptor'],
			[Object, 'getPrototypeOf']
		] as const
		const descriptors = targets.map(([owner, key]) => descriptor(owner, key)!)
		let error: ResilienceError | undefined
		let thrown: unknown
		defineProperty(Object.prototype, 'tenantId', {configurable: true, value: 'forged'})
		try {
			for (const [owner, key] of targets) defineProperty(owner, key, {
				configurable: true, value: () => { throw new Error(`poisoned ${key}`) }
			})
			try { error = new ResilienceError('safe', {resource: 'database'}, 'SAFE', 1) }
			catch(cause) { thrown = cause }
		} finally {
			for (let index = 0; index < targets.length; index += 1) {
				defineProperty(targets[index]![0], targets[index]![1], descriptors[index]!)
			}
			delete (Object.prototype as Record<string, unknown>).tenantId
		}

		expect(thrown).toBeUndefined()
		expect(error).toMatchObject({message: 'safe', code: 'SAFE', context: {resource: 'database'}})
		expect(Object.getPrototypeOf(error!.context)).toBeNull()
		expect(error!.context.tenantId).toBeUndefined()
	})

	it('preserves own resilience identity under wide Object.prototype pollution', () => {
		const keys = Array.from({length: 64}, (_, index) => `__resilience_pollution_${index}`)
		let error: ResilienceError | undefined
		try {
			for (const key of keys) Object.defineProperty(Object.prototype, key, {
				configurable: true,
				enumerable: true,
				value: 'forged'
			})
			error = new ResilienceError('safe', {
				resource: 'database',
				tenantId: 'tenant-a',
				metadata: {region: 'eu'}
			}, 'SAFE', 1)
		} finally {
			for (const key of keys) delete (Object.prototype as Record<string, unknown>)[key]
		}

		expect(error?.context).toEqual({
			resource: 'database',
			tenantId: 'tenant-a',
			metadata: {region: 'eu'}
		})
		expect(Object.getPrototypeOf(error!.context)).toBeNull()
		expect(Object.getPrototypeOf(error!.context.metadata!)).toBeNull()
	})
})
