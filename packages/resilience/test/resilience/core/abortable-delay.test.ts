import {afterEach, describe, expect, it, vi} from 'vitest'

import {waitForAbortableDelay} from '../../../src/resilience/core/abortable-delay'

describe('abortable retry delay', () => {
	afterEach(() => vi.useRealTimers())

	it('rejects delays that Node would coerce to a near-immediate timer', async() => {
		await expect(waitForAbortableDelay(Number.POSITIVE_INFINITY)).rejects.toThrow(/2147483647/)
		await expect(waitForAbortableDelay(2_147_483_648)).rejects.toThrow(/2147483647/)
	})

	it('resolves after its delay and rejects on cancellation', async() => {
		vi.useFakeTimers()
		const completed = waitForAbortableDelay(5)
		await vi.advanceTimersByTimeAsync(5)
		await expect(completed).resolves.toBeUndefined()

		const controller = new AbortController()
		const cancelled = waitForAbortableDelay(10, controller.signal)
		controller.abort()
		await expect(cancelled).rejects.toMatchObject({name: 'AbortError'})
		await expect(waitForAbortableDelay(0)).resolves.toBeUndefined()
		await expect(waitForAbortableDelay(1, controller.signal)).rejects.toMatchObject({name: 'AbortError'})
	})

	it('clears its timer when cancellation listener installation fails', async() => {
		vi.useFakeTimers()
		const signal = {
			aborted: false,
			addEventListener: () => { throw new Error('listener install failed') },
			removeEventListener: () => { throw new Error('listener cleanup failed') }
		} as unknown as AbortSignal
		await expect(waitForAbortableDelay(10, signal)).rejects.toThrow('listener install failed')
		expect(vi.getTimerCount()).toBe(0)
	})

	it('does not retain an abort listener when a scheduler settles synchronously', async() => {
		const addEventListener = vi.fn()
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0]) => {
			Reflect.apply(callback as (...arguments_: unknown[]) => unknown, undefined, [])
			return 0 as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout)
		const signal = {aborted: false, addEventListener, removeEventListener: vi.fn()} as unknown as AbortSignal

		await expect(waitForAbortableDelay(10, signal)).resolves.toBeUndefined()
		expect(addEventListener).not.toHaveBeenCalled()
		timer.mockRestore()
	})
})
