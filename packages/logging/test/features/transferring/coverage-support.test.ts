import {describe, expect, it, vi} from 'vitest'

import {createBatchingTelemetry} from '../../../src/features/transferring/batching-telemetry'
import {consoleSink} from '../../../src/features/transferring/console'
import {createDeliveryState} from '../../../src/features/transferring/delivery-state'
import {sendWithRetry} from '../../../src/features/transferring/retry'

describe('transfer coverage support', () => {
	it('counts every record in aggregate batching drops', () => {
		const onMark = vi.fn()
		const metrics = {increment: vi.fn()}
		const telemetry = createBatchingTelemetry({
			onMark,
			selfMetrics: true,
			metrics: metrics as never,
			rememberTerminalFailure: vi.fn(),
			handleDeliveryFailure: vi.fn()
		})

		telemetry.onDropped(3, 'retry-exhausted')
		expect(onMark).toHaveBeenCalledTimes(3)
		expect(metrics.increment).toHaveBeenCalledTimes(3)

		telemetry.onMark('drop', {reason: 'signal-aborted'}, 3)
		telemetry.onDropped(3, 'signal-aborted')
		expect(onMark).toHaveBeenCalledTimes(6)
		expect(metrics.increment).toHaveBeenCalledTimes(6)
	})

	it('writes mixed batches to stdout and stderr', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		consoleSink().writeBatch?.(['{"level":"info","message":"one"}', '{"level":"error","message":"two"}'])
		expect(stdout).toHaveBeenCalledWith('{"level":"info","message":"one"}\n')
		expect(stderr).toHaveBeenCalledWith('{"level":"error","message":"two"}\n')
	})

	it('tracks late ambiguous delivery and exposes its pending state', async() => {
		const state = createDeliveryState()
		let reject!: (error: Error) => void
		const late = new Promise<void>((_resolve, rejectFn) => { reject = rejectFn })
		state.trackAmbiguous(late, Object.assign(new Error('timeout'), {ambiguousDelivery: true}))
		expect(state.hasAmbiguous).toBe(true)
		const errors: unknown[] = []
		let collected = false
		const collection = state.collect(errors).finally(() => { collected = true })
		await Promise.resolve()
		expect(collected).toBe(false)
		reject(new Error('late failure'))
		await collection
		expect(state.hasAmbiguous).toBe(false)
		expect(errors).toEqual([expect.objectContaining({message: 'late failure'})])
	})

	it('collects every independent direct delivery failure', async() => {
		const state = createDeliveryState()
		void state.track(Promise.reject(new Error('first')))
		void state.track(Promise.reject(new Error('second')))
		const errors: unknown[] = []
		await state.collect(errors)
		expect(errors).toEqual([
			expect.objectContaining({message: 'first'}),
			expect.objectContaining({message: 'second'})
		])
	})

	it('aborts an active retry attempt through the caller signal', async() => {
		const controller = new AbortController()
		const sink = {
			write: vi.fn((_line: string, options?: {signal?: AbortSignal}) => new Promise<void>((_resolve, reject) => {
				options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once: true})
			}))
		}
		const operation = sendWithRetry(['line'], sink, {
			maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000
		}, {now: () => 1}, vi.fn(), vi.fn(), undefined, undefined, controller.signal)
		controller.abort(new Error('caller aborted'))
		await expect(operation).resolves.toBeUndefined()
	})
})
