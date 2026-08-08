import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogContext} from '@ooopsstudio/core/contracts/logging'
import {describe, it, expect, vi} from 'vitest'

import {createLogger} from '../../src/utils/logger-factory'

describe('logger-factory utils', () => {
	describe('createLogger', () => {
		it('should create logger with all log levels', () => {
			const mockEnriching = vi.fn().mockResolvedValue({})
			const mockRedacting = vi.fn().mockResolvedValue({})
			const mockFormatting = vi.fn().mockReturnValue('formatted')
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const mockClock: Clock = {now: vi.fn().mockReturnValue(1234567890000)}

			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				mockClock,
				'info',
				'json'
			)

			expect(logger.level).toBe('info')
			expect(typeof logger.trace).toBe('function')
			expect(typeof logger.debug).toBe('function')
			expect(typeof logger.info).toBe('function')
			expect(typeof logger.warn).toBe('function')
			expect(typeof logger.error).toBe('function')
			expect(typeof logger.fatal).toBe('function')
			expect(typeof logger.context).toBe('function')
		})

		it('should call enriching, redacting, formatting, and transferring', async() => {
			const mockEnriching = vi.fn().mockResolvedValue({level: 'info', message: 'test', time: 1234567890000})
			const mockRedacting = vi.fn().mockResolvedValue({level: 'info', message: 'test', time: 1234567890000})
			const mockFormatting = vi.fn().mockReturnValue('formatted line')
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const mockClock: Clock = {now: vi.fn().mockReturnValue(1234567890000)}

			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				mockClock,
				'info',
				'json'
			)

			logger.info('test message', {userId: '123'})

			// Wait for async operations to complete
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockEnriching).toHaveBeenCalledWith({
				level: 'info',
				message: 'test message',
				time: 1234567890000,
				context: {attributes: {userId: '123'}}
			}, {})
			expect(mockRedacting).toHaveBeenCalled()
			expect(mockFormatting).toHaveBeenCalledWith(
				{level: 'info', message: 'test', time: 1234567890000},
				{mode: 'json'}
			)
			expect(mockTransferring.write).toHaveBeenCalledWith('formatted line')
		})

		it('should handle errors silently', async() => {
			const mockEnriching = vi.fn().mockRejectedValue(new Error('Enriching failed'))
			const mockRedacting = vi.fn()
			const mockFormatting = vi.fn()
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const mockClock: Clock = {now: vi.fn().mockReturnValue(1234567890000)}

			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				mockClock,
				'info',
				'json'
			)

			// Should not throw
			logger.info('test message')

			// Wait for async operations to complete
			await new Promise((resolve) => setTimeout(resolve, 0))

			// Verify that enriching was called but other functions were not due to error
			expect(mockEnriching).toHaveBeenCalled()
			expect(mockRedacting).not.toHaveBeenCalled()
			expect(mockFormatting).not.toHaveBeenCalled()
			expect(mockTransferring.write).not.toHaveBeenCalled()
		})

		it('should create context-bound logger', () => {
			const mockEnriching = vi.fn()
			const mockRedacting = vi.fn()
			const mockFormatting = vi.fn()
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const mockClock: Clock = {now: vi.fn().mockReturnValue(1234567890000)}

			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				mockClock,
				'info',
				'json',
				{attributes: {service: 'test'}}
			)

			const boundLogger = logger.context({attributes: {userId: '123'}})

			expect(boundLogger).toBeDefined()
			expect(boundLogger).not.toBe(logger)
			expect(boundLogger.level).toBe('info')
		})

		it('should filter undefined values in context binding', () => {
			const mockEnriching = vi.fn()
			const mockRedacting = vi.fn()
			const mockFormatting = vi.fn()
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const mockClock: Clock = {now: vi.fn().mockReturnValue(1234567890000)}

			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				mockClock,
				'info',
				'json'
			)

			const boundLogger = logger.context({
				attributes: {
					userId: '123',
					nullValue: null
				}
			})

			expect(boundLogger).toBeDefined()
		})

		it('should merge context attributes correctly', () => {
			const mockEnriching = vi.fn()
			const mockRedacting = vi.fn()
			const mockFormatting = vi.fn()
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const mockClock: Clock = {now: vi.fn().mockReturnValue(1234567890000)}

			const baseContext: LogContext = {
				attributes: {service: 'test', version: '1.0.0'}
			}

			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				mockClock,
				'info',
				'json',
				baseContext
			)

			const boundLogger = logger.context({attributes: {version: '2.0.0', env: 'prod'}})

			expect(boundLogger).toBeDefined()
		})

		it('respects the default info threshold when an unknown level is provided', async() => {
			const mockEnriching = vi.fn().mockResolvedValue({level: 'info', message: 'test'})
			const mockRedacting = vi.fn().mockResolvedValue({level: 'info', message: 'test'})
			const mockFormatting = vi.fn().mockReturnValue('formatted line')
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				{now: vi.fn().mockReturnValue(1234567890000)},
				'not-a-level',
				undefined
			)

			logger.debug('skip me')
			logger.info('keep me')
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockEnriching).toHaveBeenCalledTimes(1)
			expect(mockTransferring.write).toHaveBeenCalledWith('formatted line')
		})

		it('reports normalized errors and preserves merged context across nested loggers', async() => {
			const errors = {report: vi.fn()}
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const mockEnriching = vi.fn()
				.mockRejectedValueOnce('plain failure')
				.mockResolvedValueOnce({level: 'info', message: 'ok', time: 1234567890000})
			const mockRedacting = vi.fn().mockResolvedValue({level: 'info', message: 'ok', time: 1234567890000})
			const mockFormatting = vi.fn().mockReturnValue('formatted line')

			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				{now: vi.fn().mockReturnValue(1234567890000)},
				'info',
				'json',
				{attributes: {service: 'api'}},
				errors as never
			)

			logger.error('will fail')
			const nested = logger
				.context({attributes: {requestId: 'req-1'}})
				.context({attributes: {userId: 'user-1'}})
			nested.info('ok')

			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(errors.report).toHaveBeenCalledWith({
				kind: 'Error',
				message: 'plain failure'
			}, {stage: 'logger-factory'})
			expect(mockEnriching).toHaveBeenLastCalledWith(expect.objectContaining({
				context: {
					attributes: {
						service: 'api',
						requestId: 'req-1',
						userId: 'user-1'
					}
				}
			}), {})
		})

		it('invokes every level helper and swallows reporter failures', async() => {
			const mockEnriching = vi.fn().mockResolvedValue({level: 'info', message: 'ok', time: 1234567890000})
			const mockRedacting = vi.fn().mockResolvedValue({level: 'info', message: 'ok', time: 1234567890000})
			const mockFormatting = vi.fn().mockReturnValue('formatted')
			const mockTransferring = {
				write: vi.fn(),
				flush: vi.fn(),
				close: vi.fn(),
				recent: {
					capacity: 10,
					size: vi.fn().mockReturnValue(0),
					toArray: vi.fn().mockReturnValue([]),
					peekOldest: vi.fn(),
					peekNewest: vi.fn()
				},
				telemetry: {
					startedAt: 1234567890000,
					inFlightBatches: 0,
					queueSize: 0,
					writtenTotal: 0,
					droppedTotal: 0,
					retriedTotal: 0
				}
			}
			const logger = createLogger(
				mockEnriching,
				mockRedacting,
				mockFormatting,
				mockTransferring,
				{now: vi.fn().mockReturnValue(1234567890000)},
				'trace',
				'json',
				undefined,
				{report: vi.fn().mockImplementation(() => {
					throw new Error('report failed')
				})} as never
			)

			logger.trace('trace')
			logger.debug('debug')
			logger.info('info')
			logger.warn('warn')
			logger.error('error')
			logger.fatal('fatal')

			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockEnriching).toHaveBeenCalledTimes(6)
			expect(mockTransferring.write).toHaveBeenCalledTimes(6)
		})
	})
})
