import {describe, expect, it, vi} from 'vitest'

import {getLogger, isSafeLogger, noopLogger} from '../../src/utils/logger'

describe('metrics logger utilities', () => {
	it('provides a safe no-op logger by default', () => {
		expect(getLogger()).toBe(noopLogger)
		expect(() => {
			noopLogger.trace('test')
			noopLogger.debug('test')
			noopLogger.info('test')
			noopLogger.warn('test')
			noopLogger.error('test')
			noopLogger.fatal('test')
		}).not.toThrow()
		expect(noopLogger.context({scope: 'metrics'})).toBe(noopLogger)
	})

	it('accepts normal loggers and rejects recursive metrics loggers', () => {
		const logger = {
			level: 'info' as const,
			trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
			error: vi.fn(), fatal: vi.fn(), context: vi.fn()
		}
		expect(isSafeLogger(logger)).toBe(true)
		expect(isSafeLogger({...logger, __isMetricsLogger: true})).toBe(false)
	})

	it('captures methods without executing accessors and isolates logger failures', () => {
		const getter = vi.fn(() => vi.fn())
		const hostile = Object.defineProperty({
			level: 'info', trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
			warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), context: vi.fn()
		}, 'warn', {enumerable: true, get: getter})
		expect(isSafeLogger(hostile as never)).toBe(false)
		expect(getter).not.toHaveBeenCalled()

		const originalWarn = vi.fn(() => { throw new Error('diagnostic failure') })
		const logger = {
			level: 'info' as const,
			trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: originalWarn,
			error: vi.fn(), fatal: vi.fn(), context: vi.fn(() => logger)
		}
		const stable = getLogger(logger)
		logger.warn = vi.fn(() => { throw new Error('mutated logger') })
		expect(() => stable.warn('event')).not.toThrow()
		expect(originalWarn).toHaveBeenCalledOnce()
	})

	it('accepts a dynamic level without invoking its getter', () => {
		const level = vi.fn(() => 'info')
		const logger = Object.defineProperty({
			trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
			error: vi.fn(), fatal: vi.fn(), context: vi.fn()
		}, 'level', {enumerable: true, get: level})

		expect(isSafeLogger(logger as never)).toBe(true)
		expect(getLogger(logger as never).level).toBe('trace')
		expect(level).not.toHaveBeenCalled()
	})
})
