import {describe, expect, it, vi} from 'vitest'

import {createErrorHandler} from '../src/core/create-error-handler'
import {reportToMetrics} from '../src/features/reporters/metrics-reporter'
import {createProductionErrorHandler} from '../src/public/production'

import {createFixedClock} from './fixed-clock'

describe('managed errors contract', () => {
	it('keeps studio-wide transforms synchronous, redacted, and immutable', () => {
		const errors = createErrorHandler({clock: createFixedClock(7)})
		const normalized = errors.normalize(new Error('token=secret'))
		const classified = errors.classify(normalized)

		expect(normalized.message).toBe('token=[REDACTED]')
		expect(normalized.timestamp).toBe(7)
		expect(classified.category).toBe('UNKNOWN')
		expect(Object.isFrozen(normalized)).toBe(true)
		expect(Object.isFrozen(classified)).toBe(true)
		expect(errors).not.toHaveProperty('destroy')
	})

	it('rejects removed custom lifecycle and deduplication objects', () => {
		expect(() => createErrorHandler({reportRuntime: {}} as never)).toThrow('errors_invalid_options')
		expect(() => createErrorHandler({errorDeduplicationCache: {}} as never)).toThrow('errors_invalid_options')
	})

	it('supports production classification, observation, and source configuration', async() => {
		const capture = vi.fn(async() => {})
		const observe = vi.fn()
		const errors = await createProductionErrorHandler({
			clock: createFixedClock(1),
			defaultSource: 'worker',
			classificationRegistry: {NETWORK: ['StudioTransportError']},
			observe,
			sink: {capture}
		})

		await errors.handle(Object.assign(new Error('offline'), {name: 'StudioTransportError'}))
		expect(capture).toHaveBeenCalledWith(expect.objectContaining({
			category: 'NETWORK', source: 'worker'
		}))
		expect(observe).toHaveBeenCalledWith('error:reported', expect.any(Object))
		await errors.shutdown()
	})

	it('does not silently default malformed production extensions', async() => {
		await expect(createProductionErrorHandler({defaultSource: null} as never))
			.rejects.toThrow('errors_invalid_source')
		await expect(createProductionErrorHandler({classificationRegistry: null} as never))
			.rejects.toThrow('errors_invalid_classification_registry')
		await expect(createProductionErrorHandler({observe: null} as never))
			.rejects.toThrow('errors_invalid_observer')
	})

	it('closes admission before draining and coalesces concurrent shutdown', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const report = vi.fn(async() => await gate)
		const close = vi.fn(async() => {})
		const disposeFlush = vi.fn()
		const disposeShutdown = vi.fn()
		const errors = createErrorHandler({
			clock: createFixedClock(1),
			report,
			sink: {capture: vi.fn(async() => {}), close},
			ports: {lifecycle: {
				registerFlushHook: vi.fn(() => disposeFlush),
				registerShutdownHook: vi.fn(() => disposeShutdown)
			}}
		})

		const accepted = errors.handle(new Error('accepted'))
		await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
		const first = errors.shutdown()
		const second = errors.shutdown()
		await expect(errors.handle(new Error('late'))).rejects.toThrow('shut down')
		release()
		await Promise.all([accepted, first, second])

		expect(close).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledOnce()
		expect(disposeShutdown).toHaveBeenCalledOnce()
		await expect(errors.shutdown()).resolves.toBeUndefined()
		expect(close).toHaveBeenCalledOnce()
	})

	it('keeps admission closed and retries an unfinished sink close', async() => {
		const close = vi.fn()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(undefined)
		const errors = createErrorHandler({
			clock: createFixedClock(1),
			sink: {capture: vi.fn(async() => {}), close}
		})

		await errors.handle(new Error('accepted'))
		await expect(errors.shutdown()).rejects.toThrow('shutdown failed')
		await expect(errors.handle(new Error('late'))).rejects.toThrow('shut down')
		await expect(errors.shutdown()).resolves.toBeUndefined()
		expect(close).toHaveBeenCalledTimes(2)
	})

	it('retries only lifecycle disposers that have not completed', async() => {
		const completed = vi.fn()
		const retryable = vi.fn()
			.mockRejectedValueOnce(new Error('busy'))
			.mockResolvedValueOnce(undefined)
		const errors = createErrorHandler({
			clock: createFixedClock(1),
			ports: {lifecycle: {
				registerFlushHook: vi.fn(() => completed),
				registerShutdownHook: vi.fn(() => retryable)
			}}
		})

		await expect(errors.shutdown()).rejects.toThrow('lifecycle disposal failed')
		await expect(errors.handle(new Error('late'))).rejects.toThrow('shut down')
		await expect(errors.shutdown()).resolves.toBeUndefined()
		expect(completed).toHaveBeenCalledOnce()
		expect(retryable).toHaveBeenCalledTimes(2)
	})

	it('emits exactly one bounded metric without an error-code label', async() => {
		const increment = vi.fn(async() => {})
		await reportToMetrics({
			kind: 'Error', message: 'boom', severity: 'error', category: 'NETWORK',
			timestamp: 1, code: 'CALLER_CONTROLLED'
		}, {increment})

		expect(increment).toHaveBeenCalledExactlyOnceWith('errors_total', {
			category: 'NETWORK', severity: 'error'
		})
	})
})
