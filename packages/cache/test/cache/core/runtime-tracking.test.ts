import {describe, expect, it, vi} from 'vitest'

import {MAX_ACTIVE_CACHE_OPERATIONS} from '../../../src/cache/core/runtime-safety'
import {createCacheRuntimeTracker} from '../../../src/cache/core/runtime-tracking'

describe('cache runtime tracking', () => {
	it('drains accepted operations and rejects new operations during shutdown', async() => {
		const tracker = createCacheRuntimeTracker(vi.fn())
		let release!: () => void
		const active = tracker.run(() => new Promise<void>((resolve) => { release = resolve }))
		const drain = tracker.beginShutdown()
		await expect(tracker.run(async() => undefined)).rejects.toThrow('shutting down')
		release()
		await active
		await drain
		tracker.close()
		await expect(tracker.run(async() => undefined)).rejects.toThrow('shut down')
	})

	it('shares flights and reports tracker overflow once per pressure period', async() => {
		const onOverflow = vi.fn()
		const tracker = createCacheRuntimeTracker(onOverflow)
		let releaseShared!: (value: string) => void
		const shared = tracker.singleFlight('shared', () => new Promise<string>((resolve) => { releaseShared = resolve }))
		const joined = tracker.singleFlight('shared', async() => 'wrong')
		releaseShared('value')
		await expect(Promise.all([shared, joined])).resolves.toEqual(['value', 'value'])

		for (let index = 0; index < 1_000; index++) {
			void tracker.singleFlight(`held-${index}`, () => new Promise<void>(() => undefined))
		}
		await expect(tracker.singleFlight('overflow-1', async() => undefined)).rejects.toThrow('CACHE_LOAD_CAPACITY')
		await expect(tracker.singleFlight('overflow-2', async() => undefined)).rejects.toThrow('CACHE_LOAD_CAPACITY')
		expect(onOverflow).toHaveBeenCalledOnce()
	})

	it('rejects excess active operations before executing their actions', async() => {
		const tracker = createCacheRuntimeTracker(vi.fn())
		for (let index = 0; index < MAX_ACTIVE_CACHE_OPERATIONS; index++) {
			void tracker.run(() => new Promise<void>(() => undefined))
		}
		const rejectedAction = vi.fn(async() => undefined)
		await expect(tracker.run(rejectedAction)).rejects.toThrow('active operation capacity exceeded')
		expect(rejectedAction).not.toHaveBeenCalled()
	})
})
