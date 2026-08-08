/**
 * @file Tests for error serialization utilities.
 */

import {describe, it, expect, vi} from 'vitest'

import {serialize, serializeError} from '../../../src/utils/serialization/serialize-error'

describe('serialize-error', () => {
	it('rejects proxies before executing enumeration traps', () => {
		const ownKeys = vi.fn(() => ['secret'])
		const value = new Proxy({secret: 'value'}, {ownKeys})

		expect(serialize(value)).toBe('"[Circular or non-serializable]"')
		expect(ownKeys).not.toHaveBeenCalled()
	})

	it('does not inspect proxied serialization options', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const getPrototypeOf = vi.fn(() => null)
		const options = new Proxy({maxDepth: 1}, {getOwnPropertyDescriptor, getPrototypeOf})

		expect(serialize({safe: true}, options)).toBe('{"safe":true}')
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})

	it('contains rejected promises in values and serialization options', async() => {
		const valueFailure = Promise.reject(new Error('value rejected'))
		const optionFailure = Promise.reject(new Error('option rejected'))
		const optionsFailure = Promise.reject(new Error('options rejected'))
		expect(serialize({failure: valueFailure}, {maxDepth: optionFailure as never})).toBe('{"failure":{}}')
		expect(serialize({safe: true}, optionsFailure as never)).toBe('{"safe":true}')
		await Promise.resolve()
	})

	describe('serializeError', () => {

		it('should serialize basic error', () => {

			const error = new Error('test error')
			const result = serializeError(error)

			expect(result).toMatchObject({
				name: 'Error',
				message: 'test error'
			})
			expect(result.stack).toBeDefined()
		})

		it('should include stack trace by default', () => {

			const error = new Error('test error')
			const result = serializeError(error)

			expect(result.stack).toBeDefined()
			expect(typeof result.stack).toBe('string')
		})

		it('does not execute proxied native getters disguised as stack accessors', () => {
			let reads = 0
			const nativeGetter = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!
			const disguised = new Proxy(nativeGetter, {
				apply: () => { reads++; return 'secret stack' }
			})
			const error = Object.defineProperty(new Error('safe'), 'stack', {
				configurable: true,
				get: disguised
			})

			expect(serializeError(error)).not.toHaveProperty('stack')
			expect(reads).toBe(0)
		})

		it('should exclude stack trace when includeStack is false', () => {

			const error = new Error('test error')
			const result = serializeError(error, false)

			expect(result.stack).toBeUndefined()
		})

		it('should serialize error with cause', () => {

			const cause = new Error('cause error')
			const error = new Error('test error')
			error.cause = cause

			const result = serializeError(error)

			expect(result.cause).toBeDefined()
			expect(result.cause).toMatchObject({
				name: 'Error',
				message: 'cause error'
			})
		})

		it('should serialize error with nested cause', () => {

			const innerCause = new Error('inner cause')
			const cause = new Error('cause error')
			cause.cause = innerCause
			const error = new Error('test error')
			error.cause = cause

			const result = serializeError(error)

			expect(result.cause).toBeDefined()
			if (typeof result.cause === 'object' && result.cause !== null) {
				const causeObj = result.cause as Record<string, unknown>
				expect(causeObj.cause).toBeDefined()
			}
		})

		it('should serialize error with object cause', () => {

			const error = new Error('test error')
			error.cause = {reason: 'object cause'}

			const result = serializeError(error)

			expect(result.cause).toBeDefined()
		})

		it('should serialize error with string cause', () => {

			const error = new Error('test error')
			error.cause = 'string cause'

			const result = serializeError(error)

			expect(result.cause).toBe('string cause')
		})

		it('should serialize error with code property', () => {

			const error = new Error('test error') as Error & {code?: string}
			error.code = 'ERR_TEST'

			const result = serializeError(error)

			expect(result.code).toBe('ERR_TEST')
		})

		it('should handle circular cause references', () => {

			const error = new Error('test error')
			const cause = new Error('cause')
			error.cause = cause
			// Create circular reference
			;(cause as unknown as {cause?: Error}).cause = error

			const result = serializeError(error)

			expect(result.cause).toMatchObject({message: 'cause'})
			expect((result.cause as {cause?: unknown}).cause).toEqual({
				name: 'Error',
				message: '[Circular]'
			})
		})

		it('bounds long cause chains', () => {
			const root = new Error('root')
			let current = root
			for (let index = 0; index < 100; index += 1) {
				const cause = new Error(`cause-${index}`)
				current.cause = cause
				current = cause
			}

			const result = serializeError(root, false)
			let cursor: unknown = result
			let depth = 0
			while (cursor && typeof cursor === 'object' && 'cause' in cursor) {
				depth += 1
				cursor = (cursor as {cause?: unknown}).cause
			}

			expect(depth).toBeLessThanOrEqual(9)
			expect(cursor).toBe('[MaxDepth]')
		})

		it('does not execute accessor-backed error fields', () => {
			let reads = 0
			const error = new Error('safe')
			Object.defineProperty(error, 'cause', {
				get() { reads += 1; return new Error('hostile') }
			})

			expect(serializeError(error)).not.toHaveProperty('cause')
			expect(reads).toBe(0)
		})

		it('contains rejected native promises used as error causes', async() => {
			const cause = Promise.reject(new Error('cause rejected'))
			const error = new Error('outer', {cause})

			expect(serializeError(error)).toHaveProperty('cause')
			await Promise.resolve()
		})

		it('should handle error without stack', () => {

			const error = new Error('test error')
			delete (error as {stack?: string}).stack

			const result = serializeError(error)

			expect(result.stack).toBeUndefined()
		})

		it('does not inherit polluted optional fields in serialized errors or nested causes', () => {
			const error = new Error('outer', {cause: new Error('root')})
			const nameDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, 'name')!
			let serialized: ReturnType<typeof serializeError>
			Object.defineProperties(Object.prototype, {
				code: {configurable: true, value: 'FORGED_CODE'},
				traceId: {configurable: true, value: 'forged-trace'}
			})
			Object.defineProperty(Error.prototype, 'name', {
				configurable: true, writable: true, value: 'FORGED_KIND'
			})
			try { serialized = serializeError(error, false) }
			finally {
				Object.defineProperty(Error.prototype, 'name', nameDescriptor)
				delete (Object.prototype as Record<string, unknown>).code
				delete (Object.prototype as Record<string, unknown>).traceId
			}

			expect(Object.getPrototypeOf(serialized!)).toBeNull()
			expect(Object.getPrototypeOf(serialized!.cause)).toBeNull()
			expect(serialized!.code).toBeUndefined()
			expect(serialized!.traceId).toBeUndefined()
			expect(serialized!.cause).toMatchObject({name: 'Error', message: 'root'})
			expect(serialized!.name).toBe('Error')
		})
	})

	describe('serialize', () => {

		it('should serialize error', () => {

			const error = new Error('test error')
			const result = serialize(error)

			expect(result).toBeDefined()
			expect(typeof result).toBe('string')
			const parsed = JSON.parse(result)
			expect(parsed.name).toBe('Error')
			expect(parsed.message).toBe('test error')
		})

		it('should serialize plain object', () => {

			const obj = {key: 'value', count: 123}
			const result = serialize(obj)

			expect(result).toBeDefined()
			const parsed = JSON.parse(result)
			expect(parsed.key).toBe('value')
			expect(parsed.count).toBe(123)
		})

		it('should serialize array', () => {

			const arr = [1, 2, 3]
			const result = serialize(arr)

			expect(result).toBeDefined()
			const parsed = JSON.parse(result)
			expect(Array.isArray(parsed)).toBe(true)
			expect(parsed).toEqual([1, 2, 3])
		})

		it('should serialize array with errors', () => {

			const arr = [new Error('error1'), new Error('error2')]
			const result = serialize(arr)

			expect(result).toBeDefined()
			const parsed = JSON.parse(result)
			expect(Array.isArray(parsed)).toBe(true)
			expect(parsed[0]).toMatchObject({name: 'Error', message: 'error1'})
		})

		it('should serialize array with dates', () => {

			const date = new Date('2024-01-01')
			const arr = [date]
			const result = serialize(arr)

			expect(result).toBeDefined()
			const parsed = JSON.parse(result)
			expect(parsed[0]).toBe(date.toISOString())
		})

		it('preserves captured JSON and Date intrinsics after prototype rewiring', () => {
			const date = new Date('2024-01-01T00:00:00.000Z')
			const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
				throw new Error('rewired stringify')
			})
			const getTime = vi.spyOn(Date.prototype, 'getTime').mockImplementation(() => {
				throw new Error('rewired getTime')
			})
			const toISOString = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
				throw new Error('rewired toISOString')
			})
			let result: string
			try { result = serialize({created: date}) } finally {
				stringify.mockRestore()
				getTime.mockRestore()
				toISOString.mockRestore()
			}
			expect(JSON.parse(result!)).toEqual({created: '2024-01-01T00:00:00.000Z'})
		})

		it('preserves bounded serialization after collection and inspection intrinsics are rewired', () => {
			const weakSetHas = vi.spyOn(WeakSet.prototype, 'has')
			const weakSetAdd = vi.spyOn(WeakSet.prototype, 'add')
			const weakSetDelete = vi.spyOn(WeakSet.prototype, 'delete')
			const arrayIsArray = vi.spyOn(Array, 'isArray')
			const objectCreate = vi.spyOn(Object, 'create')
			const objectHasOwn = vi.spyOn(Object, 'hasOwn')
			const objectDescriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor')
			const objectPrototype = vi.spyOn(Object, 'getPrototypeOf')
			const arrayPush = vi.spyOn(Array.prototype, 'push')
			const poison = (): never => { throw new Error('rewired intrinsic') }
			let result: string | undefined
			let failure: unknown
			try {
				weakSetHas.mockImplementation(poison)
				weakSetAdd.mockImplementation(poison)
				weakSetDelete.mockImplementation(poison)
				arrayIsArray.mockImplementation(poison)
				objectCreate.mockImplementation(poison)
				objectHasOwn.mockImplementation(poison)
				objectDescriptor.mockImplementation(poison)
				objectPrototype.mockImplementation(poison)
				arrayPush.mockImplementation(poison)
				try { result = serialize({items: [1, {safe: true}], error: new Error('boom')}) }
				catch(error) { failure = error }
			} finally {
				arrayPush.mockRestore()
				objectPrototype.mockRestore()
				objectDescriptor.mockRestore()
				objectHasOwn.mockRestore()
				objectCreate.mockRestore()
				arrayIsArray.mockRestore()
				weakSetDelete.mockRestore()
				weakSetAdd.mockRestore()
				weakSetHas.mockRestore()
			}

			expect(failure).toBeUndefined()
			expect(JSON.parse(result!)).toMatchObject({
				items: [1, {safe: true}], error: {name: 'Error', message: 'boom'}
			})
		})

		it('should serialize primitive values', () => {

			expect(serialize('string')).toBe('"string"')
			expect(serialize(123)).toBe('123')
			expect(serialize(true)).toBe('true')
			expect(serialize(null)).toBe('null')
		})

		it('should handle circular references', () => {

			const obj: Record<string, unknown> = {key: 'value'}
			obj.self = obj

			const result = serialize(obj)

			expect(result).toBe('"[Circular or non-serializable]"')
		})

		it('bounds sparse arrays before allocating a caller-controlled result length', () => {
			const oversized = new Array(1_001)
			let mapReads = 0
			Object.defineProperty(oversized, 'map', {
				get() { mapReads += 1; throw new Error('must not execute') }
			})

			expect(serialize(oversized)).toBe('"[Circular or non-serializable]"')
			expect(mapReads).toBe(0)
		})

		it('caps an unbounded maxDepth option at the hard traversal limit', () => {
			const root: Record<string, unknown> = {}
			let cursor = root
			for (let depth = 0; depth < 100; depth += 1) {
				const child: Record<string, unknown> = {}
				cursor.child = child
				cursor = child
			}

			const parsed = JSON.parse(serialize(root, {maxDepth: Number.POSITIVE_INFINITY}))
			let observed: unknown = parsed
			let depth = 0
			while (observed && typeof observed === 'object' && 'child' in observed) {
				observed = (observed as {child: unknown}).child
				depth += 1
			}

			expect(depth).toBeLessThanOrEqual(10)
			expect(observed).toEqual({'[MaxDepth]': '...'})
		})

		it('does not invoke accessor-backed fields while snapshotting objects', () => {
			let reads = 0
			const value = {safe: 'value'} as Record<string, unknown>
			Object.defineProperty(value, 'hostile', {
				enumerable: true,
				get() { reads += 1; return 'secret' }
			})

			expect(JSON.parse(serialize(value))).toEqual({safe: 'value'})
			expect(reads).toBe(0)
		})

		it('rejects proxies hidden in object prototype chains before their traps run', () => {
			const ownKeys = vi.fn(() => ['inherited'])
			const getOwnPropertyDescriptor = vi.fn(() => ({
				value: 'unsafe', enumerable: true, configurable: true, writable: true
			}))
			const prototype = new Proxy({}, {ownKeys, getOwnPropertyDescriptor})
			const value = Object.create(prototype) as Record<string, unknown>
			Object.defineProperty(value, 'safe', {value: 'visible', enumerable: true})

			expect(serialize(value)).toBe('"[Circular or non-serializable]"')
			expect(ownKeys).not.toHaveBeenCalled()
			expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		})

		it('bounds retained error strings', () => {
			const error = new Error('x'.repeat(70_000))
			Object.defineProperty(error, 'stack', {value: 's'.repeat(70_000)})
			Object.assign(error, {code: 'c'.repeat(70_000)})

			expect(serializeError(error)).toMatchObject({
				message: '[DROPPED_OVERSIZED]',
				stack: '[DROPPED_OVERSIZED]',
				code: '[DROPPED_OVERSIZED]'
			})
		})

		it('should respect maxDepth option', () => {

			const obj = {
				level1: {
					level2: {
						level3: {
							level4: {
								level5: {
									level6: {
										level7: {
											level8: {
												level9: {
													level10: {
														level11: 'deep'
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}

			const result = serialize(obj, {maxDepth: 5})
			const parsed = JSON.parse(result)

			// Should truncate at maxDepth
			expect(parsed.level1).toBeDefined()
		})

		it('should respect includeStack option', () => {

			const error = new Error('test error')
			const result = serialize(error, {includeStack: false})
			const parsed = JSON.parse(result)

			expect(parsed.stack).toBeUndefined()
		})

		it('should handle nested objects', () => {

			const obj = {
				user: {
					id: 123,
					name: 'test',
					metadata: {
						created: new Date('2024-01-01')
					}
				}
			}

			const result = serialize(obj)
			const parsed = JSON.parse(result)

			expect(parsed.user.id).toBe(123)
			expect(parsed.user.name).toBe('test')
			expect(parsed.user.metadata.created).toBe(new Date('2024-01-01').toISOString())
		})

		it('should handle objects with functions', () => {

			const obj = {
				key: 'value',
				fn: () => {}
			}

			const result = serialize(obj)
			const parsed = JSON.parse(result)

			expect(parsed.fn).toBeUndefined()
		})

		it('should handle objects with symbols', () => {

			const sym = Symbol('test')
			const obj = {
				key: 'value',
				[sym]: 'symbol value'
			}

			const result = serialize(obj)
			const parsed = JSON.parse(result)

			expect(parsed.key).toBe('value')
		})

		it('should handle objects with errors', () => {

			const obj = {
				error: new Error('test error'),
				data: 'value'
			}

			const result = serialize(obj)
			const parsed = JSON.parse(result)

			expect(parsed.error).toMatchObject({name: 'Error', message: 'test error'})
			expect(parsed.data).toBe('value')
		})

		it('should handle arrays with mixed types', () => {

			const arr = [
				1,
				'two',
				true,
				new Date('2024-01-01'),
				new Error('error'),
				{key: 'value'}
			]

			const result = serialize(arr)
			const parsed = JSON.parse(result)

			expect(parsed[0]).toBe(1)
			expect(parsed[1]).toBe('two')
			expect(parsed[2]).toBe(true)
			expect(parsed[3]).toBe(new Date('2024-01-01').toISOString())
			expect(parsed[4]).toMatchObject({name: 'Error', message: 'error'})
			expect(parsed[5]).toMatchObject({key: 'value'})
		})

		it('should handle null values', () => {

			const obj = {key: null, other: 'value'}
			const result = serialize(obj)
			const parsed = JSON.parse(result)

			expect(parsed.key).toBeNull()
			expect(parsed.other).toBe('value')
		})

		it('should handle undefined values in objects', () => {

			const obj: Record<string, unknown> = {key: undefined, other: 'value'}
			const result = serialize(obj)
			const parsed = JSON.parse(result)

			// Undefined values are skipped in JSON.stringify
			expect('key' in parsed).toBe(false)
			expect(parsed.other).toBe('value')
		})

		it('should handle deeply nested arrays', () => {

			const arr = [[[['deep']]]]
			const result = serialize(arr)
			const parsed = JSON.parse(result)

			expect(parsed[0][0][0][0]).toBe('deep')
		})

		it('should handle maxDepth for nested structures', () => {

			const obj = {
				a: {
					b: {
						c: {
							d: {
								e: {
									f: {
										g: {
											h: {
												i: {
													j: {
														k: 'deep'
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}

			const result = serialize(obj, {maxDepth: 3})
			const parsed = JSON.parse(result)

			// Should truncate at depth 3
			expect(parsed.a).toBeDefined()
		})
	})
})
