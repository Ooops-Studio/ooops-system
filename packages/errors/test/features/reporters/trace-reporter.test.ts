/**
 * @file Tests for trace reporter.
 */

import {describe, expect, it, vi, beforeEach} from 'vitest'

import {reportToTrace} from '../../../src/features/reporters/trace-reporter'
import type {EnrichedError} from '../../../src/types/normalized-error'
import type {TracerPort} from '../../../src/types/ports'

describe('reportToTrace', () => {
	let mockTracer: TracerPort

	beforeEach(() => {
		mockTracer = {
			recordException: vi.fn(),
			addBreadcrumb: vi.fn(),
			currentTraceId: vi.fn()
		}
	})

	it('does nothing when tracer port is not provided', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await reportToTrace(error)

		expect(mockTracer.recordException).not.toHaveBeenCalled()
		expect(mockTracer.addBreadcrumb).not.toHaveBeenCalled()
	})

	it('does not report tracing-service failures back through the failing tracer', async() => {
		await reportToTrace({
			kind: 'Error', message: 'export failed', severity: 'error',
			category: 'UNKNOWN', source: 'tracing', timestamp: 1
		}, mockTracer)

		expect(mockTracer.recordException).not.toHaveBeenCalled()
		expect(mockTracer.addBreadcrumb).not.toHaveBeenCalled()
	})

	it('records exception when recordException is available', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now(),
			traceId: 'trace-id',
			correlationId: 'correlation-id'
		}

		await reportToTrace(error, mockTracer)

		expect(mockTracer.recordException).toHaveBeenCalledWith(error, {
			traceId: 'trace-id',
			correlationId: 'correlation-id'
		})
	})

	it('uses currentTraceId when error traceId is not available', async() => {
		vi.mocked(mockTracer.currentTraceId!).mockReturnValue('current-trace-id')
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now(),
			correlationId: 'correlation-id'
		}

		await reportToTrace(error, mockTracer)

		expect(mockTracer.recordException).toHaveBeenCalledWith(error, {
			traceId: 'current-trace-id',
			correlationId: 'correlation-id'
		})
	})

	it('adds breadcrumb when addBreadcrumb is available', async() => {
		const error: EnrichedError = {
			kind: 'TypeError',
			message: 'Test error',
			severity: 'error',
			category: 'VALIDATION',
			code: 'TEST_CODE',
			timestamp: Date.now(),
			correlationId: 'correlation-id',
			traceId: 'trace-id'
		}

		await reportToTrace(error, mockTracer)

		expect(mockTracer.addBreadcrumb).toHaveBeenCalledWith({
			category: 'error',
			message: 'Test error',
			level: 'error',
			data: {
				kind: 'TypeError',
				code: 'TEST_CODE',
				category: 'VALIDATION',
				correlationId: 'correlation-id',
				traceId: 'trace-id'
			}
		})
	})

	it('redacts direct reporter input before it reaches the tracer', async() => {
		await reportToTrace({
			kind: 'Error',
			message: 'token=secret-token user@example.com',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now(),
			context: {cookie: 'session=secret-token'}
		}, mockTracer)

		const serialized = JSON.stringify({
			exception: vi.mocked(mockTracer.recordException).mock.calls[0],
			breadcrumb: vi.mocked(mockTracer.addBreadcrumb).mock.calls[0]
		})
		expect(serialized).not.toContain('secret-token')
		expect(serialized).not.toContain('user@example.com')
	})

	it('propagates tracer errors so reportAll can record delivery failure', async() => {
		mockTracer.recordException = vi.fn().mockImplementation(() => {
			throw new Error('Tracer error')
		})

		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await expect(reportToTrace(error, mockTracer)).rejects.toThrow('Tracer error')
	})

	it('does not settle until every sibling trace write has settled', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		mockTracer.recordException = vi.fn(async() => { throw new Error('exception failed') })
		mockTracer.addBreadcrumb = vi.fn(async() => { await gate })
		const pending = reportToTrace({
			kind: 'Error', message: 'failure', severity: 'error',
			category: 'UNKNOWN', timestamp: 1
		}, mockTracer)
		let settled = false
		void pending.finally(() => { settled = true }).catch(() => undefined)

		for (let index = 0; index < 3; index++) await Promise.resolve()
		expect(settled).toBe(false)
		release()
		await expect(pending).rejects.toThrow('exception failed')
	})
})
