import {AsyncLocalStorage} from 'node:async_hooks'

import {describe, it, expect, vi} from 'vitest'

import {
	runWithContext,
	runWithContextAsync,
	getCorrelationId,
	getContext
} from '../../../src/runtime/context/async-context'

describe('async-context', () => {
	describe('runWithContext', () => {
		it('should run function with correlation ID', () => {
			const result = runWithContext(() => {
				return getCorrelationId()
			}, {correlationId: 'test-id'})

			expect(result).toBe('test-id')
		})

		it('should generate correlation ID if not provided', () => {
			const result = runWithContext(() => {
				return getCorrelationId()
			})

			expect(result).toBeDefined()
			expect(typeof result).toBe('string')
			expect(result.length).toBeGreaterThan(0)
		})

		it('should run function with full context', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {
				correlationId: 'test-id',
				traceId: 'trace-123',
				spanId: 'span-456',
				tenantId: 'tenant-789',
				userId: 'user-abc'
			})

			expect(result).toEqual({
				correlationId: 'test-id',
				traceId: 'trace-123',
				spanId: 'span-456',
				tenantId: 'tenant-789',
				userId: 'user-abc'
			})
		})

		it('should run function with partial context', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {
				correlationId: 'test-id',
				traceId: 'trace-123'
			})

			expect(result).toEqual({
				correlationId: 'test-id',
				traceId: 'trace-123'
			})
		})

		it('should return function result', () => {
			const result = runWithContext(() => {
				return 'test-result'
			})

			expect(result).toBe('test-result')
		})

		it('should handle nested contexts', () => {
			const outer = runWithContext(() => {
				const inner = runWithContext(() => {
					return getCorrelationId()
				}, {correlationId: 'inner-id'})

				return {
					outer: getCorrelationId(),
					inner
				}
			}, {correlationId: 'outer-id'})

			expect(outer.outer).toBe('outer-id')
			expect(outer.inner).toBe('inner-id')
		})

		it('should handle context outside of runWithContext', () => {
			const result = getCorrelationId()
			expect(result).toBeUndefined()
		})

		it('does not expose forged request context after a callback rewires AsyncLocalStorage', () => {
			const descriptor = Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'getStore')!
			let observed: ReturnType<typeof getContext>

			try {
				runWithContext(() => {
					Object.defineProperty(AsyncLocalStorage.prototype, 'getStore', {
						configurable: true,
						writable: true,
						value: () => ({correlationId: 'forged', tenantId: 'other-tenant'})
					})
				}, {correlationId: 'safe', tenantId: 'safe-tenant'})
				observed = getContext()
			} finally {
				Object.defineProperty(AsyncLocalStorage.prototype, 'getStore', descriptor)
			}

			expect(observed).toBeUndefined()
		})

		it('does not inherit polluted request identity fields from Object.prototype', () => {
			let observed: ReturnType<typeof getContext>
			try {
				Object.defineProperties(Object.prototype, {
					correlationId: {configurable: true, value: 'forged-correlation'},
					traceId: {configurable: true, value: 'forged-trace'},
					tenantId: {configurable: true, value: 'other-tenant'}
				})
				observed = runWithContext(() => getContext())
			} finally {
				delete (Object.prototype as Record<string, unknown>).correlationId
				delete (Object.prototype as Record<string, unknown>).traceId
				delete (Object.prototype as Record<string, unknown>).tenantId
			}

			expect(observed?.correlationId).not.toBe('forged-correlation')
			expect(observed?.traceId).toBeUndefined()
			expect(observed?.tenantId).toBeUndefined()
			expect(Object.getPrototypeOf(observed)).toBeNull()
		})

		it('should handle function that throws', () => {
			expect(() => {
				runWithContext(() => {
					throw new Error('Test error')
				}, {correlationId: 'test-id'})
			}).toThrow('Test error')
		})

		it('should handle async function that throws', async() => {
			await expect(runWithContextAsync(async() => {
				throw new Error('Async error')
			}, {correlationId: 'test-id'})).rejects.toThrow('Async error')
		})

		it('contains rejected native promises thrown as synchronous errors', async() => {
			const syncReason = Promise.reject(new Error('sync context rejection'))
			expect(() => runWithContext(() => { throw syncReason })).toThrow()

			const asyncReason = Promise.reject(new Error('async context rejection'))
			await expect(runWithContextAsync(() => { throw asyncReason })).rejects.toBe(asyncReason)
			await Promise.resolve()
		})

		it('contains rejected promises supplied as invalid callbacks', async() => {
			const syncCallback = Promise.reject(new Error('sync callback rejected'))
			expect(() => runWithContext(syncCallback as never)).toThrow(TypeError)
			const asyncCallback = Promise.reject(new Error('async callback rejected'))
			await expect(runWithContextAsync(asyncCallback as never)).rejects.toThrow(TypeError)
			await Promise.resolve()
		})

		it('should handle only traceId in context', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {traceId: 'trace-123'})

			expect(result).toEqual({
				correlationId: expect.any(String),
				traceId: 'trace-123'
			})
		})

		it('should handle only spanId in context', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {spanId: 'span-456'})

			expect(result).toEqual({
				correlationId: expect.any(String),
				spanId: 'span-456'
			})
		})

		it('should handle only tenantId in context', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {tenantId: 'tenant-789'})

			expect(result).toEqual({
				correlationId: expect.any(String),
				tenantId: 'tenant-789'
			})
		})

		it('should handle only userId in context', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {userId: 'user-abc'})

			expect(result).toEqual({
				correlationId: expect.any(String),
				userId: 'user-abc'
			})
		})

		it('does not invoke accessor-backed context fields', () => {
			let reads = 0
			const context = Object.create(null) as Record<string, unknown>
			Object.defineProperty(context, 'correlationId', {
				enumerable: true,
				get() { reads += 1; throw new Error('must not execute') }
			})

			const result = runWithContext(() => getContext(), context as never)

			expect(reads).toBe(0)
			expect(result?.correlationId).toEqual(expect.any(String))
		})

		it('rejects proxied context before descriptor traps', () => {
			const getOwnPropertyDescriptor = vi.fn(() => undefined)
			const context = new Proxy({correlationId: 'unsafe'}, {getOwnPropertyDescriptor})

			const result = runWithContext(() => getContext(), context)

			expect(result?.correlationId).toEqual(expect.any(String))
			expect(result?.correlationId).not.toBe('unsafe')
			expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		})

		it('contains rejected promises supplied as context data', async() => {
			const context = Promise.reject(new Error('context rejected'))
			const result = runWithContext(() => getContext(), context as never)
			expect(result?.correlationId).toEqual(expect.any(String))
			const field = Promise.reject(new Error('field rejected'))
			runWithContext(() => getContext(), {traceId: field as never})
			await Promise.resolve()
		})

		it('does not retain oversized context identifiers in the async subtree', () => {
			const oversized = 'x'.repeat(257)
			const result = runWithContext(() => getContext(), {
				correlationId: oversized,
				traceId: oversized,
				spanId: oversized,
				tenantId: oversized,
				userId: oversized
			})

			expect(result).toEqual({correlationId: expect.any(String)})
			expect(result?.correlationId).not.toBe(oversized)
		})

		it('should preserve context in nested async operations', async() => {
			const result = await runWithContextAsync(async() => {
				await new Promise((resolve) => setTimeout(resolve, 10))
				const inner = await runWithContextAsync(async() => {
					await new Promise((resolve) => setTimeout(resolve, 10))
					return getCorrelationId()
				}, {correlationId: 'inner-id'})
				return {
					outer: getCorrelationId(),
					inner
				}
			}, {correlationId: 'outer-id'})

			expect(result.outer).toBe('outer-id')
			expect(result.inner).toBe('inner-id')
		})
	})

	describe('runWithContextAsync', () => {
		it('does not read a caller-owned then accessor on the operation promise', async() => {
			const then = vi.fn(() => Promise.prototype.then)
			const completion = Promise.resolve('result')
			Object.defineProperty(completion, 'then', {get: then})

			await expect(runWithContextAsync(() => completion)).resolves.toBe('result')
			expect(then).not.toHaveBeenCalled()
		})

		it('should run async function with correlation ID', async() => {
			const result = await runWithContextAsync(async() => {
				return getCorrelationId()
			}, {correlationId: 'test-id'})

			expect(result).toBe('test-id')
		})

		it('should generate correlation ID if not provided', async() => {
			const result = await runWithContextAsync(async() => {
				return getCorrelationId()
			})

			expect(result).toBeDefined()
			expect(typeof result).toBe('string')
		})

		it('should run async function with full context', async() => {
			const result = await runWithContextAsync(async() => {
				return getContext()
			}, {
				correlationId: 'test-id',
				traceId: 'trace-123',
				spanId: 'span-456',
				tenantId: 'tenant-789',
				userId: 'user-abc'
			})

			expect(result).toEqual({
				correlationId: 'test-id',
				traceId: 'trace-123',
				spanId: 'span-456',
				tenantId: 'tenant-789',
				userId: 'user-abc'
			})
		})

		it('should preserve context across async operations', async() => {
			const result = await runWithContextAsync(async() => {
				await new Promise((resolve) => setTimeout(resolve, 10))
				return getCorrelationId()
			}, {correlationId: 'async-id'})

			expect(result).toBe('async-id')
		})

		it('should handle nested async contexts', async() => {
			const result = await runWithContextAsync(async() => {
				const inner = await runWithContextAsync(async() => {
					return getCorrelationId()
				}, {correlationId: 'inner-async-id'})

				return {
					outer: getCorrelationId(),
					inner
				}
			}, {correlationId: 'outer-async-id'})

			expect(result.outer).toBe('outer-async-id')
			expect(result.inner).toBe('inner-async-id')
		})

		it('should return async function result', async() => {
			const result = await runWithContextAsync(async() => {
				return 'async-result'
			})

			expect(result).toBe('async-result')
		})
	})

	describe('getCorrelationId', () => {
		it('should return correlation ID from context', () => {
			const result = runWithContext(() => {
				return getCorrelationId()
			}, {correlationId: 'test-correlation'})

			expect(result).toBe('test-correlation')
		})

		it('should return undefined outside context', () => {
			expect(getCorrelationId()).toBeUndefined()
		})
	})

	describe('getContext', () => {
		it('should return full context', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {
				correlationId: 'test-id',
				traceId: 'trace-123',
				spanId: 'span-456',
				tenantId: 'tenant-789',
				userId: 'user-abc'
			})

			expect(result).toEqual({
				correlationId: 'test-id',
				traceId: 'trace-123',
				spanId: 'span-456',
				tenantId: 'tenant-789',
				userId: 'user-abc'
			})
		})

		it('should return partial context', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {
				correlationId: 'test-id',
				traceId: 'trace-123'
			})

			expect(result).toEqual({
				correlationId: 'test-id',
				traceId: 'trace-123'
			})
		})

		it('should return undefined outside context', () => {
			expect(getContext()).toBeUndefined()
		})

		it('should only include defined fields', () => {
			const result = runWithContext(() => {
				return getContext()
			}, {
				correlationId: 'test-id'
			})

			expect(result).toEqual({
				correlationId: 'test-id'
			})
			expect(result).not.toHaveProperty('traceId')
			expect(result).not.toHaveProperty('spanId')
		})
	})
})
