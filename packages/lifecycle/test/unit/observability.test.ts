import type {Logging} from '@ooopsstudio/core/ports/logging'
import {describe, expect, it, vi} from 'vitest'

import {createCustomLifecycle} from '../../src/public/custom'
import {attachLifecycleObservability} from '../../src/public/observability'

const options = {
	clock: {now: () => 1_000},
	shutdown: {drainGracePeriodMs: 0}
} as const

function logger(): Logging {
	return {
		level: 'info',
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
		context: vi.fn(() => logger())
	}
}

describe('lifecycle observability attachment', () => {
	it('fills missing ports atomically and disposes idempotently', async() => {
		const runtime = createCustomLifecycle(options)
		const attachedLogger = logger()
		const dispose = attachLifecycleObservability(runtime, {logger: attachedLogger})
		await runtime.start()
		expect(attachedLogger.info).toHaveBeenCalledOnce()
		dispose()
		dispose()
		await runtime.shutdown()
		expect(attachedLogger.info).toHaveBeenCalledOnce()
	})

	it('rejects conflicting replacements without partially attaching other ports', async() => {
		const firstLogger = logger()
		const secondLogger = logger()
		const metrics = {increment: vi.fn(), record: vi.fn()}
		const runtime = createCustomLifecycle({...options, observability: {logger: firstLogger}})
		expect(() => attachLifecycleObservability(runtime, {logger: secondLogger, metrics}))
			.toThrow('already attached')
		await runtime.start()
		expect(metrics.increment).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('rejects unmanaged runtimes and accessor-backed attachment objects', () => {
		expect(() => attachLifecycleObservability({}, {})).toThrow('managed lifecycle')
		const runtime = createCustomLifecycle(options)
		const getter = vi.fn(() => ({info: vi.fn()}))
		const hostile = Object.defineProperty({}, 'logger', {enumerable: true, get: getter})
		expect(() => attachLifecycleObservability(runtime, hostile)).toThrow('stable data fields')
		expect(getter).not.toHaveBeenCalled()
	})
})
