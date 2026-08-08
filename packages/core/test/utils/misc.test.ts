import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import {sleep, formatErrorMessage} from '../../src/utils/misc'

describe('misc utils', () => {
	describe('sleep', () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('should resolve after specified milliseconds', async() => {
			const promise = sleep(1000)
			vi.advanceTimersByTime(1000)
			await promise

			expect(true).toBe(true) // If we get here, promise resolved
		})

		it('should resolve after zero milliseconds', async() => {
			const promise = sleep(0)
			vi.advanceTimersByTime(0)
			await promise

			expect(true).toBe(true)
		})

		it('should handle different delay values', async() => {
			const promise1 = sleep(100)
			const promise2 = sleep(500)
			const promise3 = sleep(1000)

			vi.advanceTimersByTime(100)
			await promise1

			vi.advanceTimersByTime(400)
			await promise2

			vi.advanceTimersByTime(500)
			await promise3

			expect(true).toBe(true)
		})

		it('rejects delays that the host timer would clamp into a retry storm', async() => {
			await expect(sleep(Number.POSITIVE_INFINITY)).rejects.toThrow('Sleep duration')
			await expect(sleep(-1)).rejects.toThrow('Sleep duration')
			await expect(sleep(1.5)).rejects.toThrow('Sleep duration')
		})

		it('contains a rejected promise returned as a timer handle', async() => {
			const timerFailure = Promise.reject(new Error('timer rejected'))
			const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => timerFailure as never)
			try {
				await expect(sleep(1)).rejects.toThrow('allocated synchronously')
				await Promise.resolve()
			} finally { timer.mockRestore() }
		})
	})

	describe('formatErrorMessage', () => {
		it('should return message when no context is provided', () => {
			expect(formatErrorMessage('Test error')).toBe('Test error')
		})

		it('should return message when context is empty', () => {
			expect(formatErrorMessage('Test error', {})).toBe('Test error')
		})

		it('should format message with single context entry', () => {
			expect(formatErrorMessage('Test error', {operation: 'fetch'})).toBe('Test error (operation=fetch)')
		})

		it('should format message with multiple context entries', () => {
			expect(formatErrorMessage('Test error', {operation: 'fetch', metric: 'requests'})).toBe('Test error (operation=fetch, metric=requests)')
		})

		it('should handle context with special characters', () => {
			expect(formatErrorMessage('Test error', {path: '/api/users', id: '123'})).toBe('Test error (path=/api/users, id=123)')
		})

		it('should handle empty string message', () => {
			expect(formatErrorMessage('', {operation: 'test'})).toBe(' (operation=test)')
		})

		it('should handle context with empty values', () => {
			expect(formatErrorMessage('Test error', {key: ''})).toBe('Test error (key=)')
		})

		it('does not invoke context accessors and bounds diagnostic expansion', () => {
			let reads = 0
			const accessor = Object.defineProperty({safe: 'value'}, 'secret', {
				enumerable: true,
				get: () => { reads++; return 'exposed' }
			}) as Record<string, string>
			expect(formatErrorMessage('failure', accessor)).toBe('failure (safe=value)')
			expect(reads).toBe(0)

			const wide = Object.fromEntries(Array.from({length: 10_000}, (_, index) => [
				`field-${index}`, 'x'.repeat(10_000)
			]))
			const formatted = formatErrorMessage('failure', wide)
			expect(formatted.length).toBeLessThanOrEqual(32_768)
			expect(formatted).not.toContain('field-9999')
		})

		it('escapes control characters in diagnostic context', () => {
			expect(formatErrorMessage('failure', {operation: 'line1\nline2'}))
				.toBe('failure (operation=line1\\nline2)')
		})

		it('does not enumerate proxy diagnostic contexts', () => {
			const ownKeys = vi.fn(() => ['operation'])
			const context = new Proxy({operation: 'unsafe'}, {ownKeys})

			expect(formatErrorMessage('failure', context)).toBe('failure')
			expect(ownKeys).not.toHaveBeenCalled()
		})

		it('does not enumerate diagnostic contexts with a proxied prototype', () => {
			const ownKeys = vi.fn(() => ['inherited'])
			const getOwnPropertyDescriptor = vi.fn(() => ({
				value: 'unsafe', enumerable: true, configurable: true, writable: true
			}))
			const prototype = new Proxy({}, {ownKeys, getOwnPropertyDescriptor})
			const context = Object.create(prototype) as Record<string, string>
			Object.defineProperty(context, 'operation', {value: 'report', enumerable: true})

			expect(formatErrorMessage('failure', context)).toBe('failure')
			expect(ownKeys).not.toHaveBeenCalled()
			expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		})

		it('bounds and escapes messages even without context', () => {
			const formatted = formatErrorMessage(`line1\n${'x'.repeat(100_000)}`)

			expect(formatted.length).toBeLessThanOrEqual(32_768)
			expect(formatted).toContain('line1\\n')
			expect(formatted).not.toContain('\n')
		})

		it('does not consult rewired string iteration or formatting prototypes', () => {
			const iteratorDescriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!
			const charCodeDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!
			const sliceDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'slice')!
			const joinDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'join')!
			let formatted = ''
			const poison = (): never => { throw new Error('poisoned formatting intrinsic') }
			try {
				Object.defineProperties(String.prototype, {
					[Symbol.iterator]: {configurable: true, writable: true, value: poison},
					charCodeAt: {configurable: true, writable: true, value: poison},
					slice: {configurable: true, writable: true, value: poison}
				})
				Object.defineProperty(Array.prototype, 'join', {
					configurable: true, writable: true, value: poison
				})
				formatted = formatErrorMessage('failure\nmessage', {operation: 'report'})
			} finally {
				Object.defineProperty(String.prototype, Symbol.iterator, iteratorDescriptor)
				Object.defineProperty(String.prototype, 'charCodeAt', charCodeDescriptor)
				Object.defineProperty(String.prototype, 'slice', sliceDescriptor)
				Object.defineProperty(Array.prototype, 'join', joinDescriptor)
			}

			expect(formatted).toBe('failure\\nmessage (operation=report)')
		})

		it('keeps malformed runtime messages contained when context is present', () => {
			expect(formatErrorMessage(42 as never, {operation: 'report'}))
				.toBe('Error (operation=report)')
		})

		it('contains context failures after inspection and collection intrinsics are rewired', async() => {
			const defineProperty = Object.defineProperty
			const descriptor = Object.getOwnPropertyDescriptor
			const arrayIsArray = descriptor(Array, 'isArray')!
			const arrayPush = descriptor(Array.prototype, 'push')!
			const objectDescriptor = descriptor(Object, 'getOwnPropertyDescriptor')!
			const failure = Promise.reject(new Error('context rejected'))
			let formatted: string | undefined
			try {
				defineProperty(Array, 'isArray', {configurable: true, value: () => { throw new Error('poisoned isArray') }})
				defineProperty(Array.prototype, 'push', {configurable: true, value: () => { throw new Error('poisoned push') }})
				defineProperty(Object, 'getOwnPropertyDescriptor', {configurable: true, value: () => { throw new Error('poisoned descriptor') }})
				formatted = formatErrorMessage('failure', {operation: 'report', failure: failure as never})
			} finally {
				defineProperty(Array, 'isArray', arrayIsArray)
				defineProperty(Array.prototype, 'push', arrayPush)
				defineProperty(Object, 'getOwnPropertyDescriptor', objectDescriptor)
			}

			expect(formatted).toBe('failure (operation=report)')
			await Promise.resolve()
		})
	})
})
