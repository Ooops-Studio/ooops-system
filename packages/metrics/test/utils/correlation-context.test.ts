import {getContext} from '@ooopsstudio/core/runtime/context'
import {describe, it, expect, beforeEach, vi} from 'vitest'

import {
	createExemplar,
	extractCorrelationContext
} from '../../src/utils/correlation-context'

vi.mock('@ooopsstudio/core/runtime/context', () => ({
	getContext: vi.fn()
}))

describe('correlation-context', () => {

	beforeEach(() => {

		// Clear context before each test
		vi.mocked(getContext).mockReturnValue(undefined)
	})

	describe('extractCorrelationContext', () => {

		it('should return empty object when no context', () => {

			const context = extractCorrelationContext()

			expect(context).toEqual({})
		})

		it('should extract traceId and spanId', () => {

			vi.mocked(getContext).mockReturnValue({
				traceId: 'trace123',
				spanId: 'span456'
			})

			const context = extractCorrelationContext()

			expect(context.traceId).toBe('trace123')
			expect(context.spanId).toBe('span456')
		})

		it('should extract tenantId and userId', () => {

			vi.mocked(getContext).mockReturnValue({
				tenantId: 'tenant123',
				userId: 'user456'
			})

			const context = extractCorrelationContext()

			expect(context.tenantId).toBe('tenant123')
			expect(context.userId).toBe('user456')
		})

		it('should extract all correlation fields', () => {

			vi.mocked(getContext).mockReturnValue({
				traceId: 'trace123',
				spanId: 'span456',
				tenantId: 'tenant123',
				userId: 'user456'
			})

			const context = extractCorrelationContext()

			expect(context).toEqual({
				traceId: 'trace123',
				spanId: 'span456',
				tenantId: 'tenant123',
				userId: 'user456'
			})
		})

		it('should only include defined fields', () => {

			vi.mocked(getContext).mockReturnValue({
				traceId: 'trace123',
				tenantId: 'tenant123'
			} as ReturnType<typeof getContext>)

			const context = extractCorrelationContext()

			expect(context.traceId).toBe('trace123')
			expect(context.spanId).toBeUndefined()
			expect(context.tenantId).toBe('tenant123')
			expect(context.userId).toBeUndefined()
		})
	})

	describe('createExemplar', () => {

		it('should return undefined when no trace context', () => {

			const exemplar = createExemplar(1.0, 1000)

			expect(exemplar).toBeUndefined()
		})

		it('should create exemplar with traceId', () => {

			vi.mocked(getContext).mockReturnValue({
				traceId: 'trace123'
			})

			const exemplar = createExemplar(1.0, 1000)

			expect(exemplar).toEqual({
				value: 1.0,
				timestamp: 1000,
				traceId: 'trace123'
			})
		})

		it('should create exemplar with spanId', () => {

			vi.mocked(getContext).mockReturnValue({
				spanId: 'span456'
			})

			const exemplar = createExemplar(2.0, 2000)

			expect(exemplar).toEqual({
				value: 2.0,
				timestamp: 2000,
				spanId: 'span456'
			})
		})

		it('should create exemplar with all fields', () => {

			vi.mocked(getContext).mockReturnValue({
				traceId: 'trace123',
				spanId: 'span456',
				tenantId: 'tenant123',
				userId: 'user456'
			})

			const exemplar = createExemplar(3.0, 3000)

			expect(exemplar).toEqual({
				value: 3.0,
				timestamp: 3000,
				traceId: 'trace123',
				spanId: 'span456',
				tenantId: 'tenant123',
				userId: 'user456'
			})
		})

		it('should only include defined fields in exemplar', () => {

			vi.mocked(getContext).mockReturnValue({
				traceId: 'trace123',
				tenantId: 'tenant123'
			} as ReturnType<typeof getContext>)

			const exemplar = createExemplar(4.0, 4000)

			expect(exemplar).toEqual({
				value: 4.0,
				timestamp: 4000,
				traceId: 'trace123',
				tenantId: 'tenant123'
			})
			expect(exemplar?.spanId).toBeUndefined()
			expect(exemplar?.userId).toBeUndefined()
		})

		it('drops oversized correlation fields before they can be retained', () => {
			vi.mocked(getContext).mockReturnValue({
				traceId: 't'.repeat(33),
				spanId: 'span456',
				tenantId: 'x'.repeat(257),
				userId: 'user456'
			})

			expect(createExemplar(1, 1)).toEqual({
				value: 1,
				timestamp: 1,
				spanId: 'span456',
				userId: 'user456'
			})
			vi.mocked(getContext).mockReturnValue({traceId: 't'.repeat(33), spanId: 's'.repeat(17)})
			expect(createExemplar(1, 1)).toBeUndefined()
		})
	})
})
