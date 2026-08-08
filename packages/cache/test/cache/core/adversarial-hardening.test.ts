import {describe, expect, it, vi} from 'vitest'

import {createCacheHandler} from '../../../src/cache/core/handler'
import {createMemoryCacheBackend} from '../../../src/cache/features/backends/memory'

describe('cache public-boundary hardening', () => {
	it('does not execute accessor-backed configuration or backend capabilities', () => {
		const clock = {now: () => 0}
		let getterCalls = 0
		const options = Object.defineProperty({}, 'backend', {
			enumerable: true,
			get() { getterCalls++; return createMemoryCacheBackend({clock}) }
		})
		expect(() => createCacheHandler(options as never)).toThrow()
		expect(getterCalls).toBe(0)
	})

	it('rejects hostile operation objects without invoking accessors', async() => {
		const clock = {now: () => 0}
		const cache = createCacheHandler({clock, backend: createMemoryCacheBackend({clock})})
		const getter = vi.fn(() => 'secret')
		const options = Object.defineProperty({}, 'namespace', {enumerable: true, get: getter})
		await expect(cache.get('key', options as never)).rejects.toThrow()
		expect(getter).not.toHaveBeenCalled()
	})
})
