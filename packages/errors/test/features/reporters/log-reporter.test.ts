/**
 * @file Tests for log reporter.
 */

import {describe, expect, it, vi, beforeEach} from 'vitest'

import {reportToLog} from '../../../src/features/reporters/log-reporter'
import type {EnrichedError} from '../../../src/types/normalized-error'
import type {LoggerPort} from '../../../src/types/ports'

describe('reportToLog', () => {
	let mockLogger: LoggerPort

	beforeEach(() => {
		mockLogger = {
			level: 'info' as const,
			fatal: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			info: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
			context: vi.fn().mockReturnThis()
		}
	})

	it('does nothing when logger is not provided', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await reportToLog(error)

		expect(mockLogger.error).not.toHaveBeenCalled()
	})

	it('logs error with fatal level for fatal severity', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Fatal error',
			severity: 'fatal',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await reportToLog(error, mockLogger)

		expect(mockLogger.fatal).toHaveBeenCalledWith(
			'Fatal error',
			expect.objectContaining({
				kind: 'Error',
				category: 'UNKNOWN'
			})
		)
	})

	it('logs error with error level for error severity', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await reportToLog(error, mockLogger)

		expect(mockLogger.error).toHaveBeenCalledWith(
			'Test error',
			expect.objectContaining({
				kind: 'Error',
				category: 'UNKNOWN'
			})
		)
	})

	it('includes all error fields in log attributes', async() => {
		const error: EnrichedError = {
			kind: 'TypeError',
			message: 'Test error',
			severity: 'error',
			category: 'VALIDATION',
			timestamp: Date.now(),
			id: 'error-id',
			correlationId: 'correlation-id',
			traceId: 'trace-id',
			source: 'test-source',
			code: 'TEST_CODE',
			stack: 'Error stack',
			context: {
				userId: 'user-123'
			}
		}

		await reportToLog(error, mockLogger)

		expect(mockLogger.error).toHaveBeenCalledWith(
			'Test error',
			expect.objectContaining({
				kind: 'TypeError',
				category: 'VALIDATION',
				id: 'error-id',
				correlationId: 'correlation-id',
				traceId: 'trace-id',
				source: 'test-source',
				code: 'TEST_CODE',
				stack: 'Error stack',
				context: {
					userId: expect.stringMatching(/^hash:/u)
				}
			})
		)
	})

	it('redacts direct reporter input before it reaches logger attributes', async() => {
		await reportToLog({
			kind: 'Error',
			message: 'request failed token=secret-token user@example.com',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now(),
			stack: 'Error: Bearer secret-token',
			context: {authorization: 'Bearer secret-token', password: 'pw'}
		}, mockLogger)

		const [message, attributes] = vi.mocked(mockLogger.error).mock.calls[0] ?? []
		const serialized = JSON.stringify({message, attributes})
		expect(serialized).not.toContain('secret-token')
		expect(serialized).not.toContain('user@example.com')
		expect(serialized).not.toContain('"pw"')
	})

	it('logs error with warn level for warn severity', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Warning message',
			severity: 'warn',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await reportToLog(error, mockLogger)

		expect(mockLogger.warn).toHaveBeenCalledWith(
			'Warning message',
			expect.objectContaining({
				kind: 'Error',
				category: 'UNKNOWN'
			})
		)
		expect(mockLogger.error).not.toHaveBeenCalled()
		expect(mockLogger.fatal).not.toHaveBeenCalled()
	})

	it('logs error with info level for info severity', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Info message',
			severity: 'info',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await reportToLog(error, mockLogger)

		expect(mockLogger.info).toHaveBeenCalledWith(
			'Info message',
			expect.objectContaining({
				kind: 'Error',
				category: 'UNKNOWN'
			})
		)
		expect(mockLogger.error).not.toHaveBeenCalled()
		expect(mockLogger.warn).not.toHaveBeenCalled()
		expect(mockLogger.fatal).not.toHaveBeenCalled()
	})

	it('propagates logger errors so reportAll can record delivery failure', async() => {
		mockLogger.error = vi.fn().mockImplementation(() => {
			throw new Error('Logger error')
		})

		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await expect(reportToLog(error, mockLogger)).rejects.toThrow('Logger error')
	})

	it('skips logging-originated errors to avoid recursion', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Sink failed',
			severity: 'error',
			category: 'RESOURCE',
			timestamp: Date.now(),
			source: 'logging'
		}

		await reportToLog(error, mockLogger)

		expect(mockLogger.error).not.toHaveBeenCalled()
		expect(mockLogger.warn).not.toHaveBeenCalled()
		expect(mockLogger.info).not.toHaveBeenCalled()
		expect(mockLogger.fatal).not.toHaveBeenCalled()
	})
})
