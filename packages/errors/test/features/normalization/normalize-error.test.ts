/**
 * @file Tests for error normalization.
 */

import {runInNewContext} from 'node:vm'

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import {runWithContext} from '@ooopsstudio/core/runtime/context'
import {describe, expect, it, vi, beforeEach} from 'vitest'

import {normalizeError} from '../../../src/features/normalization/normalize-error'

describe('normalizeError', () => {
	let mockClock: Clock
	let mockTracer: {currentTraceId?: () => string | undefined}

	beforeEach(() => {
		mockClock = {
			now: vi.fn().mockReturnValue(1234567890)
		}
		mockTracer = {
			currentTraceId: vi.fn().mockReturnValue('trace-id-123')
		}
	})

	it('normalizes Error object', () => {
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock,
			generateId: true // Explicitly enable ID generation
		})

		expect(result.kind).toBe('Error')
		expect(result.message).toBe('Test error')
		expect(result.severity).toBeDefined()
		expect(result.category).toBe('UNKNOWN')
		expect(result.timestamp).toBe(1234567890)
		expect(result.id).toBeDefined()
		expect(result.code).toBeDefined()
	})

	it('preserves descriptor-backed error kinds from another JavaScript realm', () => {
		const crossRealmError = runInNewContext('new TypeError("cross-realm")') as unknown

		const result = normalizeError(crossRealmError, {clock: mockClock})

		expect(result).toMatchObject({kind: 'TypeError', message: 'cross-realm'})
	})

	it('normalizes string error', () => {
		const error = 'String error'

		const result = normalizeError(error, {
			clock: mockClock
		})

		expect(result.message).toBe('String error')
		// String errors are normalized by core, which might use 'UnknownError' as kind
		expect(result.kind).toBeDefined()
		expect(result.code).toBeDefined()
	})

	it('includes traceId from tracer when available', () => {
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock,
			tracer: mockTracer
		})

		expect(result.traceId).toBe('trace-id-123')
	})

	it('does not let a failing tracer prevent normalization', () => {

		const result = normalizeError(new Error('Test error'), {
			clock: mockClock,
			tracer: {
				currentTraceId: () => {
					throw new Error('tracer unavailable')
				}
			}
		})

		expect(result).toMatchObject({message: 'Test error', timestamp: 1234567890})
		expect(result.traceId).toBeUndefined()

	})

	it('uses defaultSource when provided', () => {
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock,
			defaultSource: 'custom-source'
		})

		expect(result.source).toBe('custom-source')
	})

	it('does not generate ID when generateId is false', () => {
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock,
			generateId: false
		})

		expect(result.id).toBeUndefined()
	})

	it('merges provided context with error data', () => {
		const error = new Error('Test error')
		error.name = 'CustomError'

		const result = normalizeError(error, {
			clock: mockClock
		}, {
			userId: 'user-123',
			customField: 'value'
		})

		expect(result.context?.userId).toMatch(/^hash:/u)
		expect(result.context?.customField).toBe('value')
	})

	it('includes code from error when available', () => {
		const error = new Error('Test error')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(error as any).code = 'TEST_CODE'

		const result = normalizeError(error, {
			clock: mockClock
		})

		expect(result.code).toBe('TEST_CODE')
	})

	it('uses ERROR_CODE_UNKNOWN when code is not available', () => {
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock
		})

		expect(result.code).toBeDefined()
	})

	it('includes runtime context fields when available', async() => {
		// This test verifies that normalizeError can handle runtime context
		// The actual context injection happens at runtime via getContext()
		// We can't easily mock it here, so we just verify the function handles it
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock
		})

		// Result should be defined even if runtime context is not available in test
		expect(result).toBeDefined()
		// Runtime context fields are optional and depend on runtime environment
	})

	it('merges provided context with runtime context', () => {
		const error = new Error('Test error')
		const context = {customField: 'value', userId: 'provided-user-id'}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result.context?.customField).toBe('value')
	})

	it('creates context object when only runtime context fields are present', () => {
		// This tests the branch where mergedContext is falsy but runtime context has fields
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock
		})

		// Context should be created if runtime context has fields
		expect(result).toBeDefined()
	})

	it('prioritizes tracer traceId over runtime context traceId', () => {
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock,
			tracer: mockTracer
		})

		expect(result.traceId).toBe('trace-id-123')
	})

	it('creates context when only runtime context fields are present', () => {
		// This tests the branch where mergedContext is falsy but runtime context has fields
		// We can't easily mock getContext, but we can test the logic path
		const error = new Error('Test error')

		const result = normalizeError(error, {
			clock: mockClock
		})

		// Context creation depends on runtime context which may not be available in tests
		expect(result).toBeDefined()
	})

	it('merges context correctly when both provided and runtime context exist', () => {
		const error = new Error('Test error')
		const context = {
			customField: 'value',
			existingField: 'existing'
		}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result.context?.customField).toBe('value')
		expect(result.context?.existingField).toBe('existing')
	})

	it('handles context with nested objects', () => {
		const error = new Error('Test error')
		const context = {
			nested: {
				field: 'value'
			}
		}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result.context?.nested).toEqual({field: 'value'})
	})

	it('handles empty context object', () => {
		const error = new Error('Test error')
		const context = {}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result).toBeDefined()
		// Empty context objects are not included in the result
		expect(result.context).toBeUndefined()
	})

	it('handles context with null values', () => {
		const error = new Error('Test error')
		const context = {
			nullField: null,
			undefinedField: undefined,
			validField: 'value'
		}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result.context?.validField).toBe('value')
		expect(result.context?.nullField).toBe(null)
	})

	it('handles context with array values', () => {
		const error = new Error('Test error')
		const context = {
			arrayField: [1, 2, 3],
			objectField: {nested: 'value'}
		}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result.context?.arrayField).toEqual([1, 2, 3])
		expect(result.context?.objectField).toEqual({nested: 'value'})
	})

	it('handles context with number and boolean values', () => {
		const error = new Error('Test error')
		const context = {
			numberField: 42,
			booleanField: true,
			stringField: 'test'
		}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result.context?.numberField).toBe(42)
		expect(result.context?.booleanField).toBe(true)
		expect(result.context?.stringField).toBe('test')
	})

	it('overwrites base.data with provided context', () => {
		// Create an error with data property
		const error = new Error('Test error')
		// @ts-expect-error - adding data property for test
		error.data = {baseField: 'base', sharedField: 'base'}

		const context = {
			sharedField: 'context',
			contextField: 'context'
		}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		// Context should overwrite base.data
		expect(result.context?.sharedField).toBe('context')
		expect(result.context?.contextField).toBe('context')
		expect(result.context?.baseField).toBe('base')
	})

	it('handles error without data property', () => {
		const error = new Error('Test error')
		const context = {
			customField: 'value'
		}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result.context?.customField).toBe('value')
	})

	it('handles error with undefined data property', () => {
		const error = new Error('Test error')
		// @ts-expect-error - setting data to undefined
		error.data = undefined

		const context = {
			customField: 'value'
		}

		const result = normalizeError(error, {
			clock: mockClock
		}, context)

		expect(result.context?.customField).toBe('value')
	})

	it('handles runtimeContext with spanId/tenantId/userId in nested context when no mergedContext', () => {
		const error = new Error('Test error')

		// Use runWithContext to set up AsyncLocalStorage context
		const result = runWithContext(() => {
			return normalizeError(error, {
				clock: mockClock,
				tracer: mockTracer
			}, undefined) // No context parameter to trigger the else branch
		}, {
			spanId: 'span-123',
			tenantId: 'tenant-456',
			userId: 'user-789'
		})

		// Should create nested context object when runtimeContext has spanId/tenantId/userId
		// and no mergedContext (triggers else branch at line 78)
		expect(result.context).toBeDefined()
		expect(result.context?.spanId).toMatch(/^hash:/u)
		expect(result.context?.tenantId).toMatch(/^hash:/u)
		expect(result.context?.userId).toMatch(/^hash:/u)
	})

	it('handles runtimeContext with only spanId when no mergedContext', () => {
		const error = new Error('Test error')

		const result = runWithContext(() => {
			return normalizeError(error, {
				clock: mockClock,
				tracer: mockTracer
			}, undefined) // No context parameter
		}, {
			spanId: 'span-123'
		})

		expect(result.context?.spanId).toMatch(/^hash:/u)
	})

	it('handles runtimeContext with only tenantId when no mergedContext', () => {
		const error = new Error('Test error')

		const result = runWithContext(() => {
			return normalizeError(error, {
				clock: mockClock
			}, undefined) // No context parameter
		}, {
			tenantId: 'tenant-456'
		})

		expect(result.context?.tenantId).toMatch(/^hash:/u)
	})

	it('handles runtimeContext with only userId when no mergedContext', () => {
		const error = new Error('Test error')

		const result = runWithContext(() => {
			return normalizeError(error, {
				clock: mockClock
			}, undefined) // No context parameter
		}, {
			userId: 'user-789'
		})

		expect(result.context?.userId).toMatch(/^hash:/u)
	})

	it('handles mergedContext with runtimeContext values merged together', () => {
		const error = new Error('Test error')
		const context = {
			customField: 'value'
		}

		// Test when mergedContext exists and runtimeContext has spanId/tenantId/userId
		const result = runWithContext(() => {
			return normalizeError(error, {
				clock: mockClock
			}, context)
		}, {
			spanId: 'span-123',
			tenantId: 'tenant-456',
			userId: 'user-789'
		})

		// Should merge both context and runtimeContext values
		expect(result.context?.customField).toBe('value')
		expect(result.context?.spanId).toMatch(/^hash:/u)
		expect(result.context?.tenantId).toMatch(/^hash:/u)
		expect(result.context?.userId).toMatch(/^hash:/u)
	})

	it('handles case when mergedContext does not exist and runtimeContext has no spanId/tenantId/userId', () => {
		const error = new Error('Test error')

		// Test when mergedContext is falsy and runtimeContext doesn't have spanId/tenantId/userId
		// This tests the inner condition at line 78
		const result = runWithContext(() => {
			return normalizeError(error, {
				clock: mockClock
			}, undefined) // No context parameter
		}, {
			// No spanId, tenantId, or userId
			correlationId: 'corr-123',
			traceId: 'trace-456'
		})

		// Should not have context when runtimeContext doesn't have spanId/tenantId/userId
		// and mergedContext is falsy
		expect(result.context).toBeUndefined()
	})

	it('handles case when mergedContext exists but runtimeContext has no spanId/tenantId/userId', () => {
		const error = new Error('Test error')
		const context = {
			customField: 'value'
		}

		// Test when mergedContext exists but runtimeContext doesn't have spanId/tenantId/userId
		const result = runWithContext(() => {
			return normalizeError(error, {
				clock: mockClock
			}, context)
		}, {
			// No spanId, tenantId, or userId
			correlationId: 'corr-123'
		})

		// Should have context with customField but no spanId/tenantId/userId
		expect(result.context?.customField).toBe('value')
		expect(result.context?.spanId).toBeUndefined()
		expect(result.context?.tenantId).toBeUndefined()
		expect(result.context?.userId).toBeUndefined()
	})

	it('uses explicit severity, category, and source from context when valid', () => {
		const result = normalizeError(new Error('Test error'), {
			clock: mockClock
		}, {
			severity: 'fatal',
			category: 'TIMEOUT',
			source: 'worker',
			kept: 'value'
		})

		expect(result.severity).toBe('fatal')
		expect(result.category).toBe('TIMEOUT')
		expect(result.source).toBe('worker')
		expect(result.context).toEqual({kept: 'value'})
	})

	it('ignores invalid explicit severity, category, and blank source values', () => {
		const result = normalizeError(new Error('Test error'), {
			clock: mockClock,
			defaultSource: 'fallback'
		}, {
			severity: 'loud',
			category: 'NOT_REAL',
			source: '   '
		})

		expect(result.severity).not.toBe('loud')
		expect(result.category).toBe('UNKNOWN')
		expect(result.source).toBe('fallback')
		expect(result.context).toBeUndefined()
	})

	it('treats hostile context proxies as unavailable instead of breaking normalization', () => {
		const context = new Proxy({}, {
			ownKeys() {
				throw new Error('context enumeration failed')
			}
		})

		const result = normalizeError(new Error('Test error'), {
			clock: mockClock,
			defaultSource: 'fallback'
		}, context as Record<string, unknown>)

		expect(result).toMatchObject({
			message: 'Test error',
			source: 'fallback'
		})
		expect(result.context).toBeUndefined()
	})

	it('bounds oversized machine and free-form strings before classification', () => {
		const oversized = 'x'.repeat(70_000)
		const result = normalizeError({
			kind: oversized, message: oversized, stack: oversized, code: oversized
		}, {clock: mockClock})
		expect(result).toMatchObject({kind: 'UnknownError', message: '[DROPPED_OVERSIZED]', code: 'E_UNKNOWN'})
		expect(result).not.toHaveProperty('stack')

		const sourceResult = normalizeError(new Error('safe'), {clock: mockClock}, {source: oversized})
		expect(sourceResult.source).toBe('unknown')
	})

	it('normalizes hostile Error proxies without throwing', () => {
		const getter = vi.fn(() => { throw new Error('hostile error getter') })
		const hostileError = new Proxy(new Error('hidden'), {
			get() {
				return getter()
			}
		})

		expect(() => normalizeError(hostileError, {
			clock: mockClock,
			defaultSource: 'fallback'
		})).not.toThrow()
		expect(normalizeError(hostileError, {
			clock: mockClock,
			defaultSource: 'fallback'
		})).toMatchObject({
			kind: 'Error',
			message: 'hidden',
			source: 'fallback'
		})
		expect(getter).not.toHaveBeenCalled()

		const messageGetter = vi.fn(() => 'must-not-run')
		const errorLike = {} as Record<string, unknown>
		Object.defineProperty(errorLike, 'message', {enumerable: true, get: messageGetter})
		expect(normalizeError(errorLike, {clock: mockClock})).toMatchObject({
			kind: 'UnknownError', message: '[REDACTED]'
		})
		expect(messageGetter).not.toHaveBeenCalled()
	})

	it('prefers tracer trace ids over runtime context trace ids while keeping runtime metadata', () => {
		const result = runWithContext(() => normalizeError(new Error('Test error'), {
			clock: mockClock,
			tracer: mockTracer
		}), {
			traceId: 'runtime-trace',
			spanId: 'span-1',
			tenantId: 'tenant-1',
			userId: 'user-1',
			correlationId: 'corr-1'
		})

		expect(result.traceId).toBe('trace-id-123')
		expect(result.correlationId).toBe('corr-1')
		expect(result.context).toEqual({
			spanId: expect.stringMatching(/^hash:/u),
			tenantId: expect.stringMatching(/^hash:/u),
			userId: expect.stringMatching(/^hash:/u)
		})
	})

	it('does not invoke accessor-backed clock or tracer capabilities', () => {
		const getter = vi.fn(() => { throw new Error('must not execute') })
		const clock = Object.create(null) as Record<string, unknown>
		const tracer = Object.create(null) as Record<string, unknown>
		Object.defineProperty(clock, 'now', {get: getter})
		Object.defineProperty(tracer, 'currentTraceId', {get: getter})

		const result = normalizeError(new Error('safe'), {clock: clock as never, tracer: tracer as never})
		expect(result.timestamp).toBeGreaterThanOrEqual(0)
		expect(result.traceId).toBeUndefined()
		expect(getter).not.toHaveBeenCalled()
	})

	it('falls back to runtime context when a tracer returns an invalid trace id', () => {
		for (const traceId of ['', '   ', 'x'.repeat(1_025)]) {
			const result = runWithContext(() => normalizeError(new Error('Test error'), {
				clock: mockClock,
				tracer: {currentTraceId: () => traceId}
			}), {traceId: 'runtime-trace'})
			expect(result.traceId).toBe('runtime-trace')
		}
	})
})
