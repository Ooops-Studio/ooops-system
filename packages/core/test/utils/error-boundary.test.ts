import {describe, expect, it, vi} from 'vitest'

import {
	createErrorBoundary,
	createSilentFailure,
	createSilentFailureWithFallback
} from '../../src/utils/error-boundary'

describe('error boundary configuration safety', () => {
	it('contains rejected promises supplied as configuration or capabilities', async() => {
		const options = Promise.reject(new Error('options rejected'))
		expect(() => createErrorBoundary(options as never)).toThrow('synchronous')
		const errors = Promise.reject(new Error('errors rejected'))
		expect(() => createErrorBoundary({serviceName: 'core', stage: 'test', errors: errors as never}))
			.toThrow('synchronous')
		await Promise.resolve()
	})

	it('contains rejected promises in ignored labels and pre-validation arguments', async() => {
		const ignoredLabel = Promise.reject(new Error('label rejected'))
		expect(() => createErrorBoundary({
			serviceName: 'core', stage: ignoredLabel as never
		})).not.toThrow()

		const operation = Promise.reject(new Error('operation rejected'))
		const invalidOptions = Promise.reject(new Error('options rejected'))
		expect(() => createSilentFailure(operation as never, invalidOptions as never)).toThrow('synchronous')

		const fallback = Promise.reject(new Error('fallback rejected'))
		const secondInvalidOptions = Promise.reject(new Error('options rejected'))
		expect(() => createSilentFailureWithFallback(
			() => 'result', fallback, secondInvalidOptions as never
		)).toThrow('synchronous')
		await Promise.resolve()
	})

	it('does not execute option accessors', () => {
		const getter = vi.fn(() => ({report: vi.fn()}))
		const options = Object.defineProperty({}, 'errors', {get: getter})

		expect(() => createErrorBoundary(options as never)).toThrow('data properties')
		expect(getter).not.toHaveBeenCalled()
	})

	it('snapshots labels before reporting', () => {
		const report = vi.fn()
		const options = {
			errors: {report}, serviceName: 'metrics', stage: 'export'
		}
		const boundary = createErrorBoundary(options)
		options.serviceName = 'mutated'
		options.stage = 'mutated'

		boundary(new Error('failure'))

		expect(report).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
			source: 'metrics', stage: 'export'
		}))
	})

	it('does not assimilate arbitrary thenables returned by operations', async() => {
		const then = vi.fn()

		await expect(createSilentFailure(() => ({then}) as never, {
			serviceName: 'metrics', stage: 'export'
		})).resolves.toBeUndefined()
		await expect(createSilentFailureWithFallback(() => ({then}) as never, 'fallback', {
			serviceName: 'metrics', stage: 'export'
		})).resolves.toBe('fallback')
		expect(then).not.toHaveBeenCalled()
	})

	it('adopts native promises without reading an own then accessor', async() => {
		const then = vi.fn(() => Promise.prototype.then)
		const completion = Promise.resolve('result')
		Object.defineProperty(completion, 'then', {get: then})

		await expect(createSilentFailure(() => completion, {
			serviceName: 'metrics', stage: 'export'
		})).resolves.toBe('result')
		expect(then).not.toHaveBeenCalled()
	})

	it('does not assimilate a value made thenable after its source promise settles', async() => {
		const then = vi.fn()
		const value: {then?: typeof then} = {}
		const source = Promise.resolve(value)
		Object.defineProperty(value, 'then', {value: then})

		await expect(createSilentFailure(() => source, {
			serviceName: 'metrics', stage: 'export'
		})).resolves.toBeUndefined()
		expect(then).not.toHaveBeenCalled()
	})

	it('returns its owned completion when an operation replaces Promise.resolve', async() => {
		const nativeResolve = Promise.resolve
		let replaced = false
		let completion!: Promise<string>
		try {
			completion = createSilentFailureWithFallback(() => {
				Object.defineProperty(Promise, 'resolve', {
					configurable: true,
					value: () => { throw new Error('poisoned Promise.resolve') }
				})
				replaced = true
				return 'result'
			}, 'fallback', {serviceName: 'metrics', stage: 'export'})
		} finally {
			if (replaced) Object.defineProperty(Promise, 'resolve', {
				configurable: true, writable: true, value: nativeResolve
			})
		}
		await expect(completion).resolves.toBe('result')
	})

	it('adopts completion without reading a replaced Promise.prototype.then', async() => {
		const nativeThen = Promise.prototype.then
		const source = Promise.resolve('result')
		let completion!: Promise<string>
		try {
			completion = createSilentFailureWithFallback(() => {
				Object.defineProperty(Promise.prototype, 'then', {
					configurable: true,
					value: () => { throw new Error('poisoned Promise.prototype.then') }
				})
				return source
			}, 'fallback', {serviceName: 'metrics', stage: 'export'})
		} finally {
			Object.defineProperty(Promise.prototype, 'then', {
				configurable: true, writable: true, value: nativeThen
			})
		}
		await expect(completion).resolves.toBe('result')
	})

	it('does not assimilate an unsafe fallback thenable', () => {
		const then = vi.fn()
		expect(() => createSilentFailureWithFallback(
			() => { throw new Error('failure') },
			{then} as never,
			{serviceName: 'metrics', stage: 'export'}
		)).toThrow('fallback must not be an unsafe thenable')
		expect(then).not.toHaveBeenCalled()
	})

	it('contains a rejected native promise supplied as an invalid fallback', async() => {
		const fallback = Promise.reject(new Error('fallback failed'))
		expect(() => createSilentFailureWithFallback(
			() => 'result', fallback as never,
			{serviceName: 'metrics', stage: 'export'}
		)).toThrow('fallback must not be an unsafe thenable')
		await Promise.resolve()
	})

	it('contains rejected native promises used as synchronous error values', async() => {
		const operationError = Promise.reject(new Error('operation failed'))
		await expect(createSilentFailure(() => { throw operationError }, {
			serviceName: 'metrics', stage: 'export'
		})).resolves.toBeUndefined()

		const reportedError = Promise.reject(new Error('reported failure'))
		createErrorBoundary({serviceName: 'metrics', stage: 'export'})(reportedError)
		await Promise.resolve()
	})

	it('rejects a fallback made thenable after an error reporter poisons object inspection', async() => {
		const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
		const then = vi.fn()
		const fallback: {then?: typeof then} = {}
		const errors = {
			report: () => {
				fallback.then = then
				Object.getOwnPropertyDescriptor = () => undefined
			}
		}
		let completion!: Promise<unknown>
		try {
			completion = createSilentFailureWithFallback(
				() => Promise.reject(new Error('failure')),
				fallback,
				{serviceName: 'metrics', stage: 'export', errors}
			)
			await expect(completion).rejects.toThrow('fallback is an unsafe thenable')
		} finally {
			Object.getOwnPropertyDescriptor = nativeGetOwnPropertyDescriptor
		}
		expect(then).not.toHaveBeenCalled()
	})
})
