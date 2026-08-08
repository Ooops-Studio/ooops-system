/**
 * @file Tests for error normalization utilities.
 */

import {describe, it, expect, vi} from 'vitest'

import {isErrorLike, normalizeError} from '../../../src/utils/error/normalize-error'

describe('normalize-error', () => {

	describe('isErrorLike', () => {

		it('should return true for Error instances', () => {

			expect(isErrorLike(new Error('test'))).toBe(true)
			expect(isErrorLike(new TypeError('test'))).toBe(true)
		})

		it('should return true for objects with message property', () => {

			expect(isErrorLike({message: 'test'})).toBe(true)
		})

		it('should return true for objects with name property', () => {

			expect(isErrorLike({name: 'TestError'})).toBe(true)
		})

		it('should return false for null', () => {

			expect(isErrorLike(null)).toBe(false)
		})

		it('should return false for undefined', () => {

			expect(isErrorLike(undefined)).toBe(false)
		})

		it('should return false for primitives', () => {

			expect(isErrorLike('string')).toBe(false)
			expect(isErrorLike(123)).toBe(false)
			expect(isErrorLike(true)).toBe(false)
		})

		it('should return false for arrays', () => {

			expect(isErrorLike([])).toBe(false)
			expect(isErrorLike([1, 2, 3])).toBe(false)
		})
	})

	describe('normalizeError', () => {
		it('preserves safe siblings around revoked nested values', () => {
			const revoked = Proxy.revocable({}, {})
			revoked.revoke()

			expect(normalizeError({safe: 'visible', broken: revoked.proxy})).toEqual({
				kind: 'UnknownError',
				message: '{"safe":"visible","broken":"[Unserializable]"}',
				data: {safe: 'visible', broken: '[Unserializable]'}
			})
		})

		it('omits revoked error data without throwing', () => {
			const revoked = Proxy.revocable({}, {})
			revoked.revoke()

			expect(normalizeError({name: 'Error', message: 'boom', data: revoked.proxy}))
				.toEqual({kind: 'Error', message: 'boom'})
		})
		it('rejects proxies before native-error prototype inspection', () => {
			let prototypeReads = 0
			let hostile!: object
			hostile = new Proxy({}, {
				getPrototypeOf: () => {
					prototypeReads++
					if (prototypeReads > 40) throw new Error('unbounded prototype traversal')
					return hostile
				}
			})

			expect(normalizeError(hostile)).toEqual({kind: 'UnknownError', message: '[Object]'})
			expect(prototypeReads).toBe(0)
		})

		it('omits error data with a proxied prototype before enumeration traps run', () => {
			const ownKeys = vi.fn(() => ['inherited'])
			const getOwnPropertyDescriptor = vi.fn(() => ({
				value: 'unsafe', enumerable: true, configurable: true, writable: true
			}))
			const prototype = new Proxy({}, {ownKeys, getOwnPropertyDescriptor})
			const data = Object.create(prototype) as Record<string, unknown>
			Object.defineProperty(data, 'safe', {value: 'visible', enumerable: true})

			expect(normalizeError({name: 'Error', message: 'boom', data})).toEqual({
				kind: 'Error', message: 'boom'
			})
			expect(ownKeys).not.toHaveBeenCalled()
			expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		})

		it('should normalize native Error', () => {

			const error = new Error('test error')
			const result = normalizeError(error)

			expect(result.kind).toBe('Error')
			expect(result.message).toBe('test error')
			expect(result.stack).toBeDefined()
		})

		it('should normalize Error with code', () => {

			const error = new Error('test error') as Error & {code?: string}
			error.code = 'ERR_TEST'

			const result = normalizeError(error)

			expect(result.code).toBe('ERR_TEST')
		})

		it('should normalize Error with cause', () => {

			const cause = new Error('cause error')
			const error = new Error('test error') as Error & {cause?: Error}
			error.cause = cause

			const result = normalizeError(error)

			expect(result.cause).toBeDefined()
			if (result.cause) {
				expect(result.cause.kind).toBe('Error')
				expect(result.cause.message).toBe('cause error')
			}
		})

		it('should normalize Error with nested cause', () => {

			const innerCause = new Error('inner cause')
			const cause = new Error('cause error') as Error & {cause?: Error}
			cause.cause = innerCause
			const error = new Error('test error') as Error & {cause?: Error}
			error.cause = cause

			const result = normalizeError(error)

			expect(result.cause).toBeDefined()
			if (result.cause && typeof result.cause === 'object' && 'cause' in result.cause) {
				const causeObj = result.cause as {cause?: {kind: string; message: string}}
				expect(causeObj.cause).toBeDefined()
			}
		})

		it('should normalize Error with data', () => {

			const error = new Error('test error') as Error & {data?: Readonly<Record<string, unknown>>}
			error.data = {key: 'value'}

			const result = normalizeError(error)

			expect(result.data).toEqual({key: 'value'})
		})

		it('should normalize Error without message', () => {

			const error = new Error()
			const result = normalizeError(error)

			expect(result.message).toBe('error')
		})

		it('should normalize error-like object with message', () => {

			const error = {message: 'test error'}
			const result = normalizeError(error)

			expect(result.kind).toBe('UnknownError')
			expect(result.message).toBe('test error')
		})

		it('should normalize error-like object with name', () => {

			const error = {name: 'CustomError'}
			const result = normalizeError(error)

			expect(result.kind).toBe('CustomError')
		})

		it('should normalize error-like object with stack', () => {

			const error = {
				name: 'Error',
				message: 'test',
				stack: 'stack trace'
			}

			const result = normalizeError(error)

			expect(result.stack).toBe('stack trace')
		})

		it('should normalize error-like object with code', () => {

			const error = {
				name: 'Error',
				message: 'test',
				code: 'ERR_TEST'
			}

			const result = normalizeError(error)

			expect(result.code).toBe('ERR_TEST')
		})

		it('should normalize error-like object with data', () => {

			const error = {
				name: 'Error',
				message: 'test',
				data: {key: 'value'}
			}

			const result = normalizeError(error)

			expect(result.data).toEqual({key: 'value'})
		})

		it('should normalize plain object', () => {

			const obj = {key: 'value', count: 123}
			const result = normalizeError(obj)

			expect(result.kind).toBe('UnknownError')
			expect(result.message).toBeDefined()
			expect(result.data).toEqual(obj)
		})

		it('should normalize string primitive', () => {

			const result = normalizeError('error message')

			expect(result.kind).toBe('UnknownError')
			expect(result.message).toBe('error message')
		})

		it('should normalize number primitive', () => {

			const result = normalizeError(123)

			expect(result.kind).toBe('UnknownError')
			expect(result.message).toBe('123')
		})

		it('should normalize boolean primitive', () => {

			const result = normalizeError(true)

			expect(result.kind).toBe('UnknownError')
			expect(result.message).toBe('true')
		})

		it('should normalize null', () => {

			const result = normalizeError(null)

			expect(result.kind).toBe('UnknownError')
			expect(result.message).toBe('null')
		})

		it('should normalize undefined', () => {

			const result = normalizeError(undefined)

			expect(result.kind).toBe('UnknownError')
			expect(result.message).toBe('undefined')
		})

		it('should handle Error with empty message and name', () => {

			const error = new Error('')
			error.name = ''
			const result = normalizeError(error)

			expect(result.kind).toBe('Error')
			expect(result.message).toBe('error')
		})

		it('should handle error-like object without message or name', () => {

			const error = {other: 'property'}
			const result = normalizeError(error)

			expect(result.kind).toBe('UnknownError')
			expect(result.message).toBeDefined()
		})

		it('bounds circular causes and does not invoke hostile accessors', () => {
			const circular = new Error('outer') as Error & {cause?: unknown}
			circular.cause = circular
			expect(normalizeError(circular).cause).toMatchObject({message: '[Circular]'})

			const getter = vi.fn(() => { throw new Error('must not execute') })
			const hostile = Object.create(null) as Record<string, unknown>
			Object.defineProperty(hostile, 'message', {enumerable: true, get: getter})
			expect(normalizeError(hostile)).toMatchObject({kind: 'UnknownError'})
			expect(getter).not.toHaveBeenCalled()
		})

		it('contains rejected native promises used as errors or causes', async() => {
			const direct = Promise.reject(new Error('direct rejection'))
			expect(normalizeError(direct)).toMatchObject({kind: 'UnknownError'})

			const cause = Promise.reject(new Error('cause rejection'))
			const error = new Error('outer', {cause})
			expect(normalizeError(error).cause).toBeDefined()
			await Promise.resolve()
		})

		it('preserves error normalization after collection and inspection intrinsics are rewired', () => {
			const weakSetHas = vi.spyOn(WeakSet.prototype, 'has')
			const weakSetAdd = vi.spyOn(WeakSet.prototype, 'add')
			const weakSetDelete = vi.spyOn(WeakSet.prototype, 'delete')
			const setHas = vi.spyOn(Set.prototype, 'has')
			const arrayFrom = vi.spyOn(Array, 'from')
			const arrayIsArray = vi.spyOn(Array, 'isArray')
			const objectCreate = vi.spyOn(Object, 'create')
			const objectHasOwn = vi.spyOn(Object, 'hasOwn')
			const objectDescriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor')
			const objectPrototype = vi.spyOn(Object, 'getPrototypeOf')
			const arrayPush = vi.spyOn(Array.prototype, 'push')
			let normalized: ReturnType<typeof normalizeError> | undefined
			let failure: unknown
			const poison = (): never => { throw new Error('rewired intrinsic') }
			try {
				weakSetHas.mockImplementation(poison)
				weakSetAdd.mockImplementation(poison)
				weakSetDelete.mockImplementation(poison)
				setHas.mockImplementation(poison)
				arrayFrom.mockImplementation(poison)
				arrayIsArray.mockImplementation(poison)
				objectCreate.mockImplementation(poison)
				objectHasOwn.mockImplementation(poison)
				objectDescriptor.mockImplementation(poison)
				objectPrototype.mockImplementation(poison)
				arrayPush.mockImplementation(poison)
				try {
					normalized = normalizeError({
						name: 'Failure', message: 'boom',
						data: {values: [1, 2], safe: true},
						cause: new Error('root')
					})
				} catch(error) { failure = error }
			} finally {
				arrayPush.mockRestore()
				objectPrototype.mockRestore()
				objectDescriptor.mockRestore()
				objectHasOwn.mockRestore()
				objectCreate.mockRestore()
				arrayIsArray.mockRestore()
				arrayFrom.mockRestore()
				setHas.mockRestore()
				weakSetDelete.mockRestore()
				weakSetAdd.mockRestore()
				weakSetHas.mockRestore()
			}

			expect(failure).toBeUndefined()
			expect(normalized).toMatchObject({
				kind: 'Failure', message: 'boom',
				data: {values: [1, 2], safe: true},
				cause: {kind: 'Error', message: 'root'}
			})
		})

		it('preserves non-finite values after the global String function is rewired', () => {
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'String')!
			let normalized: ReturnType<typeof normalizeError> | undefined
			try {
				Object.defineProperty(globalThis, 'String', {
					configurable: true, writable: true, value: () => 'forged'
				})
				normalized = normalizeError({message: 'failure', data: {values: [Number.NaN]}})
			} finally { Object.defineProperty(globalThis, 'String', descriptor) }

			expect(normalized?.data).toEqual({values: ['NaN']})
		})

		it('does not inherit polluted optional fields in normalized errors or nested causes', () => {
			const cause = new Error('root')
			const nameDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, 'name')!
			let normalized: ReturnType<typeof normalizeError>
			Object.defineProperties(Object.prototype, {
				code: {configurable: true, value: 'FORGED_CODE'},
				data: {configurable: true, value: {forged: true}},
				cause: {configurable: true, value: {message: 'forged cause'}},
				traceId: {configurable: true, value: 'forged-trace'}
			})
			Object.defineProperty(Error.prototype, 'name', {
				configurable: true, writable: true, value: 'FORGED_KIND'
			})
			try { normalized = normalizeError(new Error('outer', {cause})) }
			finally {
				Object.defineProperty(Error.prototype, 'name', nameDescriptor)
				delete (Object.prototype as Record<string, unknown>).code
				delete (Object.prototype as Record<string, unknown>).data
				delete (Object.prototype as Record<string, unknown>).cause
				delete (Object.prototype as Record<string, unknown>).traceId
			}

			expect(Object.getPrototypeOf(normalized!)).toBeNull()
			expect(Object.getPrototypeOf(normalized!.cause)).toBeNull()
			expect(normalized!.code).toBeUndefined()
			expect(normalized!.data).toBeUndefined()
			expect((normalized! as Record<string, unknown>).traceId).toBeUndefined()
			expect(normalized!.cause).toMatchObject({kind: 'Error', message: 'root'})
			expect(normalized!.kind).toBe('Error')
		})

		it('applies one aggregate budget to broad nested diagnostic data', () => {
			const branch = Object.fromEntries(Array.from(
				{length: 100},
				(_value, index) => [`leaf${index}`, `value-${index}`]
			))
			const input = Object.fromEntries(Array.from(
				{length: 100},
				(_value, index) => [`branch${index}`, branch]
			))

			const result = normalizeError(input)
			const serialized = JSON.stringify(result)

			expect(serialized).toContain('[Truncated]')
			expect(serialized.length).toBeLessThan(150_000)
		})
	})
})
