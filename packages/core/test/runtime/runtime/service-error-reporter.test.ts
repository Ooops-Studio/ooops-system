import {describe, expect, it, vi} from 'vitest'

import {createServiceErrorReporter} from '../../../src/runtime/runtime/service-error-reporter'

describe('createServiceErrorReporter', () => {
	it('contains rejected promises supplied as reporter configuration', async() => {
		const options = Promise.reject(new Error('options rejected'))
		expect(() => createServiceErrorReporter(options as never)).toThrow('synchronous')
		const errors = Promise.reject(new Error('errors rejected'))
		expect(() => createServiceErrorReporter({errors: errors as never, serviceName: 'test'}))
			.toThrow('synchronous')
		await Promise.resolve()
	})

	it('does not execute configuration accessors', () => {
		const getter = vi.fn(() => 'test')
		const options = Object.defineProperty({}, 'serviceName', {get: getter})

		expect(() => createServiceErrorReporter(options as never)).toThrow('data properties')
		expect(getter).not.toHaveBeenCalled()
	})

	it('copies report context without materializing symbol-key arrays', () => {
		const context = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`hidden-${index}`), index]
		))
		Object.defineProperty(context, 'operation', {value: 'export', enumerable: true})
		const report = vi.fn()
		const enumerateKeys = vi.spyOn(Reflect, 'ownKeys').mockImplementation(() => [])
		let enumerationCalls = 0
		try {
			createServiceErrorReporter({errors: {report} as never, serviceName: 'test'})(
				new Error('failure'), context
			)
			enumerationCalls = enumerateKeys.mock.calls.length
		} finally { enumerateKeys.mockRestore() }
		expect(report).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
			operation: 'export', source: 'test'
		}))
		expect(enumerationCalls).toBe(0)
	})

	it('does not enumerate proxy report contexts', () => {
		const ownKeys = vi.fn(() => ['operation'])
		const context = new Proxy({operation: 'unsafe'}, {ownKeys})
		const report = vi.fn()

		createServiceErrorReporter({errors: {report} as never, serviceName: 'test'})(
			new Error('failure'), context
		)

		expect(ownKeys).not.toHaveBeenCalled()
		expect(report).toHaveBeenCalledWith(expect.any(Object), {source: 'test', stage: 'test'})
	})

	it('does not enumerate report contexts with proxies hidden in their prototype chain', () => {
		const ownKeys = vi.fn(() => ['inherited'])
		const getOwnPropertyDescriptor = vi.fn(() => ({
			value: 'unsafe', enumerable: true, configurable: true, writable: true
		}))
		const prototype = new Proxy({}, {ownKeys, getOwnPropertyDescriptor})
		const context = Object.create(prototype) as Record<string, unknown>
		Object.defineProperty(context, 'operation', {value: 'export', enumerable: true})
		const report = vi.fn()

		createServiceErrorReporter({errors: {report} as never, serviceName: 'test'})(
			new Error('failure'), context
		)

		expect(ownKeys).not.toHaveBeenCalled()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(report).toHaveBeenCalledWith(expect.any(Object), {source: 'test', stage: 'test'})
	})

	it('rejects proxied error ports before capability-inspection traps', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const getPrototypeOf = vi.fn(() => null)
		const errors = new Proxy({report: vi.fn()}, {getOwnPropertyDescriptor, getPrototypeOf})
		const onError = createServiceErrorReporter({errors, serviceName: 'test'})

		expect(() => onError(new Error('failure'))).not.toThrow()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('does not inherit a forged report capability from Object.prototype', () => {
		let calls = 0
		Object.defineProperty(Object.prototype, 'report', {
			configurable: true, writable: true, value: () => { calls += 1 }
		})
		try {
			const onError = createServiceErrorReporter({errors: {} as never, serviceName: 'test'})
			onError(new Error('failure'))
		} finally { delete (Object.prototype as Record<string, unknown>).report }

		expect(calls).toBe(0)
	})

	it('bounds never-settling physical reports and recovers capacity after settlement', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const report = vi.fn(() => gate)
		const onError = createServiceErrorReporter({
			errors: {report} as never,
			serviceName: 'test'
		})

		for (let index = 0; index < 1_001; index += 1) onError(new Error(`failure-${index}`))
		expect(report).toHaveBeenCalledTimes(1_000)

		release()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		onError(new Error('capacity-recovered'))
		expect(report).toHaveBeenCalledTimes(1_001)
	}, 120_000)

	it('retains report ownership when the destination replaces Promise.prototype.then', async() => {
		const nativeThen = Promise.prototype.then
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		let replaced = false
		let reports = 0
		const errors = {
			report() {
				reports += 1
				if (!replaced) {
					Object.defineProperty(Promise.prototype, 'then', {
						configurable: true,
						value: () => { throw new Error('poisoned Promise.prototype.then') }
					})
					replaced = true
				}
				return gate
			}
		}
		const onError = createServiceErrorReporter({errors: errors as never, serviceName: 'test'})

		try {
			for (let index = 0; index < 1_001; index += 1) onError(new Error(`failure-${index}`))
			expect(reports).toBe(1_000)
		} finally {
			Object.defineProperty(Promise.prototype, 'then', {
				configurable: true, writable: true, value: nativeThen
			})
			release()
		}
	}, 120_000)

	it('retains the report capability when the destination replaces Function.prototype.call', () => {
		const callDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'call')!
		let reports = 0
		let replaced = false
		const errors = {
			report() {
				reports += 1
				if (replaced) return
				Object.defineProperty(Function.prototype, 'call', {
					configurable: true,
					writable: true,
					value: () => { throw new Error('poisoned Function.prototype.call') }
				})
				replaced = true
			}
		}
		const onError = createServiceErrorReporter({errors: errors as never, serviceName: 'test'})

		try {
			onError(new Error('first'))
			onError(new Error('second'))
		} finally {
			Object.defineProperty(Function.prototype, 'call', callDescriptor)
		}

		expect(reports).toBe(2)
	})

	it('releases report ownership when the destination replaces collection cleanup methods', async() => {
		const nativeSetDelete = Set.prototype.delete
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const failure = new Error('reused failure')
		let reports = 0
		let replaced = false
		const errors = {
			report() {
				reports += 1
				if (!replaced) {
					Object.defineProperty(Set.prototype, 'delete', {
						configurable: true,
						value(this: Set<unknown>, value: unknown) {
							if (value === failure || (value && typeof value === 'object' &&
								Object.hasOwn(value, 'then') && Object.hasOwn(value, 'constructor'))) {
								throw new Error('poisoned Set.prototype.delete')
							}
							return nativeSetDelete.call(this, value)
						}
					})
					replaced = true
					return gate
				}
			}
		}
		const onError = createServiceErrorReporter({errors: errors as never, serviceName: 'test'})

		try {
			onError(failure)
			release()
			await new Promise<void>((resolve) => { setImmediate(resolve) })
			expect(() => onError(failure)).not.toThrow()
			expect(reports).toBe(2)
		} finally {
			Object.defineProperty(Set.prototype, 'delete', {
				configurable: true, writable: true, value: nativeSetDelete
			})
		}
	})

	it('rejects synchronous report re-entry even when it uses a fresh Error object', () => {
		let onError!: ReturnType<typeof createServiceErrorReporter>
		const report = vi.fn(() => { onError(new Error('nested')) })
		onError = createServiceErrorReporter({
			errors: {report} as never,
			serviceName: 'test'
		})

		onError(new Error('outer'))

		expect(report).toHaveBeenCalledOnce()
	})

	it('rejects asynchronous report re-entry from the destination continuation', async() => {
		let onError!: ReturnType<typeof createServiceErrorReporter>
		let reports = 0
		const errors = {
			async report() {
				reports += 1
				if (reports !== 1) return
				await Promise.resolve()
				onError(new Error('nested'))
			}
		}
		onError = createServiceErrorReporter({errors: errors as never, serviceName: 'test'})

		onError(new Error('outer'))
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(reports).toBe(1)
	})

	it('does not execute arbitrary thenables returned by the errors port', async() => {
		const then = vi.fn()
		const report = vi.fn(() => ({then}))
		const onError = createServiceErrorReporter({errors: {report} as never, serviceName: 'test'})

		onError(new Error('first'))
		onError(new Error('second'))
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(report).toHaveBeenCalledTimes(2)
		expect(then).not.toHaveBeenCalled()
	})

	it('contains rejected native promises thrown by the errors port', async() => {
		const thrown = Promise.reject(new Error('thrown report failure'))
		const report = vi.fn(() => { throw thrown })
		const onError = createServiceErrorReporter({errors: {report} as never, serviceName: 'test'})

		onError(new Error('failure'))
		await Promise.resolve()

		expect(report).toHaveBeenCalledOnce()
	})

	it('keeps context snapshots safe after a destination rewires JSON.parse', async() => {
		const parseDescriptor = Object.getOwnPropertyDescriptor(JSON, 'parse')!
		const contexts: unknown[] = []
		let reports = 0
		const report = vi.fn((_error: unknown, context: unknown) => {
			contexts.push(context)
			if (reports++ === 0) {
				Object.defineProperty(JSON, 'parse', {
					configurable: true, writable: true,
					value: () => Promise.reject(new Error('poisoned JSON.parse'))
				})
			}
		})
		const onError = createServiceErrorReporter({errors: {report} as never, serviceName: 'test'})

		try {
			onError(new Error('first'))
			onError(new Error('second'))
		} finally { Object.defineProperty(JSON, 'parse', parseDescriptor) }

		expect(report).toHaveBeenCalledTimes(2)
		expect(contexts.every((context) => context && typeof context === 'object' && !(context instanceof Promise))).toBe(true)
		await Promise.resolve()
	})

	it('does not inherit polluted identity fields and survives inspection intrinsics being rewired', () => {
		const defineProperty = Object.defineProperty
		const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
		const descriptors = {
			arrayIsArray: getOwnPropertyDescriptor(Array, 'isArray')!,
			objectCreate: getOwnPropertyDescriptor(Object, 'create')!,
			objectDescriptor: getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor')!,
			objectPrototype: getOwnPropertyDescriptor(Object, 'getPrototypeOf')!,
			objectHasOwn: getOwnPropertyDescriptor(Object, 'hasOwn')!
		}
		const contexts: unknown[] = []
		let reports = 0
		const onError = createServiceErrorReporter({
			errors: {report(_error: unknown, context: unknown) {
				reports += 1
				contexts.push(context)
			}} as never,
			serviceName: 'test'
		})

		defineProperty(Object.prototype, 'tenantId', {
			configurable: true, value: 'forged-tenant'
		})
		defineProperty(Object.prototype, 'traceId', {
			configurable: true, value: 'forged-trace'
		})
		let thrown: unknown
		try {
			defineProperty(Array, 'isArray', {
				configurable: true, value: () => { throw new Error('poisoned Array.isArray') }
			})
			for (const key of ['create', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'hasOwn'] as const) {
				defineProperty(Object, key, {
					configurable: true, value: () => { throw new Error(`poisoned Object.${key}`) }
				})
			}
			try { onError(new Error('failure'), {operation: 'export'}) } catch(error) { thrown = error }
		} finally {
			defineProperty(Array, 'isArray', descriptors.arrayIsArray)
			defineProperty(Object, 'create', descriptors.objectCreate)
			defineProperty(Object, 'getOwnPropertyDescriptor', descriptors.objectDescriptor)
			defineProperty(Object, 'getPrototypeOf', descriptors.objectPrototype)
			defineProperty(Object, 'hasOwn', descriptors.objectHasOwn)
			delete (Object.prototype as Record<string, unknown>).tenantId
			delete (Object.prototype as Record<string, unknown>).traceId
		}

		expect(thrown).toBeUndefined()
		expect(reports).toBe(1)
		const context = contexts[0] as Record<string, unknown>
		expect(Object.getPrototypeOf(context)).toBeNull()
		expect(context).toMatchObject({operation: 'export', source: 'test', stage: 'test'})
		expect(context.tenantId).toBeUndefined()
		expect(context.traceId).toBeUndefined()
	})

	it('snapshots nested context before crossing the Errors port boundary', () => {
		let reads = 0
		const nested = Object.defineProperty({safe: 'value'}, 'secret', {
			enumerable: true,
			get: () => { reads++; return 'exposed' }
		})
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const report = vi.fn()
		const onError = createServiceErrorReporter({errors: {report} as never, serviceName: 'test'})

		onError(new Error('failure'), {nested})
		const reportedContext = report.mock.calls[0]?.[1] as Record<string, unknown>
		expect(reads).toBe(0)
		expect(reportedContext.nested).not.toBe(nested)
		expect(reportedContext.nested).toEqual({safe: 'value'})
		expect(reportedContext).toMatchObject({source: 'test', stage: 'test'})
		expect(JSON.stringify(reportedContext)).not.toContain('exposed')

		onError(new Error('cyclic'), {cyclic})
		expect(report.mock.calls[1]?.[1]).toEqual({source: 'test', stage: 'test'})
	})
})
