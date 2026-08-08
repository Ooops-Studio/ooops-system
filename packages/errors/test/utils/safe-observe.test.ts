import {describe, expect, it, vi} from 'vitest'

import {createSafeObserve} from '../../src/utils/safe-observe'

describe('createSafeObserve', () => {
	it('uses a noop when absent and forwards events when present', () => {
		expect(() => createSafeObserve()('event' as never, {})).not.toThrow()
		const observe = vi.fn()
		createSafeObserve(observe as never)('event' as never, {id: '1'})
		expect(observe).toHaveBeenCalledWith('event', {id: '1'})
	})

	it('does not throw when the observer throws synchronously', () => {
		const safeObserve = createSafeObserve(() => { throw new Error('observer') })
		expect(() => safeObserve('event' as never, {})).not.toThrow()
	})

	it('consumes asynchronous observer rejections', async() => {
		const unhandled = vi.fn()
		process.on('unhandledRejection', unhandled)
		try {
			createSafeObserve(async() => { throw new Error('observer') })('event' as never, {})
			await new Promise((resolve) => setImmediate(resolve))
			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off('unhandledRejection', unhandled)
		}
	})

	it('suppresses synchronous observer re-entry without disabling later events', () => {
		let safeObserve!: ReturnType<typeof createSafeObserve>
		const observe = vi.fn(() => safeObserve('nested' as never, {nested: true}))
		safeObserve = createSafeObserve(observe as never)

		safeObserve('first' as never, {id: 1})
		safeObserve('second' as never, {id: 2})

		expect(observe).toHaveBeenCalledTimes(2)
		expect(observe).toHaveBeenNthCalledWith(1, 'first', {id: 1})
		expect(observe).toHaveBeenNthCalledWith(2, 'second', {id: 2})
	})

	it('retains the re-entry guard until an asynchronous observer settles', async() => {
		let safeObserve!: ReturnType<typeof createSafeObserve>
		const observe = vi.fn(async() => {
			await Promise.resolve()
			safeObserve('nested' as never, {nested: true})
		})
		safeObserve = createSafeObserve(observe as never)

		safeObserve('first' as never, {})
		await new Promise((resolve) => setImmediate(resolve))
		expect(observe).toHaveBeenCalledOnce()

		safeObserve('later' as never, {})
		await new Promise((resolve) => setImmediate(resolve))
		expect(observe).toHaveBeenCalledTimes(2)
	})
})
