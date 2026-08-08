import {describe, it, expect, vi} from 'vitest'

import {createContainer, type Container} from '../../src/runtime/container'

describe('container', () => {
	describe('createContainer', () => {
		it('should create empty container', () => {
			const container = createContainer()
			expect(container).toBeDefined()
		})

		it('should bind and get values', () => {
			const container = createContainer()
			const token = Symbol('test')
			const value = 'test-value'

			container.bind(token, value)
			const result = container.get(token)

			expect(result).toBe(value)
		})

		it('should throw when getting unbound token', () => {
			const container = createContainer()
			const token = Symbol('unbound')

			expect(() => container.get(token)).toThrow('Token Symbol(unbound) is not bound')
		})

		it('should return undefined for tryGet with unbound token', () => {
			const container = createContainer()
			const token = Symbol('unbound')

			expect(container.tryGet(token)).toBeUndefined()
		})

		it('should return value for tryGet with bound token', () => {
			const container = createContainer()
			const token = Symbol('test')
			const value = 'test-value'

			container.bind(token, value)
			const result = container.tryGet(token)

			expect(result).toBe(value)
		})

		it('should check if token is bound', () => {
			const container = createContainer()
			const token = Symbol('test')

			expect(container.has(token)).toBe(false)

			container.bind(token, 'value')
			expect(container.has(token)).toBe(true)
		})

		it('should handle multiple bindings', () => {
			const container = createContainer()
			const token1 = Symbol('test1')
			const token2 = Symbol('test2')

			container.bind(token1, 'value1')
			container.bind(token2, 'value2')

			expect(container.get(token1)).toBe('value1')
			expect(container.get(token2)).toBe('value2')
		})

		it('should overwrite existing binding', () => {
			const container = createContainer()
			const token = Symbol('test')

			container.bind(token, 'value1')
			container.bind(token, 'value2')

			expect(container.get(token)).toBe('value2')
		})

		it('should handle different value types', () => {
			const container = createContainer()
			const token1 = Symbol('string')
			const token2 = Symbol('number')
			const token3 = Symbol('object')
			const token4 = Symbol('function')

			container.bind(token1, 'string')
			container.bind(token2, 42)
			container.bind(token3, {key: 'value'})
			container.bind(token4, () => 'function')

			expect(container.get(token1)).toBe('string')
			expect(container.get(token2)).toBe(42)
			expect(container.get(token3)).toEqual({key: 'value'})
			expect(typeof container.get(token4)).toBe('function')
		})

		it('should implement Container interface', () => {
			const container: Container = createContainer()
			expect(typeof container.bind).toBe('function')
			expect(typeof container.get).toBe('function')
			expect(typeof container.tryGet).toBe('function')
			expect(typeof container.has).toBe('function')
		})

		it('should handle undefined values', () => {
			const container = createContainer()
			const token = Symbol('undefined')

			container.bind(token, undefined)
			expect(container.has(token)).toBe(true)
			expect(() => container.get(token)).toThrow() // get() throws for undefined
			expect(container.tryGet(token)).toBeUndefined()
		})

		it('should handle null values', () => {
			const container = createContainer()
			const token = Symbol('null')

			container.bind(token, null)
			expect(container.get(token)).toBeNull()
			expect(container.tryGet(token)).toBeNull()
		})

		it('preserves bindings when Map prototype methods are replaced', () => {
			const descriptors = Object.getOwnPropertyDescriptors(Map.prototype)
			const first = Symbol('first')
			const second = Symbol('second')
			const container = createContainer()
			container.bind(first, 'one')
			const poison = (): never => { throw new Error('poisoned Map intrinsic') }
			let firstValue: string
			let secondValue: string | undefined
			let containsFirst: boolean
			let removedFirst: boolean

			try {
				for (const method of ['get', 'set', 'has', 'delete'] as const) {
					Object.defineProperty(Map.prototype, method, {
						configurable: true, writable: true, value: poison
					})
				}
				firstValue = container.get(first)
				containsFirst = container.has(first)
				container.bind(second, 'two')
				secondValue = container.tryGet(second)
				removedFirst = container.unbind!(first)
			} finally {
				Object.defineProperties(Map.prototype, descriptors)
			}

			expect(firstValue!).toBe('one')
			expect(containsFirst!).toBe(true)
			expect(secondValue!).toBe('two')
			expect(removedFirst!).toBe(true)
			expect(container.has(first)).toBe(false)
		})

		it('rejects non-symbol tokens without invoking coercion hooks', () => {
			const container = createContainer()
			const coercion = vi.fn(() => 'hostile')
			const token = {[Symbol.toPrimitive]: coercion}

			expect(() => container.get(token as never)).toThrow('must be a symbol')
			expect(() => container.bind(token as never, 'value')).toThrow('must be a symbol')
			expect(coercion).not.toHaveBeenCalled()
		})

		it('contains a rejected native promise bound as an opaque service value', async() => {
			const container = createContainer()
			const token = Symbol('async-service')
			const service = Promise.reject(new Error('bound service rejected'))

			container.bind(token, service)
			expect(container.get(token)).toBe(service)
			await Promise.resolve()
		})
	})
})
