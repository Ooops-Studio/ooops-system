import {TOK, createContainer} from '@ooopsstudio/core'
import {describe, expect, it, vi} from 'vitest'

import {registerErrors} from '../src'
import {createDevelopmentErrorHandler} from '../src/public/development'
import {createProductionErrorHandler} from '../src/public/production'

import {createFixedClock} from './fixed-clock'

describe('simplified errors service', () => {
	it('development reports a redacted error and rethrows it', async() => {
		const logger = {error: vi.fn()} as never
		const errors = await createDevelopmentErrorHandler({
			ports: {logger},
			clock: createFixedClock(1)
		})

		await expect(errors.handle(new Error('token=secret-value'))).rejects.toMatchObject({
			message: 'token=[REDACTED]'
		})
		expect((logger as {error: ReturnType<typeof vi.fn>}).error).toHaveBeenCalledWith(
			'token=[REDACTED]',
			expect.any(Object)
		)
	})

	it('production deduplicates reports and sends only redacted payloads to its sink', async() => {
		const capture = vi.fn(async() => {})
		const errors = await createProductionErrorHandler({
			clock: createFixedClock(1),
			sink: {capture}
		})

		await errors.handle(new Error('Bearer super-secret-value'))
		await errors.handle(new Error('Bearer super-secret-value'))

		expect(capture).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledWith(expect.objectContaining({
			message: 'Bearer [REDACTED]'
		}))
	})

	it('does not deduplicate distinct messages with a known 32-bit hash collision', async() => {
		const capture = vi.fn(async() => {})
		const errors = await createProductionErrorHandler({
			clock: createFixedClock(1), sink: {capture}
		})

		await errors.handle(new Error('Aa'))
		await errors.handle(new Error('BB'))

		expect(capture).toHaveBeenCalledTimes(2)
		await errors.shutdown()
	})

	it('preserves the canonical NormalizedError kind and code through TOK.Errors', async() => {
		const capture = vi.fn(async() => {})
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(1))
		await registerErrors(container, {
			preset: 'production', options: {sink: {capture}}
		})
		const errors = container.get(TOK.Errors)
		errors.report({kind: 'EventsError', message: 'dispatch failed', code: 'EVENT_DISPATCH_FAILED'})
		await errors.flush?.()

		expect(capture).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'EventsError', code: 'EVENT_DISPATCH_FAILED'
		}))
		await errors.shutdown?.()
	})

	it('keeps built-in reporting alive when the external sink fails and flushes/closes it', async() => {
		const logger = {error: vi.fn()} as never
		const flush = vi.fn(async() => {})
		const close = vi.fn(async() => {})
		const errors = await createProductionErrorHandler({
			clock: createFixedClock(1),
			ports: {logger},
			sink: {capture: vi.fn(async() => { throw new Error('offline') }), flush, close}
		})

		await expect(errors.handle(new Error('boom'))).resolves.toMatchObject({message: 'boom'})
		expect((logger as {error: ReturnType<typeof vi.fn>}).error).toHaveBeenCalled()
		await errors.flush()
		await errors.shutdown()
		expect(flush).toHaveBeenCalled()
		expect(close).toHaveBeenCalledTimes(1)
	})
})
